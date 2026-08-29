import { fileURLToPath } from 'node:url';
import {
  coreConfig, configuredFeatures, firebaseConfig, geminiConfig, hostingConfig,
} from './config/env';
import { createLogger } from './config/logger';
import { buildServer } from './api/server';
import { FirebaseTokenVerifier, type TokenVerifier } from './api/middleware/auth';
import { changeStreamsAvailable, connect, disconnect, redactUri } from './core/db/client';
import { ensureIndexes } from './core/db/indexes';
import { Repositories } from './core/repositories';
import { ApprovalService } from './core/services/approval';
import { AssessmentService } from './core/services/assessment';
import { GraphService } from './core/services/graph';
import { ProjectService } from './core/services/projects';
import { GcpSecretVault } from './integrations/secrets/vault';
import { GcsBlobStore } from './integrations/storage/blobs';
import {
  assertRuntimeAvailable, buildExecutorFor, sandboxDeployerFor,
} from './integrations/gcp/factory';
import { LocalDockerDeployer } from './integrations/cloudrun/sandbox';
import { SandboxCapacityService } from './core/services/sandboxCapacity';
import { SandboxLifecycleService, sweepSandboxes } from './core/services/sandboxLifecycle';
import { GitHubReader } from './integrations/github/client';
import { gcpConfig } from './config/env';
import { GeminiClient } from './agent/model';
import { RuleEngine } from './core/rules/engine';
import { loadRegistry } from './core/discovery/providers';
import { runDiscovery } from './worker/discoveryJob';
import { runAssessment } from './worker/assessmentJob';
import { runTestEngineering } from './worker/migrationJob';
import { runReport } from './worker/reportJob';

/**
 * Engine assets ship with the repository, not the bundle.
 *
 * `ENGINE_DIR` overrides the location for a container image that lays them out
 * differently; the default resolves from this file so a local run needs no
 * configuration at all.
 */
const engineDir = process.env.ENGINE_DIR
  ?? fileURLToPath(new URL('../../../engine', import.meta.url));

/**
 * Process entry point.
 *
 * Connects, creates indexes, reports what is configured, and serves. The banner
 * matters: a partly-configured environment is common during a build and should be
 * visible at startup rather than discovered by whichever request first needs the
 * missing setting.
 */
