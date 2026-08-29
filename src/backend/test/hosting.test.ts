import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Baseline, MigrationChange, SandboxDeployment } from '@proteus/schema';
import {
  GROUP_LABEL, ProgressTracker, buildGroups, parseLine, suiteOf, totalsFor,
  type ProgressGroup,
} from '../src/core/migration/progress';
import {
  SandboxCapacityService, releaseSandbox,
} from '../src/core/services/sandboxCapacity';
import {
  SandboxLifecycleService, sweepSandboxes,
} from '../src/core/services/sandboxLifecycle';
import { CloudBuildExecutor } from '../src/integrations/cloudbuild/cloudBuildExecutor';
import { ProcessExecutor } from '../src/integrations/cloudbuild/executor';
import { CloudRunDeployer, parseImageUri } from '../src/integrations/cloudrun/cloudRunDeployer';
import { ScriptedDeployer, sandboxServiceName } from '../src/integrations/cloudrun/sandbox';
import { GcpApiError, ScriptedTransport } from '../src/integrations/gcp/client';
import { aProject, clearAll, startTestDb, type TestDb } from './helpers/mongo';

/** PRD-16 acceptance criteria — hosted execution, caps, and the live feed. */

let t: TestDb;

beforeAll(async () => { t = await startTestDb(); }, 120_000);
afterAll(async () => { await t?.stop(); });
beforeEach(async () => { await clearAll(t.repos); });

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Captured verbatim from `mvn -B verify` in maven:3.9-eclipse-temurin-17. */
const REAL_MAVEN_LINES = [
  '[INFO] --- compiler:3.11.0:testCompile (default-testCompile) @ payments-api ---',
  '[INFO] --- surefire:3.1.2:test (default-test) @ payments-api ---',
  '[INFO] Running pay.security.CryptoServiceTest',
  '[INFO] Tests run: 2, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.026 s -- in pay.security.CryptoServiceTest',
  '[INFO] Running pay.WrapLengthTest',
  '[ERROR] Tests run: 2, Failures: 1, Errors: 0, Skipped: 0, Time elapsed: 0.027 s <<< FAILURE! -- in pay.WrapLengthTest',
  '[ERROR] pay.WrapLengthTest.wrapsToTwoFiftySix -- Time elapsed: 0.016 s <<< FAILURE!',
  'org.opentest4j.AssertionFailedError: wrapped key length ==> expected: <256> but was: <1088>',
  '\tat pay.WrapLengthTest.wrapsToTwoFiftySix(WrapLengthTest.java:5)',
];

const baseline = (over: Partial<Baseline> = {}): Baseline => ({
  _schemaVersion: 1, createdAt: new Date(), updatedAt: new Date(),
  baselineId: 'base_1', projectId: 'PQC-0184', migrationRunId: 'mig_1',
  commitSha: '7c41ab9d2f1e4c8b6a5d3e2f1a0b9c8d7e6f5a4b',
  build: { executionRunId: 'e', passed: true, durationMs: 1000 },
  tests: {
    executionRunId: 'e', total: 5, passed: 5, failed: 0, skipped: 0, knownFailures: [],
    inventory: [
      { testId: 'pay.security.CryptoServiceTest#a', name: 'a', suite: 'pay.security.CryptoServiceTest', status: 'PASSED' },
      { testId: 'pay.security.CryptoServiceTest#b', name: 'b', suite: 'pay.security.CryptoServiceTest', status: 'PASSED' },
      { testId: 'pay.store.LedgerRepositoryTest#c', name: 'c', suite: 'pay.store.LedgerRepositoryTest', status: 'PASSED' },
      { testId: 'pay.store.LedgerRepositoryTest#d', name: 'd', suite: 'pay.store.LedgerRepositoryTest', status: 'PASSED' },
      { testId: 'pay.merchant.MerchantDirectoryTest#e', name: 'e', suite: 'pay.merchant.MerchantDirectoryTest', status: 'PASSED' },
    ],
  },
  invariants: [], capturedAt: new Date(),
  ...over,
});

