import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import {
  CREDENTIAL_ROTATION_DAYS, redactTokens,
  type Artifact, type MigrationChange,
} from '@proteus/schema';
import { ScriptedModel } from '../src/agent/model';
import { buildPolicy } from '../src/core/services/policy';
import { sweepRotations } from '../src/core/services/rotation';
import { RuleEngine } from '../src/core/rules/engine';
import { ScriptedDeployer } from '../src/integrations/cloudrun/sandbox';
import { InMemoryBlobStore } from '../src/integrations/storage/blobs';
import { migrationBranchName } from '../src/integrations/github/writer';
import {
  buildEvidence, diffMeta, evidenceMeta, renderDiff,
} from '../src/reports/evidence';
import {
  REQUIRED_SECTIONS, finalOutcome, renderMarkdown,
} from '../src/reports/migration';
import { runTestEngineering } from '../src/worker/migrationJob';
import { runReport } from '../src/worker/reportJob';
import { aProject, clearAll, startTestDb, type TestDb } from './helpers/mongo';
import { failsafeReport, makeTestRepo, surefireReport, type TestRepo } from './helpers/repo';

/** PRD-14 acceptance criteria — the deliverable, and what must survive in it. */

let t: TestDb;
let repo: TestRepo;
let engine: RuleEngine;
const logger = pino({ level: 'silent' });

beforeAll(async () => {
  t = await startTestDb();
  engine = RuleEngine.fromFiles(
    fileURLToPath(new URL('../../../engine/rulesets/pqc-migration-rules.yaml', import.meta.url)),
    fileURLToPath(new URL('../../../engine/rulesets/migration-execution-rules.yaml', import.meta.url)),
  );
}, 120_000);
afterAll(async () => { await t?.stop(); });
beforeEach(async () => { await clearAll(t.repos); repo = await makeTestRepo(); });
afterEach(async () => { await repo?.dispose(); });

// ---------------------------------------------------------------------------
// A complete run, end to end, so the report has real state to describe.
// ---------------------------------------------------------------------------

const planItem = () => ({
  planItemId: 'plan_1', targetName: 'CryptoService', targetNodeIds: [], findingIds: ['fnd_1'],
  mode: 'AUTONOMOUS_MIGRATION' as const,
  action: 'Replace RSA key transport with ML-KEM-768',
  rationale: 'CNSA 2.0 requires ML-KEM for key establishment',
  expectedChanges: [{
    changeType: 'SOURCE' as const,
    paths: ['src/main/java/pay/security/CryptoService.java'],
    description: 'swap the wrap call',
  }],
  conditions: [], risk: 'MEDIUM' as const, order: 0,
});

const finding = () => ({
  _schemaVersion: 1, createdAt: new Date(), updatedAt: new Date(),
  findingId: 'fnd_1', projectId: '', category: 'CRYPTOGRAPHIC' as const,
  title: 'RSA-2048 key transport',
  summaryLine: 'Usage: key transport → Target: ML-KEM-768',
  description: 'RSA-2048 wraps the session key sent to the acquirer.',
  crypto: { algorithm: 'RSA', usage: 'KEY_TRANSPORT' as const, quantumVulnerable: true },
  severity: 'CRITICAL' as const, impact: 'MIGRATION_REQUIRED' as const,
  disposition: 'AUTONOMOUS_MIGRATION' as const,
  agentIntent: 'Replace the RSA wrap with ML-KEM-768 encapsulation.',
  locations: [{ path: 'src/main/java/pay/security/CryptoService.java', startLine: 51 }],
  nodeIds: [], evidenceIds: [], origin: 'REPOSITORY_SCAN' as const,
  dedupeKey: 'rsa|KEY_TRANSPORT|CryptoService.java|51',
  status: 'PLANNED' as const, discoveredAt: new Date(),
});

/**
 * The three recommendations the UX carries forward: an HSM, a gateway firmware
 * and the PKI. None was ever in the approved scope, and all three must survive
 * a successful migration.
 */
const RECOMMENDATIONS = [
  {
    recommendationId: 'rec_hsm', name: 'Luna Network HSM 7 · firmware 7.4.0',
    disposition: 'HARDWARE_REPLACEMENT' as const,
    action: 'Confirm ML-KEM support with Thales or schedule a device refresh.',
    owner: 'Platform security · HSM operations',
    sourceCitation: 'Luna HSM 7 Technical Specification §4.2',
  },
  {
    recommendationId: 'rec_gw', name: 'Gateway-X200 · firmware 4.2.1',
    disposition: 'VENDOR_DECISION' as const,
    action: 'Request a PQC roadmap commitment from the vendor.',
    owner: 'OT engineering · procurement',
    sourceCitation: 'Gateway-X200 Technical Specification §8.4',
  },
  {
    recommendationId: 'rec_pki', name: 'pay-api leaf certificate',
    disposition: 'FOLLOW_ON_WORKSTREAM' as const,
    action: 'Plan the PKI migration once a PQC-capable CA is available.',
    owner: 'Platform security · PKI',
    sourceCitation: 'deploy/tls/pay-api.crt.md',
  },
];