async function main(): Promise<void> {
  const core = coreConfig();
  const log = createLogger(core.LOG_LEVEL, core.NODE_ENV === 'development');

  const { db } = await connect(core.MONGODB_URI, core.MONGODB_DB);
  const indexes = await ensureIndexes(db);
  const repos = new Repositories(db);

  const features = configuredFeatures();
  log.info(
    {
      mongo: redactUri(core.MONGODB_URI),
      database: core.MONGODB_DB,
      indexes: `${indexes.created} across ${indexes.collections} collections`,
      changeStreams: changeStreamsAvailable(),
      features,
      build: `${process.env.BUILD_EXECUTOR ?? 'LOCAL'}`,
      sandbox: `${process.env.SANDBOX_PLACEMENT ?? 'LOCAL'}`,
    },
    'proteus starting',
  );

  if (!changeStreamsAvailable()) {
    // Not fatal — the API still serves — but the live screens will silently stop
    // updating, which is worse than an error nobody sees.
    log.error(
      'change streams unavailable: MongoDB is not a replica set. Live discovery and ' +
        'migration screens will not update. See docs/pqc_migration_deployment_v1.md §3.',
    );
  }

  let verifier: TokenVerifier;
  try {
    verifier = new FirebaseTokenVerifier(firebaseConfig().FIREBASE_PROJECT_ID);
  } catch (e) {
    log.error((e as Error).message);
    throw e;
  }

  const gcp = gcpConfig();
  const blobs = new GcsBlobStore(gcp.GCS_BUCKET);
  const projects = new ProjectService(repos, new GcpSecretVault(gcp.GCP_PROJECT_ID), blobs);

  const graph = new GraphService(repos);

  // Rules and the provider registry are read once at startup: a ruleset that
  // fails to parse should stop the process, not the first discovery run.
  const engine = RuleEngine.fromFiles(
    `${engineDir}/rulesets/pqc-migration-rules.yaml`,
    `${engineDir}/rulesets/migration-execution-rules.yaml`,
  );
  loadRegistry(`${engineDir}/data/provider-capability.json`);
  log.info({ engineDir, rules: engine.counts }, 'rulesets loaded');

  const model = new GeminiClient(geminiConfig().GEMINI_MODEL, geminiConfig().GEMINI_API_KEY);
  const assessments = new AssessmentService(repos);
  const approvals = new ApprovalService(repos);

  const assess = async (projectId: string): Promise<void> => {
    const project = await repos.projects.byId(projectId);
    if (project) {
      await runAssessment(project, { repos, engine, model, blobs, approvals, logger: log });
    }
  };

  // The toolchain the repository under migration is built in. Configuring an
  // image runs the build inside it, which is how a Java 17 Maven build succeeds
  // on a host that has neither.
  // Where the build runs and where the sandbox lives, from configuration. A
  // Cloud Run container cannot start another container, so a hosted Proteus must
  // use the GCP implementations for both — checked at boot rather than
  // discovered at the first `mvn` invocation, forty minutes into a demo.
  const hosting = hostingConfig();
  const settings = {
    buildExecutor: hosting.BUILD_EXECUTOR,
    buildImage: hosting.BUILD_IMAGE,
    ...(hosting.CLOUD_BUILD_CACHE_URI
      ? { cloudBuildCacheUri: hosting.CLOUD_BUILD_CACHE_URI }
      : {}),
    sandboxPlacement: hosting.SANDBOX_PLACEMENT,
    sandboxMaxInstances: hosting.SANDBOX_MAX_INSTANCES,
    sandboxCpu: hosting.SANDBOX_CPU,
    sandboxMemory: hosting.SANDBOX_MEMORY,
    sandboxRequestTimeoutSeconds: hosting.SANDBOX_REQUEST_TIMEOUT_SECONDS,
  };
  const gcpSettings = () => ({
    projectId: gcp.GCP_PROJECT_ID,
    region: gcp.GCP_REGION,
    bucket: gcp.GCS_BUCKET,
    artifactRegistryRepo: gcp.ARTIFACT_REGISTRY_REPO,
    ...(gcp.CLOUD_BUILD_SERVICE_ACCOUNT
      ? { serviceAccount: gcp.CLOUD_BUILD_SERVICE_ACCOUNT }
      : {}),
  });

  const runtime = await assertRuntimeAvailable(settings);
  if (!runtime.ok) log.error(runtime.reason);

  const executor = buildExecutorFor(settings, gcpSettings);
  const deployer = sandboxDeployerFor(settings, gcpSettings);

  // The caps bound what is RETAINED, never what is deployed (D-020): past a cap
  // the sandbox is still built and exercised, then released, so the verdict is
  // never degraded by how busy the platform is.
  const capacity = new SandboxCapacityService(repos, {
    perUser: hosting.SANDBOX_MAX_PER_USER,
    total: hosting.SANDBOX_MAX_TOTAL,
  });
  const lifecycle = new SandboxLifecycleService(repos, {
    ttlDays: hosting.SANDBOX_TTL_DAYS,
    hardTtlDays: hosting.SANDBOX_HARD_TTL_DAYS,
  });
  // A LOCAL deployment recorded by another process has nothing here that can
  // reclaim it, so the sweep marks it rather than retrying forever.
  const deployerFor = (d: { placement?: string }) =>
    d.placement === 'CLOUD_RUN' ? deployer : new LocalDockerDeployer();

  const github = new GitHubReader();

  const app = await buildServer({
    repos, projects, graph, assessments, approvals, blobs, verifier, logger: log,
    // Deliberately not awaited, for the same reason discovery is not: the
    // migration outlives the request that approved it.
    startMigration: (projectId, migrationRunId) => {
      void (async () => {
        const project = await repos.projects.byId(projectId);
        const run = await repos.migrationRuns.findOne({ migrationRunId } as never);
        if (!project || !run) return;
        await runTestEngineering(project, run, {
          repos, projects, engine, model, executor, deployer, blobs, github, logger: log,
          capacity, lifecycle,
          // The report's narrative is one call over verified state. Same client;
          // named separately because it is a flow, not an agent.
          reportModel: model,
        });
      })().catch((e) => log.error({ err: e, projectId }, 'migration job crashed'));
    },
    regenerateAssessment: assess,
    capacity, lifecycle, deployerFor,
    sandboxSweep: () => sweepSandboxes(repos, lifecycle, deployerFor),
    generateReport: async (projectId) => {
      const project = await repos.projects.byId(projectId);
      const run = project?.current.migrationRunId
        ? await repos.migrationRuns.findOne({
            migrationRunId: project.current.migrationRunId,
          } as never)
        : null;
      if (project && run) {
        await runReport(project, run, { repos, blobs, logger: log, model });
      }
    },
    // Deliberately not awaited: discovery outlives the request that starts it,
    // and the client watches it over SSE rather than waiting on a response.
    startDiscovery: (project) => {
      void runDiscovery(project, {
        repos, projects, engine, model, logger: log,
        onComplete: (p) => assess(p.projectId),
      }).catch((e) => log.error({ err: e, projectId: project.projectId }, 'discovery job crashed'));
    },
  });
  await app.listen({ port: core.PORT, host: '0.0.0.0' });
  log.info(`listening on :${core.PORT}`);

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      log.info(`${signal} — draining`);
      void app
        .close()
        .then(disconnect)
        .then(() => process.exit(0));
    });
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