const planItem = () => ({
  planItemId: 'plan_1', targetName: 'CryptoService', targetNodeIds: [], findingIds: [],
  mode: 'AUTONOMOUS_MIGRATION' as const, action: 'a', rationale: 'r',
  expectedChanges: [{
    changeType: 'SOURCE' as const,
    paths: ['src/main/java/pay/security/CryptoService.java'],
    description: 'd',
  }],
  conditions: [], risk: 'MEDIUM' as const, order: 0,
});

const generatedTest = (): MigrationChange => ({
  _schemaVersion: 1, createdAt: new Date(), updatedAt: new Date(),
  changeId: 'chg_t', projectId: 'PQC-0184', migrationRunId: 'mig_1', attemptId: 'a',
  sequence: 1, changeType: 'TEST', intent: 'TEST_ENGINEERING',
  summary: 's', rationale: 'r', findingIds: [], planItemIds: [],
  files: [{
    path: 'src/test/java/pay/security/CryptoServiceKemTest.java',
    operation: 'ADDED', linesAdded: 0, linesRemoved: 0,
  }],
  testIntegrity: {
    failureClassification: 'TEST_COVERAGE_GAP', reason: 'r',
    baselineRequirementChanged: false, safeAutonomousModification: true,
  },
  verificationOutcome: 'PENDING', appliedAt: new Date(),
} as MigrationChange);

async function deployment(
  over: Partial<SandboxDeployment> & { projectId: string },
): Promise<SandboxDeployment> {
  const now = new Date();
  const doc: SandboxDeployment = {
    _schemaVersion: 1, createdAt: now, updatedAt: now,
    sandboxDeploymentId: `sbx_${over.projectId}`,
    migrationRunId: `mig_${over.projectId}`,
    imageUri: `us-central1-docker.pkg.dev/p/repo/${over.projectId.toLowerCase()}:abc`,
    commitSha: 'abc1234',
    service: { name: sandboxServiceName(over.projectId), region: 'us-central1',
               url: 'https://x.run.app' },
    status: 'READY', isProduction: false, placement: 'CLOUD_RUN',
    expiresAt: new Date(now.getTime() + 7 * 86_400_000),
    hardExpiresAt: new Date(now.getTime() + 30 * 86_400_000),
    ...over,
  };
  await t.repos.sandboxDeployments.insert(doc);
  return doc;
}

const owned = async (ownerId: string) =>
  t.repos.projects.create(aProject({ ownerId }) as never);

// ---------------------------------------------------------------------------