async function completeRun(sandboxUrl: string, blobs = new InMemoryBlobStore()) {
  const project = await t.repos.projects.create(aProject({
    stage: 'MIGRATING',
    summary: { ...aProject().summary, migrationApproved: true, discoveryComplete: true },
  }) as never);
  const now = new Date();
  const policy = buildPolicy(engine, 'policy_mlkem_v1');
  await t.repos.migrationPolicies.insert(policy);

  const assessment = {
    _schemaVersion: 1, createdAt: now, updatedAt: now,
    assessmentId: `asmt_${project.projectId}_v1`, projectId: project.projectId, version: 1,
    summary: {
      headline: 'One unambiguous autonomous migration scenario',
      whatExists: 'RSA-2048 key transport to the acquirer',
      whatIsVulnerable: 'Key establishment',
      whatAgentWillChange: 'CryptoService',
      whatAgentWillNotChange: 'Signature usages, the HSM and the certificate chain',
    },
    snapshot: {
      findingIds: ['fnd_1'], recommendationIds: RECOMMENDATIONS.map((r) => r.recommendationId),
      graphNodeIds: [], graphEdgeIds: [], inputFileIds: [],
      repoCommitSha: repo.baseCommitSha,
    },
    planItems: [planItem()],
    policyId: policy.policyId, status: 'APPROVED' as const, generatedAt: now,
  };
  await t.repos.assessments.insert(assessment as never);
  await t.repos.findings.insert({ ...finding(), projectId: project.projectId } as never);

  for (const r of RECOMMENDATIONS) {
    await t.repos.recommendations.insert({
      _schemaVersion: 1, createdAt: now, updatedAt: now,
      ...r, projectId: project.projectId,
      findingIds: [], nodeIds: [], evidenceIds: [],
      status: 'OPEN' as const, raisedAt: now,
    } as never);
  }

  const run = {
    _schemaVersion: 1, createdAt: now, updatedAt: now,
    migrationRunId: `mig_${project.projectId}_v1`, projectId: project.projectId,
    approval: {
      assessmentId: assessment.assessmentId, assessmentVersion: 1,
      approvedPlanItemIds: ['plan_1'], approvedBy: 'firebase-uid-1', approvedAt: now,
      acknowledgedActions: ['create a migration branch'],
    },
    branch: {
      name: migrationBranchName(project.projectId), baseCommitSha: repo.baseCommitSha,
      pushed: false, commitCount: 0,
    },
    stage: 'PREPARING_MIGRATION' as const, stageEnteredAt: now, status: 'RUNNING' as const,
    attemptCount: 0,
    metrics: {
      testsPassing: 0, testsFailing: 0, autonomousRepairs: 0,
      humanGatesOpened: 0, cloudBuildAttempts: 0,
    },
    checkpoint: { stage: 'PREPARING_MIGRATION' as const, at: now },
    startedAt: now,
  };
  await t.repos.migrationRuns.insert(run as never);

  // PRD-09 writes this at assessment time. The harness starts from an approved
  // assessment, so it stands in for that step — and the report job deliberately
  // does not rewrite it: the outcome must not be able to edit its own premise.
  await t.repos.artifacts.insert({
    _schemaVersion: 1, createdAt: now, updatedAt: now,
    artifactId: `art_${project.projectId}_asmt_v1`, projectId: project.projectId,
    kind: 'ASSESSMENT_REPORT' as const, format: 'MARKDOWN' as const,
    title: 'Assessment report v1',
    displayMeta: '1 FINDINGS · 1 PLAN ITEMS · 3 RECOMMENDATIONS',
    stats: { pages: 6 },
    assessmentId: assessment.assessmentId,
    gcsUri: `gs://test/${project.projectId}/reports/assessment-v1.md`,
    sizeBytes: 4096,
    status: 'READY' as const, generatedAt: now,
  } as never);

  // Baseline green · patch · the rigged mock failure · green after the repair ·
  // then the verification build and test.
  const green = [
    surefireReport('pay.security.SettlementSignerTest', [{ name: 'signs' }]),
    surefireReport('pay.ProteusKeyTransportRoundTripTest', [
      { name: 'roundTripsTheSharedSecret' }, { name: 'producesFips203Sizes' },
    ]),
    failsafeReport('pay.PartnerHandshakeIntegrationTest', [
      { name: 'completesTheHandshakeWithTheAcquirer' },
    ]),
  ];
  const runs = [
    { exitCode: 0, log: 'BUILD SUCCESS', reports: [] },
    {
      exitCode: 0, log: 'BUILD SUCCESS',
      reports: [surefireReport('pay.security.SettlementSignerTest', [{ name: 'signs' }])],
    },
    {
      exitCode: 1,
      log: '[ERROR] Tests run: 2, Failures: 1\n'
        + 'java.lang.IllegalArgumentException: Unsupported key exchange ML_KEM_PUBLIC_KEY '
        + '(expected RSA_PUBLIC_KEY)\n[INFO] BUILD FAILURE',
      reports: [
        surefireReport('pay.security.SettlementSignerTest', [{ name: 'signs' }]),
        failsafeReport('pay.PartnerHandshakeIntegrationTest', [{
          name: 'completesTheHandshakeWithTheAcquirer',
          failure: 'Unsupported key exchange ML_KEM_PUBLIC_KEY (expected RSA_PUBLIC_KEY)',
        }]),
      ],
    },
    { exitCode: 0, log: 'BUILD SUCCESS', reports: green },
    { exitCode: 0, log: 'BUILD SUCCESS', reports: green },
    { exitCode: 0, log: 'BUILD SUCCESS', reports: green },
  ];
  let call = 0;
  const executor = {
    environment: 'CLOUD_BUILD' as const,
    async run() {
      const a = runs[Math.min(call++, runs.length - 1)]!;
      return {
        exitCode: a.exitCode, status: a.exitCode === 0 ? 'SUCCESS' as const : 'FAILURE' as const,
        log: a.log, logExcerpt: a.log.split('\n').filter(Boolean),
        durationMs: 1200, reports: a.reports, provider: {},
      };
    },
  };

  await repo.write(
    'src/test/java/pay/PartnerHandshakeMock.java',
    'package pay;\nclass PartnerHandshakeMock {\n'
    + '  String keyType() { return "RSA_PUBLIC_KEY"; }\n}\n',
  );

  const model = new ScriptedModel({
    'baseline-invariants': {
      invariants: [
        {
          kind: 'API_BEHAVIOR',
          description: 'POST /settlements accepts a valid advice',
          assertion: 'assertEquals(201, response.getStatusCode());',
          capturedFrom: 'EXISTING_TEST',
        },
        {
          kind: 'MESSAGE_FORMAT',
          description: 'The wrapped session key is 256 bytes',
          assertion: 'assertEquals(256, wrapped.length);',
          capturedFrom: 'EXISTING_TEST',
        },
      ],
    },
    'coverage-assessment': { components: [] },
    'generate-tests': { artifacts: [] },
    'migration-patch': {
      planItemId: 'plan_1', changeType: 'SOURCE',
      summary: 'Migrate CryptoService to ML-KEM-768',
      rationale: 'CNSA 2.0 requires ML-KEM for key establishment.',
      findingIds: ['fnd_1'],
      files: [{
        path: 'src/main/java/pay/security/CryptoService.java', operation: 'MODIFIED',
        content: 'package pay.security;\n\npublic class CryptoService {\n'
          + '  // ML-KEM-768 encapsulation\n}\n',
      }],
    },
    'migration-repair': {
      changeType: 'MOCK',
      summary: 'Teach the partner simulator the ML-KEM handshake',
      rationale: 'The mock encoded the legacy RSA handshake the migration replaced.',
      files: [{
        path: 'src/test/java/pay/PartnerHandshakeMock.java', operation: 'MODIFIED',
        content: 'package pay;\nclass PartnerHandshakeMock {\n'
          + '  String keyType() { return "ML_KEM_PUBLIC_KEY"; }\n}\n',
      }],
      testIntegrity: {
        failureClassification: 'MOCK_INCOMPATIBILITY',
        reason: 'Mock represents the legacy RSA protocol while the approved migration '
          + 'scope requires ML-KEM.',
        baselineRequirementChanged: false,
        safeAutonomousModification: true,
      },
    },
    'migration-report-narrative': {
      headline: 'RSA key transport migrated to ML-KEM-768',
      summary: 'The acquirer key exchange now uses ML-KEM-768. Baseline behaviour was '
        + 'preserved and the migrated application runs in an isolated sandbox.',
      whatChanged: 'CryptoService, and the partner simulator that stood in for the acquirer.',
      whatWasPreserved: 'The settlement API contract and its rejection behaviour.',
      whatRemains: 'Two RSA signature usages, the certificate chain, the HSM and the '
        + 'OT gateway — each with a named owner.',
    },
  });

  const outcome = await runTestEngineering(project, run as never, {
    repos: t.repos, projects: null as never, engine, model, executor,
    deployer: new ScriptedDeployer(sandboxUrl),
    blobs,
    logger, workdir: repo.dir,
    reportModel: model,
  });

  return { project, run, outcome, blobs };
}

