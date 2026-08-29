import { fileURLToPath } from 'node:url';
import { coreConfig, configuredFeatures, firebaseConfig, geminiConfig } from './config/env';
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
import { ProcessExecutor } from './integrations/cloudbuild/executor';
import { LocalDockerDeployer } from './integrations/cloudrun/sandbox';
import { GitHubReader } from './integrations/github/client';
import { gcpConfig } from './config/env';
import { GeminiClient } from './agent/model';
import { RuleEngine } from './core/rules/engine';
import { loadRegistry } from './core/discovery/providers';
import { runDiscovery } from './worker/discoveryJob';
import { runAssessment } from './worker/assessmentJob';
import { runTestEngineering } from './worker/migrationJob';

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
  const executor = new ProcessExecutor(process.env.BUILD_IMAGE);
  // Cloud Run is spec §36's target; the local Docker deployer builds the
  // repository's own Dockerfile and starts the same image, so a startup failure
  // caused by the migration surfaces the same way. Both satisfy one interface.
  const deployer = new LocalDockerDeployer();
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
        });
      })().catch((e) => log.error({ err: e, projectId }, 'migration job crashed'));
    },
    regenerateAssessment: assess,
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