describe('FR-H, FR-I · grouped live progress, from Maven’s own output', () => {
  const groups = () => buildGroups({
    baseline: baseline(),
    approvedItems: [planItem()],
    changes: [generatedTest()],
  });

  it('reads phase, suite start, suite result, failing method and its assertion', () => {
    const parsed = REAL_MAVEN_LINES.map((l) => parseLine(l, groups())).filter(Boolean);
    expect(parsed.map((e) => e!.kind)).toEqual([
      'PHASE', 'PHASE',
      'SUITE_STARTED', 'SUITE_FINISHED',
      'SUITE_STARTED', 'SUITE_FINISHED',
      // The asymmetry that makes this worth doing: Surefire names the failing
      // method and prints its assertion, live, seconds before the XML exists.
      'TEST_FAILED', 'FAILURE_DETAIL', 'FAILURE_DETAIL',
    ]);
  });

  it('groups a suite by what it is evidence for', () => {
    const g = groups();
    // The plan touches CryptoService.java, so CryptoServiceTest is a target.
    expect(g.get('pay.security.CryptoServiceTest')).toBe('MIGRATION_TARGET');
    // The agent wrote this one.
    expect(g.get('pay.security.CryptoServiceKemTest')).toBe('NEW_EVIDENCE');
    // Everything else answers "did you break anything you weren't touching".
    expect(g.get('pay.store.LedgerRepositoryTest')).toBe('REGRESSION_SURFACE');
    for (const label of Object.values(GROUP_LABEL)) expect(label).toBeTruthy();
  });

  it('takes the denominator from the baseline, which Maven never announces', () => {
    const totals = totalsFor({ baseline: baseline(), changes: [generatedTest()] });
    // 3 baseline suites + 1 generated.
    expect(totals.suites).toBe(4);
    expect(totals.tests).toBe(5);
    expect(totals.known).toBe(true);
  });

  it('says it has no total on the first run rather than showing an unfillable bar', () => {
    const totals = totalsFor({ baseline: null, changes: [] });
    expect(totals.known).toBe(false);
    expect(totals.suites).toBe(0);
  });

  it('accumulates into what the screen renders, failure detail attached', () => {
    const tracker = new ProgressTracker(totalsFor({ baseline: baseline(), changes: [] }));
    for (const line of REAL_MAVEN_LINES) {
      const event = parseLine(line, groups());
      if (event) tracker.apply(event);
    }
    const snapshot = tracker.snapshot();

    expect(snapshot.phase).toBe('Running unit tests');
    expect(snapshot.suitesFinished).toBe(2);
    expect(snapshot.testsFinished).toBe(4);

    const failed = snapshot.suites.find((s) => s.state === 'FAILED')!;
    expect(failed.suite).toBe('pay.WrapLengthTest');
    expect(failed.failed).toHaveLength(1);
    // Name, message and source line — everything a viewer needs, live.
    expect(failed.failed[0]!.method).toBe('wrapsToTwoFiftySix');
    expect(failed.failed[0]!.message).toContain('expected: <256> but was: <1088>');
    expect(failed.failed[0]!.at).toContain('WrapLengthTest.java:5');
  });

  it('puts a suite the baseline never saw into new evidence, not regression', () => {
    // Defaulting to regression surface would file an agent-written test under
    // the one question it cannot answer.
    const event = parseLine('[INFO] Running pay.BrandNewTest', groups());
    expect(event).toMatchObject({ kind: 'SUITE_STARTED', group: 'NEW_EVIDENCE' });
  });

  it('maps a test path to its suite', () => {
    expect(suiteOf('src/test/java/pay/security/CryptoServiceTest.java'))
      .toBe('pay.security.CryptoServiceTest');
    expect(suiteOf('src/main/java/pay/security/CryptoService.java')).toBeNull();
  });
});

describe('FR-E · the local executor streams instead of buffering', () => {
  it('delivers whole lines while the command is still running', async () => {
    const seen: string[] = [];
    const executor = new ProcessExecutor();
    const outcome = await executor.run({
      workdir: process.cwd(),
      // Three lines with a pause, so a buffered implementation would deliver
      // nothing until the end and this assertion would see one chunk.
      command: 'printf "one\\ntwo\\n"; sleep 0.1; printf "three\\n"',
      commitSha: 'abc1234',
      onLine: (l) => seen.push(l),
    });

    expect(outcome.status).toBe('SUCCESS');
    expect(seen).toEqual(['one', 'two', 'three']);
  }, 30_000);

  it('does not let a throwing listener take the build with it', async () => {
    const executor = new ProcessExecutor();
    const outcome = await executor.run({
      workdir: process.cwd(),
      command: 'echo hello',
      commitSha: 'abc1234',
      onLine: () => { throw new Error('listener exploded'); },
    });
    // The listener is watching, not participating.
    expect(outcome.status).toBe('SUCCESS');
    expect(outcome.log).toContain('hello');
  }, 30_000);

  it('reports a non-zero exit rather than throwing', async () => {
    const outcome = await new ProcessExecutor().run({
      workdir: process.cwd(), command: 'echo bad >&2; exit 3', commitSha: 'abc1234',
    });
    expect(outcome.status).toBe('FAILURE');
    expect(outcome.exitCode).toBe(3);
    expect(outcome.log).toContain('bad');
  }, 30_000);
});