/** A sandbox that answers the scenarios, so the run reaches VERIFIED. */
async function stubSandbox(): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    if (req.url === '/healthz') { res.writeHead(200); res.end('ok'); return; }
    if (req.url === '/settlements' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const parsed = JSON.parse(body || '{}') as { merchantId?: string };
        res.writeHead(parsed.merchantId ? 201 : 400, { 'content-type': 'application/json' });
        res.end(JSON.stringify(parsed.merchantId
          ? { keyEstablishment: 'ML-KEM-768', wrappedKeyBytes: 1088 }
          : { error: 'malformed' }));
      });
      return;
    }
    if (req.url === '/') { res.writeHead(200); res.end('ML-KEM-768'); return; }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  return {
    url: `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

// ---------------------------------------------------------------------------

describe('AC-1, FR-1 · the report contains every section spec §40 lists', () => {
  it('renders all eleven, over a real completed run', async () => {
    const stub = await stubSandbox();
    try {
      const { project, run, blobs } = await completeRun(stub.url);
      const stored = (await t.repos.projects.byId(project.projectId))!;
      const storedRun = (await t.repos.migrationRuns.findOne({
        migrationRunId: run.migrationRunId,
      } as never))!;

      const { snapshot } = await runReport(stored, storedRun, {
        repos: t.repos, blobs, logger,
      });
      const markdown = renderMarkdown(snapshot);

      for (const section of REQUIRED_SECTIONS) {
        expect(markdown, `missing §40 section: ${section}`).toContain(`## ${section}`);
      }
      expect(REQUIRED_SECTIONS).toHaveLength(11);

      // The parts of §40 that live inside those sections.
      expect(markdown).toContain('### Autonomous items');
      expect(markdown).toContain('### Excluded items');
      expect(markdown).toContain('### Vendor and hardware blockers');
      expect(markdown).toContain('### Captured behavioural invariants');
      expect(markdown).toContain('### Legacy cryptography remaining');
      expect(markdown).toContain('### Target PQC implementation');
      expect(markdown).toContain('### End-to-end verification');
    } finally {
      await stub.close();
    }
  }, 90_000);
});