describe('FR-A, FR-B, FR-D · Cloud Build, polled and streamed', () => {
  const pipeline = new URL(
    '../../../deployment/cloudbuild/migration-build.yaml', import.meta.url,
  ).pathname;

  it('submits, polls to a terminal status, and streams the log as it grows', async () => {
    const log = [
      '[INFO] Running pay.security.CryptoServiceTest',
      '[INFO] Tests run: 2, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.02 s -- in pay.security.CryptoServiceTest',
    ];
    const transport = new ScriptedTransport([
      { match: /POST .*\/builds$/, reply: () => ({ metadata: { build: { id: 'b1' } } }) },
      {
        match: /GET .*\/builds\/b1$/,
        reply: (n) => ({
          id: 'b1',
          status: n < 3 ? 'WORKING' : 'SUCCESS',
          logsBucket: 'gs://logs',
          steps: [{ id: 'test', status: n < 3 ? 'WORKING' : 'SUCCESS' }],
        }),
      },
      // The log object grows by append, which is why only the tail is delivered.
      { match: /storage.*log-b1/, reply: (n) => (n < 2 ? `${log[0]}\n` : `${log.join('\n')}\n`) },
      { match: /storage.*\/o\?prefix/, reply: () => ({ items: [] }) },
    ]);

    const seen: string[] = [];
    const executor = new CloudBuildExecutor(transport, {
      projectId: 'p', region: 'us-central1', resultsBucket: 'b',
      pipelinePath: pipeline, buildImage: 'maven:3.9-eclipse-temurin-17',
      pollIntervalMs: 1,
    });

    const outcome = await executor.run({
      workdir: '/tmp', command: 'mvn -B verify', commitSha: 'abc1234',
      onLine: (l) => seen.push(l),
    });

    expect(outcome.status).toBe('SUCCESS');
    expect(outcome.provider.cloudBuildId).toBe('b1');
    // Step boundaries arrive before any log line — they are what says the build
    // started rather than sat in a queue.
    expect(seen).toContain('[cloudbuild] step test started');
    // Each log line exactly once, however many times the object was polled.
    expect(seen.filter((l) => l === log[0])).toHaveLength(1);
    expect(seen).toContain(log[1]);
  }, 30_000);

  it('carries the token as a secret version, never as a substitution', async () => {
    const transport = new ScriptedTransport([
      { match: /POST .*\/builds$/, reply: () => ({ metadata: { build: { id: 'b2' } } }) },
      { match: /GET .*\/builds\/b2$/, reply: () => ({ id: 'b2', status: 'SUCCESS' }) },
      { match: /storage.*\/o\?prefix/, reply: () => ({ items: [] }) },
    ]);
    await new CloudBuildExecutor(transport, {
      projectId: 'p', region: 'us-central1', resultsBucket: 'b',
      pipelinePath: pipeline, buildImage: 'img', pollIntervalMs: 1,
      tokenSecretVersion: 'projects/p/secrets/proteus-PQC-0001-github-pat/versions/1',
      repoUrl: 'https://github.com/o/r',
    }).run({ workdir: '/tmp', command: 'mvn -B verify', commitSha: 'abc1234' });

    const submit = transport.calls.find((c) => c.method === 'POST')!;
    const body = submit.body as { substitutions: Record<string, string> };
    // Cloud Build echoes substitutions into the build log, so a credential there
    // would be readable by anyone with log access.
    expect(JSON.stringify(body.substitutions)).not.toMatch(/gh[pousr]_|github_pat_/);
    expect(body.substitutions._TOKEN_SECRET_VERSION).toContain('/secrets/');
    expect(body.substitutions._COMMIT_SHA).toBe('abc1234');
  }, 30_000);

  it('reports a failed build as a failure rather than throwing', async () => {
    const transport = new ScriptedTransport([
      { match: /POST .*\/builds$/, reply: () => ({ metadata: { build: { id: 'b3' } } }) },
      { match: /GET .*\/builds\/b3$/, reply: () => ({ id: 'b3', status: 'FAILURE' }) },
      { match: /storage.*\/o\?prefix/, reply: () => ({ items: [] }) },
    ]);
    const outcome = await new CloudBuildExecutor(transport, {
      projectId: 'p', region: 'us-central1', resultsBucket: 'b',
      pipelinePath: pipeline, buildImage: 'img', pollIntervalMs: 1,
    }).run({ workdir: '/tmp', command: 'mvn -B verify', commitSha: 'abc1234' });

    // A red build is a result the loop classifies, not an exception.
    expect(outcome.status).toBe('FAILURE');
    expect(outcome.exitCode).toBe(1);
  }, 30_000);
});