describe('AC-5, FR-7 · the recovery section records the failure and the repair', () => {
  it('names the classification, the diagnosis source and the retry count', async () => {
    const stub = await stubSandbox();
    try {
      const { project, run, blobs } = await completeRun(stub.url);
      const stored = (await t.repos.projects.byId(project.projectId))!;
      const storedRun = (await t.repos.migrationRuns.findOne({
        migrationRunId: run.migrationRunId,
      } as never))!;

      const { snapshot } = await runReport(stored, storedRun, {
        repos: t.repos, blobs, logger,
      });

      expect(snapshot.recovery.autonomousRepairs).toBe(1);
      expect(snapshot.recovery.problems).toHaveLength(1);
      const problem = snapshot.recovery.problems[0]!;
      expect(problem.classification).toBe('MOCK_INCOMPATIBILITY');
      expect(problem.meaningfulAttempts).toBe(1);
      expect(problem.budget).toBe(4);
      expect(problem.status).toBe('RESOLVED');
      // What was actually done about it, tied back to the modification.
      expect(problem.actionTaken).toMatch(/partner simulator.*modification #/i);

      const markdown = renderMarkdown(snapshot);
      expect(markdown).toContain('1 / 4 meaningful attempts');
      expect(markdown).toContain('MOCK INCOMPATIBILITY');
    } finally {
      await stub.close();
    }
  }, 90_000);
});

describe('AC-6, FR-8 · the security section separates verified from residual', () => {
  it('shows the verdict, and why what remains is acceptable', async () => {
    const stub = await stubSandbox();
    try {
      const { project, run, blobs } = await completeRun(stub.url);
      const stored = (await t.repos.projects.byId(project.projectId))!;
      const storedRun = (await t.repos.migrationRuns.findOne({
        migrationRunId: run.migrationRunId,
      } as never))!;

      const { snapshot } = await runReport(stored, storedRun, {
        repos: t.repos, blobs, logger,
      });

      expect(snapshot.security.verdict).toBe('VERIFIED');
      expect(snapshot.security.checks).toHaveLength(9);
      const failing = snapshot.security.checks.filter((c) => c.status !== 'PASS');
      expect(failing.map((c) => `${c.check}: ${c.detail}`)).toEqual([]);
      // Every check names the execution or document that established it.
      const unsourced = snapshot.security.checks.filter(
        (c) => !c.executionRunId && c.status === 'PASS',
      );
      expect(unsourced.map((c) => c.check)).toEqual(['SANDBOX_DEPLOYMENT_SUCCESSFUL']);

      const markdown = renderMarkdown(snapshot);
      expect(markdown).toContain('## Security verification');
      expect(markdown).toContain('### Legacy cryptography remaining');
      // A residual usage is never printed without the reason it is acceptable.
      for (const r of snapshot.security.residualLegacy) {
        expect(r.acceptanceReason.length).toBeGreaterThan(0);
        expect(markdown).toContain(r.acceptanceReason);
      }
    } finally {
      await stub.close();
    }
  }, 90_000);
});

describe('AC-3, FR-5 · recommendations survive a successful migration', () => {
  it('carries all three forward with disposition, action and owner', async () => {
    const stub = await stubSandbox();
    try {
      const { project, run, blobs } = await completeRun(stub.url);
      const stored = (await t.repos.projects.byId(project.projectId))!;
      const storedRun = (await t.repos.migrationRuns.findOne({
        migrationRunId: run.migrationRunId,
      } as never))!;

      const { snapshot } = await runReport(stored, storedRun, {
        repos: t.repos, blobs, logger,
      });

      // The failure this guards against: a successful migration making the items
      // it never touched feel irrelevant, and quietly dropping them.
      expect(snapshot.externalDependencies).toHaveLength(3);
      const markdown = renderMarkdown(snapshot);
      for (const r of RECOMMENDATIONS) {
        expect(markdown).toContain(r.name);
        expect(markdown).toContain(r.action);
        expect(markdown).toContain(r.owner);
        expect(markdown).toContain(r.sourceCitation);
      }

      // The hardware and vendor ones appear again as plan blockers, because
      // those are different questions: who must act, and what was in scope.
      expect(snapshot.approvedPlan.blockers.map((b) => b.disposition).sort())
        .toEqual(['HARDWARE_REPLACEMENT', 'VENDOR_DECISION']);
      expect(snapshot.outcome.recommendationsRaised).toBe(3);
    } finally {
      await stub.close();
    }
  }, 90_000);
});

describe('AC-4, FR-10 · no artifact carries a credential', () => {
  it('redacts a token-shaped string out of the bytes, not just the document', async () => {
    const stub = await stubSandbox();
    try {
      const { project, run, blobs } = await completeRun(stub.url);
      const stored = (await t.repos.projects.byId(project.projectId))!;
      const storedRun = (await t.repos.migrationRuns.findOne({
        migrationRunId: run.migrationRunId,
      } as never))!;

      // A build log is exactly where a credential ends up, and the artifact's
      // content goes to blob storage without passing through the repository
      // layer that redacts documents.
      const leaked = 'ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
      await t.repos.executionRuns.collection.updateOne(
        { migrationRunId: storedRun.migrationRunId } as never,
        { $set: { logExcerpt: [`cloning with ${leaked}`] } as never },
      );

      const { artifacts } = await runReport(stored, storedRun, {
        repos: t.repos, blobs, logger,
      });

      for (const artifact of artifacts) {
        const path = artifact.gcsUri.replace(/^gs:\/\/[^/]+\//, '');
        const body = (await blobs.get(path)).toString('utf8');
        expect(body, `${artifact.kind} leaked a token`).not.toContain(leaked);
        expect(body).not.toMatch(/gh[pousr]_[A-Za-z0-9]{20,}/);
        expect(JSON.stringify(artifact.contentSnapshot ?? {})).not.toContain(leaked);
      }
    } finally {
      await stub.close();
    }
  }, 90_000);

  it('redacts the shapes a token actually takes', () => {
    const shapes = {
      classic: 'ghp_0123456789abcdefghijklmnopqrstuvwxyz',
      fineGrained: 'github_pat_11ABCDE0000000000000000000_'
        + 'aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789abcdefghij',
      oauth: 'gho_0123456789abcdefghijklmnopqrstuvwxyz',
      nested: { deep: ['ghs_0123456789abcdefghijklmnopqrstuvwxyz'] },
    };
    const clean = JSON.stringify(redactTokens(shapes));
    expect(clean).not.toMatch(/gh[pousr]_[A-Za-z0-9]{20,}/);
    expect(clean).not.toContain('github_pat_');
  });
});

describe('AC-8, FR-6 · the report is reproducible', () => {
  it('renders identical bytes from the same snapshot', async () => {
    const stub = await stubSandbox();
    try {
      const { project, run, blobs } = await completeRun(stub.url);
      const stored = (await t.repos.projects.byId(project.projectId))!;
      const storedRun = (await t.repos.migrationRuns.findOne({
        migrationRunId: run.migrationRunId,
      } as never))!;

      const { artifacts, snapshot } = await runReport(stored, storedRun, {
        repos: t.repos, blobs, logger,
      });

      // A pure transform: the file a reviewer keeps says the same thing next
      // year that it said on screen.
      expect(renderMarkdown(snapshot)).toBe(renderMarkdown(snapshot));

      const report = artifacts.find((a) => a.kind === 'MIGRATION_REPORT')!;
      const fromSnapshot = renderMarkdown(
        report.contentSnapshot as unknown as Parameters<typeof renderMarkdown>[0],
      );
      const path = report.gcsUri.replace(/^gs:\/\/[^/]+\//, '');
      expect(fromSnapshot).toBe((await blobs.get(path)).toString('utf8'));

      // Regenerating replaces the artifact rather than accumulating copies.
      await runReport(stored, storedRun, { repos: t.repos, blobs, logger });
      expect(await t.repos.artifacts.count({
        projectId: project.projectId, kind: 'MIGRATION_REPORT',
      } as never)).toBe(1);
    } finally {
      await stub.close();
    }
  }, 90_000);
});

describe('FR-2, FR-3, FR-4 · four artifacts, each with meta and references', () => {
  it('produces the package the completion screen offers', async () => {
    const stub = await stubSandbox();
    try {
      const { project, run, blobs } = await completeRun(stub.url);
      const stored = (await t.repos.projects.byId(project.projectId))!;
      const storedRun = (await t.repos.migrationRuns.findOne({
        migrationRunId: run.migrationRunId,
      } as never))!;

      await runReport(stored, storedRun, {
        repos: t.repos, blobs, logger,
      });

      const all = await t.repos.artifacts.find({ projectId: project.projectId } as never);
      // The assessment report is written at assessment time and not rewritten
      // here — the outcome must not be able to edit its own premise.
      expect(all.map((a: Artifact) => a.kind).sort()).toEqual([
        'ASSESSMENT_REPORT', 'BUILD_TEST_EVIDENCE', 'GIT_DIFF', 'MIGRATION_REPORT',
      ]);

      for (const artifact of all as Artifact[]) {
        expect(artifact.displayMeta.length, artifact.kind).toBeGreaterThan(0);
        expect(artifact.status).toBe('READY');
        expect(artifact.sizeBytes).toBeGreaterThan(0);
      }

      const report = (all as Artifact[]).find((a) => a.kind === 'MIGRATION_REPORT')!;
      // EXEC-VER-013's references.
      expect(report.migrationRunId).toBe(storedRun.migrationRunId);
      expect(report.assessmentId).toBe(storedRun.approval.assessmentId);
      expect(report.stats?.pages).toBeGreaterThan(0);

      const diff = (all as Artifact[]).find((a) => a.kind === 'GIT_DIFF')!;
      expect(diff.stats?.commits).toBeGreaterThan(0);
      expect(diff.displayMeta).toMatch(/COMMITS? · \d+ FILES? · \+\d+ −\d+/);
    } finally {
      await stub.close();
    }
  }, 90_000);
});

describe('the diff carries its reasoning, and the evidence its failures', () => {
  const change = (over: Partial<MigrationChange> = {}): MigrationChange => ({
    _schemaVersion: 1, createdAt: new Date(), updatedAt: new Date(),
    changeId: 'chg_1', projectId: 'PQC-0184', migrationRunId: 'mig_1', attemptId: 'att_1',
    sequence: 1, changeType: 'SOURCE', intent: 'MIGRATION',
    summary: 'Migrate CryptoService to ML-KEM-768',
    rationale: 'CNSA 2.0 requires ML-KEM for key establishment, and the acquirer '
      + 'handshake is the only key transport site in the approved scope.',
    findingIds: ['fnd_1'], planItemIds: ['plan_1'],
    files: [{
      path: 'src/main/java/pay/security/CryptoService.java',
      operation: 'MODIFIED', linesAdded: 12, linesRemoved: 5,
    }],
    commitSha: 'abc1234def5678', verificationOutcome: 'PENDING', appliedAt: new Date(),
    ...over,
  } as MigrationChange);

  it('puts the rationale above the hunk, not in a separate document', () => {
    const { content, stats } = renderDiff(
      [change()],
      new Map([['chg_1', 'diff --git a/CryptoService.java b/CryptoService.java\n+ml-kem\n-rsa']]),
    );
    expect(content).toContain('Modification #1 — Migrate CryptoService to ML-KEM-768');
    // A reviewer reading top to bottom sees the reasoning before the code.
    expect(content.indexOf('CNSA 2.0 requires')).toBeLessThan(content.indexOf('diff --git'));
    expect(stats.commits).toBe(1);
    expect(stats.filesChanged).toBe(1);
    expect(diffMeta(stats)).toBe('1 COMMIT · 1 FILE · +12 −5');
  });

  it('answers spec §26 inside the diff for a modified test', () => {
    const { content } = renderDiff([change({
      changeId: 'chg_2', changeType: 'MOCK', intent: 'REPAIR',
      summary: 'Teach the partner simulator the ML-KEM handshake',
      testIntegrity: {
        failureClassification: 'MOCK_INCOMPATIBILITY',
        reason: 'Mock represents the legacy RSA protocol.',
        baselineRequirementChanged: false,
        safeAutonomousModification: true,
      },
    })], new Map([['chg_2', '+ML_KEM_PUBLIC_KEY']]));

    // A reviewer looking at a modified test should not have to leave the file
    // to learn why it was safe to modify.
    expect(content).toContain('Test integrity: MOCK_INCOMPATIBILITY');
    expect(content).toContain('Baseline requirement changed: no');
  });

  it('counts lines from the patch when the change did not record them', () => {
    const { stats } = renderDiff(
      [change({ files: [{ path: 'A.java', operation: 'MODIFIED', linesAdded: 0, linesRemoved: 0 }] })],
      new Map([['chg_1', '--- a/A.java\n+++ b/A.java\n+one\n+two\n-three']]),
    );
    // git computes them and we did not store them, which is the common case.
    expect(stats.linesAdded).toBe(2);
    expect(stats.linesRemoved).toBe(1);
  });

  it('structures every execution and attempt, with the logs the diagnosis saw', () => {
    const evidence = buildEvidence(
      [{
        _schemaVersion: 1, createdAt: new Date(), updatedAt: new Date(),
        executionRunId: 'exec_1', projectId: 'PQC-0184', migrationRunId: 'mig_1',
        kind: 'INTEGRATION_TEST', environment: 'CLOUD_BUILD', provider: {},
        commitSha: 'abc1234', command: 'mvn -B verify', exitCode: 1, status: 'FAILURE',
        tests: {
          total: 2, passed: 1, failed: 1, skipped: 0,
          failures: [{
            testId: 'pay.X#y', name: 'y', suite: 'pay.X', message: 'Unsupported key exchange',
          }],
        },
        logExcerpt: ['[ERROR] Tests run: 2, Failures: 1'],
        startedAt: new Date(),
      }],
      [{
        _schemaVersion: 1, createdAt: new Date(), updatedAt: new Date(),
        attemptId: 'att_1', projectId: 'PQC-0184', migrationRunId: 'mig_1',
        attemptNumber: 1, intent: 'Migrate CryptoService', planItemIds: [], changeIds: [],
        executionRunIds: ['exec_1'],
        failure: {
          phase: 'INTEGRATION_TEST', command: 'mvn -B verify', exitCode: 1,
          failedTests: [{ name: 'pay.X#y', message: 'Unsupported key exchange' }],
          error: 'Unsupported key exchange ML_KEM_PUBLIC_KEY',
          relevantLogs: ['Expected RSA_PUBLIC_KEY'],
        },
        result: 'FAILED', startedAt: new Date(),
      }] as never,
    );

    expect(evidence.summary).toEqual({ executions: 1, attempts: 1, passed: 0, failed: 1 });
    expect(evidence.executions[0]!.tests?.failures[0]!.testId).toBe('pay.X#y');
    // The same bounded extract the diagnosis saw, so a reader can check the
    // classification against exactly what produced it.
    expect(evidence.attempts[0]!.failure?.relevantLogs).toEqual(['Expected RSA_PUBLIC_KEY']);
    expect(evidenceMeta(evidence)).toBe('1 EXECUTION · 1 ATTEMPT');
  });
});

describe('the final outcome comes from data, never from prose', () => {
  it('picks the verdict spec §40 names for each state', () => {
    const verified = { overall: 'VERIFIED' } as never;
    expect(finalOutcome({
      verification: verified, openBlockingGates: 0, completed: 1, eligible: 1,
    })).toBe('VERIFIED');

    // A blocking gate outranks a green verdict: something is waiting on a human.
    expect(finalOutcome({
      verification: verified, openBlockingGates: 1, completed: 1, eligible: 1,
    })).toBe('HUMAN_ACTION_REQUIRED');

    expect(finalOutcome({
      verification: { overall: 'NOT_VERIFIED' } as never,
      openBlockingGates: 0, completed: 1, eligible: 2,
    })).toBe('PARTIALLY_MIGRATED');

    expect(finalOutcome({
      verification: null, openBlockingGates: 0, completed: 0, eligible: 1,
    })).toBe('HUMAN_ACTION_REQUIRED');
  });
});

describe('AC-9, FR-11 · the rotation reminder fires once per credential', () => {
  const withCredential = (over: Record<string, unknown>): Record<string, unknown> => {
    const base = aProject() as Record<string, unknown>;
    return {
      ...base,
      repository: {
        ...(base.repository as Record<string, unknown>),
        credential: {
          secretName: 'proteus-PQC-0001-github-pat',
          secretVersion: '1',
          displayPrefix: 'ghp_AAAAAAAA',
          declaredScopes: ['repo'],
          status: 'STORED',
          storedAt: new Date('2026-01-01'),
          ...over,
        },
      },
    };
  };

  it('emits for a project past its rotation date, and only once', async () => {
    const overdue = await t.repos.projects.create(withCredential({
      rotationDueAt: new Date('2026-06-01'),
    }) as never);
    const fresh = await t.repos.projects.create(withCredential({
      rotationDueAt: new Date('2027-06-01'),
    }) as never);

    const first = await sweepRotations(t.repos, new Date('2026-08-29'));
    expect(first.reminded).toEqual([overdue.projectId]);
    expect(first.scanned).toBe(1);

    // A sweep on a schedule must not fill the audit trail with the same warning.
    const second = await sweepRotations(t.repos, new Date('2026-08-30'));
    expect(second.reminded).toEqual([]);
    expect(second.alreadyReminded).toEqual([overdue.projectId]);

    const events = await t.repos.events.since(overdue.projectId, 0);
    const reminders = events.filter((e) => e.type === 'CREDENTIAL_ROTATION_DUE');
    expect(reminders).toHaveLength(1);
    expect(reminders[0]!.severity).toBe('WARN');
    // The reference, never the value.
    expect(reminders[0]!.message).toContain('proteus-PQC-0001-github-pat@1');
    expect(reminders[0]!.message).not.toContain('ghp_');

    expect(await t.repos.events.count({ projectId: fresh.projectId } as never)).toBe(0);
  });

  it('reminds again once the credential has actually been rotated', async () => {
    const project = await t.repos.projects.create(withCredential({
      rotationDueAt: new Date('2026-06-01'),
    }) as never);
    await sweepRotations(t.repos, new Date('2026-08-29'));

    // A new version is a new credential, and its own rotation clock.
    await t.repos.projects.collection.updateOne(
      { projectId: project.projectId } as never,
      { $set: { 'repository.credential.secretVersion': '2' } as never },
    );
    const after = await sweepRotations(t.repos, new Date('2026-08-31'));
    expect(after.reminded).toEqual([project.projectId]);
  });

  it('leaves a revoked credential alone', async () => {
    const project = await t.repos.projects.create(withCredential({
      rotationDueAt: new Date('2026-06-01'), status: 'REVOKED',
    }) as never);
    const result = await sweepRotations(t.repos, new Date('2026-08-29'));
    expect(result.scanned).toBe(0);
    expect(await t.repos.events.count({ projectId: project.projectId } as never)).toBe(0);
  });

  it('uses the rotation window PRD-05 established', () => {
    expect(CREDENTIAL_ROTATION_DAYS).toBeGreaterThan(0);
  });
});

describe('the narrative may describe, never decide', () => {
  it('leaves every number and the verdict untouched when prose is absent', async () => {
    const stub = await stubSandbox();
    try {
      const { project, run, blobs } = await completeRun(stub.url);
      const stored = (await t.repos.projects.byId(project.projectId))!;
      const storedRun = (await t.repos.migrationRuns.findOne({
        migrationRunId: run.migrationRunId,
      } as never))!;

      // No model at all. Risk 2's guard is structural: a report without prose is
      // still a complete report, and the outcome is unchanged by its absence.
      const { snapshot } = await runReport(stored, storedRun, {
        repos: t.repos, blobs, logger,
      });
      expect(snapshot.narrative).toBeUndefined();
      expect(snapshot.outcome.final).toBe('VERIFIED');
      expect(snapshot.security.verdict).toBe('VERIFIED');
      expect(renderMarkdown(snapshot)).toContain('## Final outcome');
    } finally {
      await stub.close();
    }
  }, 90_000);

  it('survives a model that fails, rather than losing the evidence', async () => {
    const stub = await stubSandbox();
    try {
      const { project, run, blobs } = await completeRun(stub.url);
      const stored = (await t.repos.projects.byId(project.projectId))!;
      const storedRun = (await t.repos.migrationRuns.findOne({
        migrationRunId: run.migrationRunId,
      } as never))!;

      // Failing the whole package because a sentence could not be written would
      // lose the evidence over the commentary.
      const { artifacts, snapshot } = await runReport(stored, storedRun, {
        repos: t.repos, blobs, logger,
        model: new ScriptedModel({}),
      });
      expect(snapshot.narrative).toBeUndefined();
      expect(artifacts).toHaveLength(3);
      expect(snapshot.outcome.final).toBe('VERIFIED');
    } finally {
      await stub.close();
    }
  }, 90_000);
});

describe('spec §51 · the prototype walks end to end', () => {
  it('reaches COMPLETED with the evidence package and the outcome tiles', async () => {
    const stub = await stubSandbox();
    try {
      const { project } = await completeRun(stub.url);
      const stored = (await t.repos.projects.byId(project.projectId))!;

      // The last step of §51's flow: download a complete migration report.
      expect(stored.stage).toBe('COMPLETED');
      expect(stored.summary.latestArtifactId).toBeTruthy();
      expect(stored.summary.migrationComplete).toBe(true);
      expect(stored.summary.sandboxUrl).toBe(stub.url);

      // AC-7's tiles, from data.
      expect(stored.summary.autonomy.completionPct).toBe(100);
      expect(stored.summary.autonomy.humanEngineeringActions).toBe(0);
      expect(stored.summary.counts.recommendations).toBeGreaterThanOrEqual(0);

      const run = (await t.repos.migrationRuns.findOne({
        projectId: project.projectId,
      } as never))!;
      expect(run.outcome).toBe('VERIFIED');
      expect(run.status).toBe('COMPLETED');
      expect(run.metrics.autonomousRepairs).toBe(1);

      const events = await t.repos.events.since(project.projectId, 0);
      const completed = events.filter((e) => e.type === 'MIGRATION_COMPLETED');
      expect(completed.length).toBeGreaterThanOrEqual(1);
      expect(completed.at(-1)!.message).toContain('artifact');
    } finally {
      await stub.close();
    }
  }, 90_000);
});