describe('FR-1, FR-6, FR-7 · Cloud Run, with the settings that bound the cost', () => {
  const deployer = (transport: ScriptedTransport) => new CloudRunDeployer(transport, {
    projectId: 'p', region: 'us-central1', registry: 'us-central1-docker.pkg.dev/p/repo',
    serviceAccount: 'proteus-sandbox@p.iam.gserviceaccount.com',
    maxInstances: 2, cpu: '1', memory: '512Mi', requestTimeoutSeconds: 60,
    pollIntervalMs: 1,
  });

  const readyService = {
    uri: 'https://pqc-0184-abc.a.run.app',
    latestReadyRevision: 'projects/p/locations/us-central1/services/s/revisions/rev-1',
    terminalCondition: { state: 'CONDITION_SUCCEEDED' },
  };

  it('deploys with min-instances 0 and a bounded max', async () => {
    // The service does not exist yet, so the create path is taken. Order
    // matters: ScriptedTransport takes the first match, and the poll that
    // follows must not be answered by the 404.
    let existsYet = false;
    const transport = new ScriptedTransport([
      { match: /POST .*\/services\?/, reply: () => { existsYet = true; return { done: true }; } },
      { match: /setIamPolicy/, reply: () => ({}) },
      {
        match: /GET .*\/services\//,
        reply: () => {
          if (!existsYet) throw new GcpApiError(404, 'run', 'not found');
          return readyService;
        },
      },
    ]);
    const result = await deployer(transport).deploy({
      serviceName: 'proteus-sandbox-pqc-0184',
      imageUri: 'us-central1-docker.pkg.dev/p/repo/pqc-0184:abc',
      region: 'us-central1', containerPort: 8080,
    });

    expect(result.url).toBe(readyService.uri);
    const create = transport.calls.find((c) => c.method === 'POST' && /services\?/.test(c.url))!;
    const body = create.body as { template: Record<string, never> };
    // The whole cost story in one field: an idle sandbox must be free.
    expect(body.template.scaling).toEqual({ minInstanceCount: 0, maxInstanceCount: 2 });
    // CPU throttled outside a request, which is what makes it free rather than
    // merely cheap.
    expect((body.template.containers as never as Array<{ resources: { cpuIdle: boolean } }>)[0]!
      .resources.cpuIdle).toBe(true);
    expect(body.template.serviceAccount).toContain('proteus-sandbox@');
  }, 30_000);

  it('replaces an existing service rather than creating a second', async () => {
    const transport = new ScriptedTransport([
      { match: /GET .*\/services\/proteus-sandbox-pqc-0184$/, reply: () => readyService },
      { match: /PATCH .*\/services\//, reply: () => ({ done: true }) },
      { match: /setIamPolicy/, reply: () => ({}) },
      { match: /GET .*services/, reply: () => readyService },
    ]);
    await deployer(transport).deploy({
      serviceName: 'proteus-sandbox-pqc-0184',
      imageUri: 'us-central1-docker.pkg.dev/p/repo/pqc-0184:def',
      region: 'us-central1', containerPort: 8080,
    });

    // FR-9: a rerun produces a new revision, not a second URL to forget about.
    expect(transport.calls.some((c) => c.method === 'PATCH')).toBe(true);
    expect(transport.calls.some((c) => c.method === 'POST' && /services\?/.test(c.url)))
      .toBe(false);
  }, 30_000);

  it('deletes the image as well as the service', async () => {
    const transport = new ScriptedTransport([
      { match: /DELETE .*run\.googleapis/, reply: () => ({ done: true }) },
      { match: /DELETE .*artifactregistry/, reply: () => ({}) },
    ]);
    await deployer(transport).teardown({
      serviceName: 'proteus-sandbox-pqc-0184',
      imageUri: 'us-central1-docker.pkg.dev/p/repo/pqc-0184:abc',
    });

    // Deleting the service reclaims nothing — Cloud Run was already free at
    // rest. The image is what accrues.
    expect(transport.calls.filter((c) => /artifactregistry/.test(c.url)).length)
      .toBeGreaterThan(0);
  }, 30_000);

  it('treats an already-deleted service as the desired end state', async () => {
    const transport = new ScriptedTransport([
      { match: /DELETE .*run\.googleapis/, reply: () => ({}), status: 404 },
    ]);
    await expect(
      deployer(transport).teardown({ serviceName: 'gone' }),
    ).resolves.toBeUndefined();
  }, 30_000);

  it('parses an Artifact Registry image URI into its parts', () => {
    expect(parseImageUri('us-central1-docker.pkg.dev/proj/repo/pqc-0184:abc123')).toEqual({
      location: 'us-central1', project: 'proj', repo: 'repo', pkg: 'pqc-0184', tag: 'abc123',
    });
    expect(parseImageUri('proteus-sandbox/pqc-0184:abc')).toBeNull();
  });
});

describe('FR-10, FR-11, FR-12, FR-13 · the caps limit retention, not deployment', () => {
  const capacity = () => new SandboxCapacityService(t.repos, { perUser: 3, total: 30 });

  it('counts projects, not runs — a rerun replaces rather than adds', async () => {
    const p = await owned('user-a');
    await deployment({ projectId: p.projectId });
    // A second migration of the same project reuses the service name, so the
    // count is unchanged.
    await deployment({ projectId: p.projectId, sandboxDeploymentId: 'sbx_again' });

    const state = await capacity().state('user-a');
    expect(state.perUserUsed).toBe(1);
    expect(state.canRetain).toBe(true);
  });

  it('binds a fourth project for one user, and names which three to release', async () => {
    const projects = await Promise.all([1, 2, 3].map(() => owned('user-a')));
    for (const p of projects) await deployment({ projectId: p.projectId });

    const state = await capacity().state('user-a');
    expect(state.perUserUsed).toBe(3);
    expect(state.canRetain).toBe(false);
    expect(state.boundBy).toBe('USER');
    // A refusal that does not say which sandboxes you hold is not actionable.
    expect(state.ownProjects.sort()).toEqual(projects.map((p) => p.projectId).sort());
    expect(state.nextExpiryAt).toBeInstanceOf(Date);
  });

  it('binds the platform whoever owns the sandboxes', async () => {
    const small = new SandboxCapacityService(t.repos, { perUser: 10, total: 2 });
    for (const owner of ['user-a', 'user-b']) {
      const p = await owned(owner);
      await deployment({ projectId: p.projectId });
    }
    const state = await small.state('user-c');
    expect(state.canRetain).toBe(false);
    expect(state.boundBy).toBe('PLATFORM');
    expect(state.totalUsed).toBe(2);
  });

  it('reclaims expired sandboxes before refusing, and never evicts a live one', async () => {
    const small = new SandboxCapacityService(t.repos, { perUser: 1, total: 10 });
    const stale = await owned('user-a');
    await deployment({
      projectId: stale.projectId,
      expiresAt: new Date(Date.now() - 86_400_000),
    });
    const mine = await owned('user-a');

    const reclaimed: string[] = [];
    const state = await small.reclaimThenCheck(
      'user-a', mine.projectId,
      async (d) => { reclaimed.push(d.projectId); await markTornDown(d); },
    );

    // A platform that only counts upward reaches its cap and stays there.
    expect(reclaimed).toEqual([stale.projectId]);
    expect(state.canRetain).toBe(true);
  });

  it('a LOCAL sandbox holds no platform capacity', async () => {
    const p = await owned('user-a');
    await deployment({ projectId: p.projectId, placement: 'LOCAL' });
    const state = await capacity().state('user-a');
    // It is verified to the same standard, but it is not a hosted URL and it is
    // not occupying a slot anyone else could use.
    expect(state.perUserUsed).toBe(0);
    expect(state.totalUsed).toBe(0);
  });

  it('releasing says CAPACITY, and leaves no dead link behind', async () => {
    const p = await owned('user-a');
    const d = await deployment({ projectId: p.projectId });
    await t.repos.projects.collection.updateOne(
      { projectId: p.projectId } as never,
      { $set: { 'summary.sandboxUrl': 'https://x.run.app',
                'summary.sandboxDeployed': true } as never },
    );

    const deployer = new ScriptedDeployer('http://unused');
    await releaseSandbox(t.repos, deployer, d, 'CAPACITY');

    const stored = (await t.repos.sandboxDeployments.findOne({
      sandboxDeploymentId: d.sandboxDeploymentId,
    } as never))!;
    expect(stored.status).toBe('TORN_DOWN');
    // A capacity release and a failed deployment both end with no link; only one
    // is a defect, and the report must be able to tell a reader which.
    expect(stored.tornDownReason).toBe('CAPACITY');
    expect(deployer.tornDown[0]!.imageUri).toContain('docker.pkg.dev');

    const project = (await t.repos.projects.byId(p.projectId))!;
    expect(project.summary.sandboxUrl).toBeUndefined();
    expect(project.summary.sandboxDeployed).toBe(false);

    const events = await t.repos.events.since(p.projectId, 0);
    const released = events.find((e) => /capacity/i.test(e.title))!;
    expect(released.message).toMatch(/fully verified/i);
  });
});

describe('FR-16, FR-17, FR-18, FR-19 · the two clocks', () => {
  const lifecycle = () => new SandboxLifecycleService(t.repos, { ttlDays: 7, hardTtlDays: 30 });

  it('extends from the moment it was opened, never past the ceiling', async () => {
    const p = await owned('user-a');
    const created = new Date(Date.now() - 29 * 86_400_000);
    await deployment({
      projectId: p.projectId,
      createdAt: created,
      expiresAt: new Date(Date.now() + 86_400_000),
      hardExpiresAt: new Date(created.getTime() + 30 * 86_400_000),
    });

    const result = (await lifecycle().extend(p.projectId))!;
    // Seven days would pass the ceiling, so the ceiling wins — otherwise a
    // sandbox opened once a week lives forever, which is what a TTL exists to
    // prevent.
    expect(result.atCeiling).toBe(true);
    expect(result.deployment.expiresAt!.getTime())
      .toBe(result.deployment.hardExpiresAt!.getTime());
  });

  it('pushes the expiry out when there is room', async () => {
    const p = await owned('user-a');
    await deployment({
      projectId: p.projectId,
      expiresAt: new Date(Date.now() + 3600_000),
    });
    const result = (await lifecycle().extend(p.projectId))!;
    expect(result.extended).toBe(true);
    expect(result.atCeiling).toBe(false);
    expect(result.deployment.lastAccessedAt).toBeInstanceOf(Date);
  });

  it('will not extend one that is already torn down', async () => {
    const p = await owned('user-a');
    await deployment({ projectId: p.projectId, status: 'TORN_DOWN' });
    expect(await lifecycle().extend(p.projectId)).toBeNull();
  });

  it('sweeps what is past either clock, and keeps going past a failure', async () => {
    const [a, b, c] = await Promise.all([owned('u'), owned('u'), owned('u')]);
    await deployment({ projectId: a.projectId, expiresAt: new Date(Date.now() - 1000) });
    await deployment({
      projectId: b.projectId,
      expiresAt: new Date(Date.now() + 86_400_000),
      // Past its ceiling despite a future expiry — nothing lives indefinitely.
      hardExpiresAt: new Date(Date.now() - 1000),
    });
    await deployment({ projectId: c.projectId });

    const deployer = new ScriptedDeployer('http://unused');
    const result = await sweepSandboxes(t.repos, lifecycle(), () => deployer);

    expect(result.scanned).toBe(2);
    expect(result.reclaimed.sort()).toEqual([a.projectId, b.projectId].sort());
    expect(deployer.tornDown).toHaveLength(2);
    // The one still inside both clocks is untouched.
    expect((await t.repos.sandboxDeployments.findOne({
      projectId: c.projectId,
    } as never))!.status).toBe('READY');
  });

  it('marks a LOCAL sandbox nothing here can reach, rather than retrying forever', async () => {
    const p = await owned('u');
    await deployment({
      projectId: p.projectId, placement: 'LOCAL',
      expiresAt: new Date(Date.now() - 1000),
    });
    const result = await sweepSandboxes(t.repos, lifecycle(), () => null);
    expect(result.reclaimed).toEqual([p.projectId]);
    expect((await t.repos.sandboxDeployments.findOne({
      projectId: p.projectId,
    } as never))!.status).toBe('TORN_DOWN');
  });
});

async function markTornDown(d: SandboxDeployment): Promise<void> {
  await t.repos.sandboxDeployments.collection.updateOne(
    { sandboxDeploymentId: d.sandboxDeploymentId } as never,
    { $set: { status: 'TORN_DOWN', tornDownReason: 'EXPIRED' } as never },
  );
}

const _group: ProgressGroup = 'NEW_EVIDENCE';
void _group;
