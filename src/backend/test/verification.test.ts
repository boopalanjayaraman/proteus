import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import {
  VerificationCheckResult, computeOverallVerdict,
  type Baseline, type BehavioralInvariant, type ExecutionRun, type Finding,
  type HumanGate, type MigrationChange, type MigrationPolicy, type MigrationRun,
  type PlanItem, type SandboxDeployment,
} from '@proteus/schema';
import { ScriptedModel } from '../src/agent/model';
import { buildPolicy } from '../src/core/services/policy';
import type { Candidate } from '../src/core/discovery/detect';
import { parseReports, type TestInventory } from '../src/core/migration/testReports';
import { RuleEngine } from '../src/core/rules/engine';
import { ScriptedDeployer, sandboxServiceName } from '../src/integrations/cloudrun/sandbox';
import { InMemoryBlobStore } from '../src/integrations/storage/blobs';
import { migrationBranchName } from '../src/integrations/github/writer';
import { checkScope, toPattern } from '../src/verification/checks/scope';
import { inScope, sameFamily, scopeOf } from '../src/verification/checks/crypto';
import { checkBlockers, checkBuild, checkInvariants, checkTests } from '../src/verification/checks/tests';
import { implicatedBy, mayDeploy, verify } from '../src/verification/service';
import { probeStartup, runScenarios, SETTLEMENT_SCENARIOS } from '../src/verification/e2e';
import { runTestEngineering } from '../src/worker/migrationJob';
import { aProject, clearAll, startTestDb, type TestDb } from './helpers/mongo';
import { failsafeReport, makeTestRepo, surefireReport, type TestRepo } from './helpers/repo';

/** PRD-13 acceptance criteria — the verdict, and what it refuses to conclude. */

let t: TestDb;
let repo: TestRepo;
let engine: RuleEngine;
let policy: MigrationPolicy;
const logger = pino({ level: 'silent' });

beforeAll(async () => {
  t = await startTestDb();
  engine = RuleEngine.fromFiles(
    fileURLToPath(new URL('../../../engine/rulesets/pqc-migration-rules.yaml', import.meta.url)),
    fileURLToPath(new URL('../../../engine/rulesets/migration-execution-rules.yaml', import.meta.url)),
  );
  policy = buildPolicy(engine, 'policy_mlkem_v1');
}, 120_000);
afterAll(async () => { await t?.stop(); });
beforeEach(async () => { await clearAll(t.repos); repo = await makeTestRepo(); });
afterEach(async () => { await repo?.dispose(); });

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const HEAD = 'b19f0c4a7e2d8f6a5c3b1e9d7f5a3c1b9e7d5f3a';

const candidate = (over: Partial<Candidate> = {}): Candidate => ({
  ruleId: 'EXEC-DET-001', path: 'src/main/java/pay/security/CryptoService.java', line: 51,
  matchedText: 'Cipher.getInstance("RSA/ECB/OAEPWithSHA-256AndMGF1Padding")',
  algorithm: 'RSA/ECB/OAEPWithSHA-256AndMGF1Padding',
  usage: 'KEY_TRANSPORT', strength: 'STRONG', severity: 'CRITICAL', quantumVulnerable: true,
  dedupeKey: 'k', evidence: {} as never,
  ...over,
});

const finding = (over: Partial<Finding> = {}): Finding => ({
  _schemaVersion: 1, createdAt: new Date(), updatedAt: new Date(),
  findingId: 'fnd_1', projectId: 'PQC-0184',
  category: 'CRYPTOGRAPHIC',
  title: 'RSA-2048 key transport',
  summaryLine: 'Usage: key transport → Target: ML-KEM-768',
  description: 'RSA-2048 wraps the session key sent to the acquirer.',
  crypto: { algorithm: 'RSA', usage: 'KEY_TRANSPORT', quantumVulnerable: true },
  severity: 'CRITICAL',
  impact: 'MIGRATION_REQUIRED',
  disposition: 'AUTONOMOUS_MIGRATION',
  agentIntent: 'Replace the RSA wrap with ML-KEM-768 encapsulation.',
  locations: [{ path: 'src/main/java/pay/security/CryptoService.java', startLine: 51 }],
  nodeIds: [], evidenceIds: [],
  origin: 'REPOSITORY_SCAN',
  dedupeKey: 'rsa|KEY_TRANSPORT|src/main/java/pay/security/CryptoService.java|51',
  status: 'PLANNED',
  discoveredAt: new Date(),
  ...over,
});

const invariant = (over: Partial<BehavioralInvariant> = {}): BehavioralInvariant => ({
  invariantId: 'inv_1', kind: 'API_BEHAVIOR',
  description: 'POST /settlements accepts a valid advice',
  assertion: 'assertEquals(201, response.getStatusCode());',
  capturedFrom: 'EXISTING_TEST', disposition: 'MUST_PRESERVE', evidenceIds: [],
  ...over,
});

const execution = (over: Partial<ExecutionRun> = {}): ExecutionRun => ({
  _schemaVersion: 1, createdAt: new Date(), updatedAt: new Date(),
  executionRunId: 'exec_verify', projectId: 'PQC-0184', migrationRunId: 'mig_1',
  kind: 'CRYPTO_VERIFY', environment: 'CLOUD_BUILD', provider: {},
  commitSha: HEAD, command: 'mvn -B verify', exitCode: 0, status: 'SUCCESS',
  logExcerpt: [], startedAt: new Date(),
  ...over,
});

const baseline = (over: Partial<Baseline> = {}): Baseline => ({
  _schemaVersion: 1, createdAt: new Date(), updatedAt: new Date(),
  baselineId: 'base_1', projectId: 'PQC-0184', migrationRunId: 'mig_1',
  commitSha: '7c41ab9d2f1e4c8b6a5d3e2f1a0b9c8d7e6f5a4b',
  build: { executionRunId: 'exec_b', passed: true, durationMs: 41000 },
  tests: {
    executionRunId: 'exec_t', total: 3, passed: 3, failed: 0, skipped: 0,
    knownFailures: [],
    inventory: [
      { testId: 'pay.A#one', name: 'one', suite: 'pay.A', status: 'PASSED' },
      { testId: 'pay.A#two', name: 'two', suite: 'pay.A', status: 'PASSED' },
      { testId: 'pay.B#three', name: 'three', suite: 'pay.B', status: 'PASSED' },
    ],
  },
  invariants: [invariant()],
  capturedAt: new Date(),
  ...over,
});

const inventoryOf = (
  suites: Array<[string, Array<{ name: string; failure?: string }>]>,
): TestInventory => parseReports(suites.map(([s, c]) => surefireReport(s, c)));

const ROUND_TRIP_OK = {
  executed: true, sharedSecretsMatch: true, mockedPrimitive: false,
  parameterSetResolved: 'ML-KEM-768',
  detail: '2 KEM tests ran; no test stubs the primitive.',
};

const planItem = (over: Partial<PlanItem> = {}): PlanItem => ({
  planItemId: 'plan_1', targetName: 'CryptoService', targetNodeIds: [], findingIds: ['fnd_1'],
  mode: 'AUTONOMOUS_MIGRATION',
  action: 'Replace RSA key transport with ML-KEM-768',
  rationale: 'CNSA 2.0',
  expectedChanges: [{
    changeType: 'SOURCE',
    paths: ['src/main/java/pay/security/CryptoService.java'],
    description: 'swap the wrap call',
  }],
  conditions: [], risk: 'MEDIUM', order: 0,
  ...over,
});

const change = (over: Partial<MigrationChange> = {}): MigrationChange => ({
  _schemaVersion: 1, createdAt: new Date(), updatedAt: new Date(),
  changeId: 'chg_1', projectId: 'PQC-0184', migrationRunId: 'mig_1', attemptId: 'att_1',
  sequence: 1, changeType: 'SOURCE', intent: 'MIGRATION',
  summary: 's', rationale: 'r', findingIds: [], planItemIds: ['plan_1'],
  files: [{
    path: 'src/main/java/pay/security/CryptoService.java',
    operation: 'MODIFIED', linesAdded: 0, linesRemoved: 0,
  }],
  verificationOutcome: 'PENDING', appliedAt: new Date(),
  ...over,
} as MigrationChange);

const migrationRun = (over: Partial<MigrationRun> = {}): MigrationRun => ({
  _schemaVersion: 1, createdAt: new Date(), updatedAt: new Date(),
  migrationRunId: 'mig_1', projectId: 'PQC-0184',
  approval: {
    assessmentId: 'asmt_1', assessmentVersion: 1, approvedPlanItemIds: ['plan_1'],
    approvedBy: 'u', approvedAt: new Date(), acknowledgedActions: [],
  },
  branch: {
    name: 'agent/pqc/PQC-0184',
    baseCommitSha: '7c41ab9d2f1e4c8b6a5d3e2f1a0b9c8d7e6f5a4b',
    headCommitSha: HEAD, pushed: false, commitCount: 2,
  },
  stage: 'CRYPTO_VERIFYING', stageEnteredAt: new Date(), status: 'RUNNING',
  attemptCount: 1,
  metrics: {
    testsPassing: 0, testsFailing: 0, autonomousRepairs: 1,
    humanGatesOpened: 0, cloudBuildAttempts: 3,
  },
  checkpoint: { stage: 'CRYPTO_VERIFYING', at: new Date() },
  startedAt: new Date(),
  ...over,
});

/** Every input the verifier needs, green by default; each test breaks one thing. */
function inputs(over: Partial<Parameters<typeof verify>[0]> = {}) {
  const inv = inventoryOf([
    ['pay.A', [{ name: 'one' }, { name: 'two' }]],
    ['pay.B', [{ name: 'three' }]],
    ['pay.security.CryptoServiceKemTest', [{ name: 'roundTripsTheSharedSecret' }]],
  ]);
  return {
    run: migrationRun(),
    baseline: baseline(),
    policy,
    approvedItems: [planItem()],
    approvedFindings: [finding()],
    changes: [change()],
    gates: [] as HumanGate[],
    blockedFindingIds: [] as string[],
    build: execution({ executionRunId: 'exec_build', kind: 'BUILD' as const }),
    tests: { execution: execution(), inventory: inv },
    generated: {
      characterization: [] as string[],
      acceptance: ['pay.security.CryptoServiceKemTest'],
    },
    candidates: [] as Candidate[],
    verificationRunId: 'exec_verify',
    roundTrip: ROUND_TRIP_OK,
    target: 'ML-KEM-768',
    sandbox: null as SandboxDeployment | null,
    ...over,
  };
}

const sandbox = (over: Partial<SandboxDeployment> = {}): SandboxDeployment => ({
  _schemaVersion: 1, createdAt: new Date(), updatedAt: new Date(),
  sandboxDeploymentId: 'sbx_1', projectId: 'PQC-0184', migrationRunId: 'mig_1',
  imageUri: 'scripted/pqc-0184:abc', commitSha: HEAD,
  service: { name: 'proteus-sandbox-pqc-0184', region: 'test', url: 'http://127.0.0.1:1' },
  status: 'READY',
  startupCheck: { passed: true, httpStatus: 200, detail: 'answered /healthz in 2.4s', startupMs: 2400 },
  e2e: {
    executionRunId: 'exec_e2e', passed: true,
    scenarios: SETTLEMENT_SCENARIOS.map((s) => ({ name: s.name, passed: true })),
    latencyDeltaMs: 4.1,
  },
  isProduction: false,
  placement: 'CLOUD_RUN',
  ...over,
});

// ---------------------------------------------------------------------------

describe('AC-1, FR-1, FR-2 · the verdict is computed, never asserted', () => {
  it('is NOT_VERIFIED with eight of nine passing', () => {
    const outcome = verify(inputs());
    expect(outcome.overall).toBe('NOT_VERIFIED'); // sandbox not deployed yet

    const withSandbox = verify(inputs({ sandbox: sandbox() }));
    expect(withSandbox.checks).toHaveLength(9);
    expect(withSandbox.overall).toBe('VERIFIED');

    // Break exactly one and the verdict flips. Eight of nine is not eight-ninths
    // verified; spec §35 has no partial state.
    for (const check of withSandbox.checks) {
      const broken = withSandbox.checks.map(
        (c) => (c.check === check.check ? { ...c, status: 'FAIL' as const } : c),
      );
      expect(computeOverallVerdict(broken), check.check).toBe('NOT_VERIFIED');
    }
  });

  it('never lets an undeployed run claim VERIFIED', () => {
    const outcome = verify(inputs());
    const sandboxChecks = outcome.checks.filter(
      (c) => c.check === 'SANDBOX_DEPLOYMENT_SUCCESSFUL' || c.check === 'E2E_VERIFICATION_SUCCESSFUL',
    );
    // Not NOT_APPLICABLE: that status counts as satisfied, so it would let a run
    // that never started claim success. Spec §35 lists a started sandbox and a
    // passing end-to-end scenario among the conditions for VERIFIED.
    expect(sandboxChecks.every((c) => c.status === 'FAIL')).toBe(true);
    expect(outcome.overall).toBe('NOT_VERIFIED');
    // The circularity is resolved in mayDeploy, which excludes exactly these two.
    expect(mayDeploy(outcome).permitted).toBe(true);
  });

  it('covers every check the completion rule requires, exactly once', () => {
    const outcome = verify(inputs({ sandbox: sandbox() }));
    const names = outcome.checks.map((c) => c.check);
    expect(new Set(names).size).toBe(9);
    // MIGRATION_POLICY_SATISFIED is claimed by two rules and must appear once,
    // failing if either does — reporting the more forgiving one would be worthless.
    expect(names.filter((n) => n === 'MIGRATION_POLICY_SATISFIED')).toHaveLength(1);
  });
});

describe('AC-2, FR-5 · NOTED is narrative, never gating', () => {
  it('records residual crypto without touching the verdict', () => {
    const residual = [
      candidate({
        path: 'src/main/java/pay/security/SettlementSigner.java', line: 33,
        algorithm: 'SHA256withRSA', usage: 'DIGITAL_SIGNATURE',
        matchedText: 'Signature.getInstance("SHA256withRSA")',
      }),
      candidate({
        path: 'deploy/tls/pay-api.crt.md', line: 4,
        algorithm: 'RSA', usage: 'CERTIFICATE_VALIDATION',
        matchedText: 'Signature Algorithm: sha256WithRSAEncryption',
      }),
    ];
    const outcome = verify(inputs({ candidates: residual, sandbox: sandbox() }));

    expect(outcome.overall).toBe('VERIFIED');
    const noted = outcome.cryptoAssertions.filter((a) => a.status === 'NOTED');
    expect(noted).toHaveLength(2);
    // Every noted item says why it is acceptable, rather than leaving the reader
    // to reconstruct the reasoning.
    expect(noted[0]!.evidence).toMatch(/PROHIB-001|signature/i);
    expect(noted[1]!.evidence).toMatch(/PKI|certificate/i);
    // And NOTED never reaches the checks list, where it would make the
    // completion rule ambiguous.
    expect(outcome.checks.some((c) => (c.status as string) === 'NOTED')).toBe(false);
  });
});

describe('AC-3, FR-4 · absence is scoped to the approved usage', () => {
  it('leaves the untouched signature usages and the certificate passing', () => {
    // The whole rule. A naive "no RSA anywhere" check fails the CORRECT
    // migration: the fixture deliberately keeps three signature usages and an
    // RSA-signed leaf certificate.
    const outcome = verify(inputs({
      candidates: [
        candidate({ algorithm: 'SHA256withRSA', usage: 'DIGITAL_SIGNATURE',
          path: 'src/main/java/pay/security/SettlementSigner.java', line: 33 }),
        candidate({ algorithm: 'SHA256withRSA', usage: 'DIGITAL_SIGNATURE',
          path: 'src/main/java/pay/security/ApiTokenService.java', line: 41 }),
        candidate({ algorithm: 'RSA', usage: 'CERTIFICATE_VALIDATION',
          path: 'deploy/tls/pay-api.crt.md', line: 4 }),
      ],
      sandbox: sandbox(),
    }));

    const absent = outcome.checks.find((c) => c.check === 'PROHIBITED_CRYPTO_ABSENT')!;
    expect(absent.status).toBe('PASS');
    expect(outcome.overall).toBe('VERIFIED');
    expect(outcome.residual).toHaveLength(3);
    expect(outcome.residual.every((r) => r.accepted)).toBe(true);
  });

  it('fails when the approved usage itself survives', () => {
    const outcome = verify(inputs({
      candidates: [candidate()], // RSA KEY_TRANSPORT — exactly what was approved for removal
      sandbox: sandbox(),
    }));
    const absent = outcome.checks.find((c) => c.check === 'PROHIBITED_CRYPTO_ABSENT')!;
    expect(absent.status).toBe('FAIL');
    expect(absent.findings[0]!.path).toBe('src/main/java/pay/security/CryptoService.java');
    expect(outcome.overall).toBe('NOT_VERIFIED');
  });

  it('tells a signature algorithm from the primitive it is built on', () => {
    // `SHA256withRSA` and `RSA/ECB/OAEP…` share three letters and nothing else
    // that matters here.
    expect(sameFamily('RSA', 'RSA/ECB/OAEPWithSHA-256AndMGF1Padding')).toBe(true);
    expect(sameFamily('RSA', 'RSA-2048')).toBe(true);
    expect(sameFamily('RSA', 'SHA256withRSA')).toBe(false);
    expect(sameFamily('RSA', 'ECDH')).toBe(false);
  });

  it('scopes by usage as well as algorithm', () => {
    const scope = scopeOf([finding()], 'ML-KEM-768');
    expect(inScope(candidate(), scope)).toBe(true);
    // Same algorithm family, different usage — never in scope.
    expect(inScope(candidate({ usage: 'DIGITAL_SIGNATURE' }), scope)).toBe(false);
    expect(inScope(candidate({ usage: 'CERTIFICATE_VALIDATION' }), scope)).toBe(false);
  });
});

describe('AC-4, FR-3 · a PASS must cite its provenance', () => {
  it('rejects a PASS with neither an execution nor evidence', () => {
    const bare = VerificationCheckResult.safeParse({
      check: 'BUILD_SUCCESSFUL', status: 'PASS', detail: 'it looked fine', evidenceIds: [],
      findings: [],
    });
    expect(bare.success).toBe(false);
    expect(bare.error!.issues[0]!.message).toMatch(/reasoning is not proof/);

    // A FAIL needs none — the absence of a passing execution is the point.
    expect(VerificationCheckResult.safeParse({
      check: 'BUILD_SUCCESSFUL', status: 'FAIL', detail: 'no build recorded',
      evidenceIds: [], findings: [],
    }).success).toBe(true);
  });

  it('cites an execution on every check that passes', () => {
    const outcome = verify(inputs({ sandbox: sandbox() }));
    for (const check of outcome.checks.filter((c) => c.status === 'PASS')) {
      const cited = Boolean(check.executionRunId) || check.evidenceIds.length > 0;
      expect(cited, `${check.check} passed without provenance`).toBe(true);
    }
  });

  it('pins the build check to the branch head', () => {
    const stale = checkBuild(
      execution({ kind: 'BUILD', commitSha: '1111111111111111111111111111111111111111' }),
      HEAD,
    );
    // A green build from an intermediate attempt must not satisfy the check for
    // a later, different tree.
    expect(stale.status).toBe('FAIL');
    expect(stale.detail).toMatch(/not the branch head/);
    expect(checkBuild(execution({ kind: 'BUILD' }), HEAD).status).toBe('PASS');
  });
});

describe('AC-5, FR-7 · a subset relation, not a count', () => {
  it('fails when four new tests pass and four baseline tests break', () => {
    const before = baseline({
      tests: {
        executionRunId: 'e', total: 4, passed: 4, failed: 0, skipped: 0, knownFailures: [],
        inventory: ['w', 'x', 'y', 'z'].map((n) => ({
          testId: `pay.Old#${n}`, name: n, suite: 'pay.Old', status: 'PASSED' as const,
        })),
      },
    });
    const after = inventoryOf([
      ['pay.Old', [
        { name: 'w', failure: 'broke' }, { name: 'x', failure: 'broke' },
        { name: 'y', failure: 'broke' }, { name: 'z', failure: 'broke' },
      ]],
      ['pay.New', [{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' }]],
    ]);

    // The total is unchanged at 4 passing. A count-based check would say fine.
    expect(after.passed).toBe(before.tests.passed);
    const result = checkTests(before, { execution: execution(), inventory: after },
      { characterization: [], acceptance: [] });
    expect(result.result.status).toBe('FAIL');
    expect(result.regressions).toHaveLength(4);
  });

  it('never blames the migration for a failure that was already red', () => {
    const before = baseline({
      tests: {
        executionRunId: 'e', total: 2, passed: 1, failed: 1, skipped: 0,
        knownFailures: [{ testId: 'pay.A#flaky', name: 'flaky', message: 'was already red' }],
        inventory: [
          { testId: 'pay.A#ok', name: 'ok', suite: 'pay.A', status: 'PASSED' },
          { testId: 'pay.A#flaky', name: 'flaky', suite: 'pay.A', status: 'FAILED' },
        ],
      },
    });
    const after = inventoryOf([['pay.A', [{ name: 'ok' }, { name: 'flaky', failure: 'still red' }]]]);
    const result = checkTests(before, { execution: execution(), inventory: after },
      { characterization: [], acceptance: [] });
    expect(result.result.status).toBe('PASS');
    expect(result.result.detail).toMatch(/not\s+attributed to the migration/);
  });

  it('requires both kinds of generated test, since either alone proves nothing', () => {
    const inv = inventoryOf([
      ['pay.A', [{ name: 'one' }, { name: 'two' }]],
      ['pay.B', [{ name: 'three' }]],
      ['pay.CharTest', [{ name: 'pins' }]],
      ['pay.KemTest', [{ name: 'roundTrip', failure: 'not implemented' }]],
    ]);
    const result = checkTests(baseline(), { execution: execution(), inventory: inv },
      { characterization: ['pay.CharTest'], acceptance: ['pay.KemTest'] });
    // Characterization green shows behaviour preserved; acceptance red means
    // nothing changed. Passing on the first alone would be satisfiable by doing
    // nothing at all.
    expect(result.result.status).toBe('FAIL');
    expect(result.result.detail).toMatch(/acceptance suite\(s\) failing/);
  });
});

describe('AC-6, FR-8 · a mocked primitive proves nothing', () => {
  it('fails REQUIRED_PQC_PRESENT when the primitive is stubbed', () => {
    const outcome = verify(inputs({
      roundTrip: { ...ROUND_TRIP_OK, mockedPrimitive: true, detail: 'KemStub.java stubs Encaps' },
      sandbox: sandbox(),
    }));
    const pqc = outcome.checks.find((c) => c.check === 'REQUIRED_PQC_PRESENT')!;
    expect(pqc.status).toBe('FAIL');
    expect(pqc.detail).toMatch(/mocked, so nothing was proved/);
    expect(outcome.overall).toBe('NOT_VERIFIED');
  });

  it('fails when the provider resolved a different parameter set', () => {
    // FIPS 203's fixed sizes are what make a silent ML-KEM-512 observable.
    const outcome = verify(inputs({
      roundTrip: { ...ROUND_TRIP_OK, parameterSetResolved: 'ML-KEM-512' },
      sandbox: sandbox(),
    }));
    const pqc = outcome.checks.find((c) => c.check === 'REQUIRED_PQC_PRESENT')!;
    expect(pqc.status).toBe('FAIL');
    expect(pqc.detail).toMatch(/resolved ML-KEM-512, not the approved ML-KEM-768/);
  });

  it('fails when nothing exercised the primitive at all', () => {
    const outcome = verify(inputs({
      roundTrip: {
        executed: false, sharedSecretsMatch: false, mockedPrimitive: false,
        detail: 'No test exercising encapsulation ran.',
      },
      sandbox: sandbox(),
    }));
    expect(outcome.checks.find((c) => c.check === 'REQUIRED_PQC_PRESENT')!.status).toBe('FAIL');
  });
});

describe('AC-7, FR-9 · the approved scope is checked against the diff', () => {
  it('flags a file the plan never declared', () => {
    const outcome = checkScope([
      change(),
      change({
        changeId: 'chg_2', sequence: 2,
        files: [{
          path: 'src/main/java/pay/store/LedgerRepository.java',
          operation: 'MODIFIED', linesAdded: 0, linesRemoved: 0,
        }],
      }),
    ], [planItem()]);

    expect(outcome.result.status).toBe('FAIL');
    expect(outcome.breaches.map((b) => b.path))
      .toEqual(['src/main/java/pay/store/LedgerRepository.java']);
  });

  it('exempts test engineering, which the plan does not declare paths for', () => {
    // The plan declares what the MIGRATION will change. Holding generated tests
    // to that list would make writing them a scope breach.
    const outcome = checkScope([
      change(),
      change({
        changeId: 'chg_t', sequence: 2, intent: 'TEST_ENGINEERING', changeType: 'TEST',
        testIntegrity: {
          failureClassification: 'TEST_COVERAGE_GAP', reason: 'r',
          baselineRequirementChanged: false, safeAutonomousModification: true,
        },
        files: [{
          path: 'src/test/java/pay/security/CryptoServiceKemTest.java',
          operation: 'ADDED', linesAdded: 0, linesRemoved: 0,
        }],
      }),
    ], [planItem()]);
    expect(outcome.result.status).toBe('PASS');
  });

  it('honours a declared glob', () => {
    expect(toPattern('src/main/java/pay/security/*.java')
      .test('src/main/java/pay/security/CryptoService.java')).toBe(true);
    expect(toPattern('src/main/java/pay/security/*.java')
      .test('src/main/java/pay/security/inner/X.java')).toBe(false);
    expect(toPattern('src/**/*.java').test('src/main/java/pay/A.java')).toBe(true);
  });
});

describe('AC-8, FR-10 · deployment is gated on the verdict', () => {
  it('refuses to deploy while a pre-deployment check fails', () => {
    const failing = verify(inputs({ candidates: [candidate()] }));
    const permission = mayDeploy(failing);
    expect(permission.permitted).toBe(false);
    // Spec §35 — deploying first would put an unverified build behind a URL the
    // user is invited to trust.
    expect(permission.reason).toMatch(/EXEC-REP-004 refuses/);
    expect(permission.reason).toMatch(/PROHIBITED_CRYPTO_ABSENT/);
  });

  it('permits deployment on the pre-deployment checks alone', () => {
    // The two sandbox checks are excluded here for the obvious reason: they are
    // what deployment would establish.
    const permission = mayDeploy(verify(inputs()));
    expect(permission.permitted).toBe(true);
    expect(permission.reason).toMatch(/EXEC-REP-004 permits/);
  });
});

describe('FR-6 · invariants: assert the promises, report the predictions', () => {
  const wrapped = invariant({
    invariantId: 'inv_len', kind: 'MESSAGE_FORMAT',
    description: 'The wrapped session key is 256 bytes',
    assertion: 'assertEquals(256, wrapped.length);',
    disposition: 'EXPECTED_TO_CHANGE',
  });

  it('records an expected change before and after, without failing', () => {
    const inv = inventoryOf([
      ['pay.A', [{ name: 'one' }, { name: 'two' }]],
      ['pay.Handshake', [{ name: 'wraps', failure: 'expected: <256> but was: <1088>' }]],
    ]);
    const result = checkInvariants(
      baseline({ invariants: [invariant(), wrapped] }),
      { execution: execution(), inventory: inv },
      implicatedBy(inv),
    );
    // The ciphertext growing from 256 to 1088 is the migration working.
    expect(result.result.status).toBe('PASS');
    expect(result.broken).toHaveLength(0);
    expect(result.changed[0]!.observedAfter).toBe('1088 (was 256)');
  });

  it('fails when a must-preserve invariant breaks', () => {
    const inv = inventoryOf([
      ['pay.Controller', [{ name: 'accepts', failure: 'assertEquals(201, response.getStatusCode());' }]],
    ]);
    const result = checkInvariants(
      baseline(), { execution: execution(), inventory: inv }, implicatedBy(inv),
    );
    expect(result.result.status).toBe('FAIL');
    expect(result.broken[0]!.invariantId).toBe('inv_1');
  });

  it('records an expected change that did not happen, which is also information', () => {
    const inv = inventoryOf([['pay.A', [{ name: 'one' }]]]);
    const result = checkInvariants(
      baseline({ invariants: [wrapped] }),
      { execution: execution(), inventory: inv },
      implicatedBy(inv),
    );
    expect(result.changed[0]!.observedAfter).toBe('unchanged');
  });
});

describe('FR-9 · blockers exclude recommendations by design', () => {
  it('ignores a non-blocking gate and an owned recommendation', () => {
    const gates: HumanGate[] = [{
      _schemaVersion: 1, createdAt: new Date(), updatedAt: new Date(),
      gateId: 'g1', projectId: 'PQC-0184', type: 'RETRY_BUDGET_EXHAUSTED',
      blocking: false, title: 'Four attempts', question: 'q', context: 'c',
      evidenceIds: [], relatedFindingIds: [], relatedChangeIds: [],
      options: [{ optionId: 'ACKNOWLEDGE', label: 'ok' }],
      status: 'OPEN', openedAt: new Date(),
    }];
    // The HSM and the OT gateway were never in the approved scope. Blocking on
    // them would make a correct, fully-delivered migration unverifiable.
    const result = checkBlockers(gates, [], 'exec_verify');
    expect(result.status).toBe('PASS');
    expect(result.detail).toMatch(/non-blocking gate\(s\) remain open/);
  });

  it('fails on an open blocking gate', () => {
    const gates: HumanGate[] = [{
      _schemaVersion: 1, createdAt: new Date(), updatedAt: new Date(),
      gateId: 'g2', projectId: 'PQC-0184', type: 'BASELINE_CONTRACT_CHANGE',
      blocking: true, title: 'Invariant broken', question: 'q', context: 'c',
      evidenceIds: [], relatedFindingIds: [], relatedChangeIds: [],
      options: [{ optionId: 'ACCEPT_CHANGE', label: 'ok' }],
      status: 'OPEN', openedAt: new Date(),
    }];
    expect(checkBlockers(gates, [], 'exec_verify').status).toBe('FAIL');
  });
});

describe('FR-11, FR-12 · the sandbox is exercised, and never called production', () => {
  let server: Server;
  let url: string;
  let started = false;

  beforeEach(async () => {
    started = false;
    server = createServer((req, res) => {
      const send = (status: number, body: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      // The container takes a moment to come up, like a real one.
      if (req.url === '/healthz') {
        if (!started) { res.writeHead(503); res.end('starting'); return; }
        res.writeHead(200); res.end('ok'); return;
      }
      if (req.url === '/settlements' && req.method === 'POST') {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          const parsed = JSON.parse(body || '{}') as { merchantId?: string };
          if (!parsed.merchantId) return send(400, { error: 'malformed' });
          send(201, { keyEstablishment: 'ML-KEM-768', wrappedKeyBytes: 1088 });
        });
        return;
      }
      if (req.url === '/') { res.writeHead(200); res.end('<html>ML-KEM-768</html>'); return; }
      res.writeHead(404); res.end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address();
    url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('waits for the service to become healthy rather than sleeping', async () => {
    setTimeout(() => { started = true; }, 300);
    const probe = await probeStartup(url, { timeoutMs: 5000, intervalMs: 50 });
    expect(probe.passed).toBe(true);
    expect(probe.httpStatus).toBe(200);
    // A container that starts in a moment should not cost a fixed thirty seconds.
    expect(probe.startupMs).toBeLessThan(3000);
  });

  it('reports the status it was actually getting when it never starts', async () => {
    const probe = await probeStartup(url, { timeoutMs: 400, intervalMs: 50 });
    expect(probe.passed).toBe(false);
    expect(probe.httpStatus).toBe(503);
    expect(probe.detail).toMatch(/did not become healthy/);
  });

  it('runs the settlement scenarios against the deployed URL', async () => {
    started = true;
    const outcome = await runScenarios(url, SETTLEMENT_SCENARIOS);
    expect(outcome.passed).toBe(true);
    expect(outcome.scenarios).toHaveLength(3);
    // The point of the check: a 201 proves the endpoint works, the mechanism it
    // names proves the migration reached the running system.
    expect(outcome.scenarios[0]!.detail).toContain('ML-KEM-768');
    // The rejection is part of the acquirer contract — a migration that turns it
    // into an acceptance passes every happy-path test.
    expect(outcome.scenarios[1]!.passed).toBe(true);
  });

  it('runs every scenario even after one fails', async () => {
    started = true;
    const outcome = await runScenarios(url, [
      { name: 'missing', method: 'GET', path: '/nope', expectStatus: 200 },
      ...SETTLEMENT_SCENARIOS,
    ]);
    expect(outcome.passed).toBe(false);
    // Stopping at the first failure reports one problem when there may be three.
    expect(outcome.scenarios).toHaveLength(4);
    expect(outcome.scenarios.filter((s) => s.passed)).toHaveLength(3);
  });

  it('marks the deployment as not production, in the data', () => {
    const deployment = sandbox();
    // A literal on the document, so every surface labels from the field rather
    // than from a caption someone could forget to write.
    expect(deployment.isProduction).toBe(false);
    expect(sandboxServiceName('PQC-0184')).toBe('proteus-sandbox-pqc-0184');
  });
});

describe('AC-10 · the reference scenario ends verified', () => {
  it('verifies, deploys, passes end to end, and leaves nothing for a human', async () => {
    const server = createServer((req, res) => {
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
    const sandboxUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

    try {
      const { project, run } = await approvedProject(repo.baseCommitSha);
      await repo.write(
        'src/test/java/pay/PartnerHandshakeMock.java',
        'package pay;\nclass PartnerHandshakeMock {\n'
        + '  String keyType() { return "RSA_PUBLIC_KEY"; }\n}\n',
      );

      const runs = referenceExecutions();
      let call = 0;
      const executor = {
        environment: 'CLOUD_BUILD' as const,
        async run() {
          const a = runs[Math.min(call++, runs.length - 1)]!;
          return {
            exitCode: a.exitCode ?? 0,
            status: (a.exitCode ?? 0) === 0 ? 'SUCCESS' as const : 'FAILURE' as const,
            log: a.log ?? '', logExcerpt: (a.log ?? '').split('\n').filter(Boolean),
            durationMs: 1000, reports: a.reports ?? [], provider: {},
          };
        },
      };

      const outcome = await runTestEngineering(project, run, {
        repos: t.repos, projects: null as never, engine,
        model: referenceModel(),
        executor,
        deployer: new ScriptedDeployer(sandboxUrl),
        blobs: new InMemoryBlobStore(),
        logger, workdir: repo.dir,
      });

      const verification = outcome.verification!;
      if (verification.outcome.overall !== 'VERIFIED') {
        // Print what actually failed, so a regression here says why rather than
        // just which string differed.
        throw new Error(verification.result.checks
          .filter((c) => c.status === 'FAIL')
          .map((c) => `${c.check}: ${c.detail}`).join('\n'));
      }
      expect(verification.outcome.overall).toBe('VERIFIED');

      // The sandbox exists, started, and answered the scenarios.
      expect(verification.sandbox!.status).toBe('READY');
      expect(verification.sandbox!.startupCheck?.passed).toBe(true);
      expect(verification.sandbox!.e2e?.passed).toBe(true);
      expect(verification.sandbox!.isProduction).toBe(false);

      const stored = (await t.repos.projects.byId(project.projectId))!;
      // PRD-14 advances SANDBOX_READY → COMPLETED once the evidence package
      // exists, which is what EXEC-VER-013 requires before a migration may be
      // reported complete. Verification's own contribution is the verdict.
      expect(stored.stage).toBe('COMPLETED');
      expect(stored.summary.verificationComplete).toBe(true);
      expect(stored.summary.sandboxDeployed).toBe(true);
      expect(stored.summary.sandboxUrl).toBe(sandboxUrl);
      // The claim the whole product rests on.
      expect(stored.summary.autonomy.humanEngineeringActions).toBe(0);
      expect(stored.summary.autonomy.completionPct).toBe(100);
      expect(stored.summary.autonomy.approvals).toBe(0); // approved in PRD-10's flow

      expect(await t.repos.humanGates.count()).toBe(0);

      const events = await t.repos.events.since(project.projectId, 0);
      const types = events.map((e) => e.type);
      expect(types).toContain('CRYPTO_VERIFICATION_STARTED');
      expect(types).toContain('CRYPTO_VERIFICATION_PASSED');
      expect(types).toContain('SANDBOX_DEPLOYMENT_READY');
      expect(types).toContain('E2E_TEST_PASSED');
      expect(types).toContain('MIGRATION_COMPLETED');

      const ready = events.find((e) => e.type === 'SANDBOX_DEPLOYMENT_READY')!;
      expect(ready.message).toContain('not production');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 90_000);
});

// ---------------------------------------------------------------------------

async function approvedProject(baseCommitSha: string) {
  const project = await t.repos.projects.create(aProject({
    stage: 'MIGRATING',
    summary: { ...aProject().summary, migrationApproved: true, discoveryComplete: true },
  }) as never);
  const now = new Date();
  await t.repos.migrationPolicies.insert(policy);

  const assessment = {
    _schemaVersion: 1, createdAt: now, updatedAt: now,
    assessmentId: `asmt_${project.projectId}_v1`, projectId: project.projectId, version: 1,
    summary: {
      headline: 'h', whatExists: 'a', whatIsVulnerable: 'b',
      whatAgentWillChange: 'c', whatAgentWillNotChange: 'd',
    },
    snapshot: {
      findingIds: ['fnd_1'], recommendationIds: [], graphNodeIds: [], graphEdgeIds: [],
      inputFileIds: [], repoCommitSha: baseCommitSha,
    },
    planItems: [planItem()],
    policyId: policy.policyId, status: 'APPROVED' as const, generatedAt: now,
  };
  await t.repos.assessments.insert(assessment as never);
  await t.repos.findings.insert(finding({ projectId: project.projectId }) as never);

  const run: MigrationRun = migrationRun({
    migrationRunId: `mig_${project.projectId}_v1`,
    projectId: project.projectId,
    approval: {
      assessmentId: assessment.assessmentId, assessmentVersion: 1,
      approvedPlanItemIds: ['plan_1'], approvedBy: 'firebase-uid-1', approvedAt: now,
      acknowledgedActions: ['create a migration branch'],
    },
    branch: {
      name: migrationBranchName(project.projectId), baseCommitSha, pushed: false, commitCount: 0,
    },
    stage: 'PREPARING_MIGRATION',
    metrics: {
      testsPassing: 0, testsFailing: 0, autonomousRepairs: 0,
      humanGatesOpened: 0, cloudBuildAttempts: 0,
    },
    checkpoint: { stage: 'PREPARING_MIGRATION', at: now },
  });
  await t.repos.migrationRuns.insert(run);
  return { project, run };
}

/** Baseline green · patch green · verification green. */
function referenceExecutions() {
  const green = [
    surefireReport('pay.security.SettlementSignerTest', [{ name: 'signs' }]),
    surefireReport('pay.security.CryptoServiceKemTest', [
      { name: 'roundTripsTheSharedSecret' }, { name: 'producesFips203Sizes' },
    ]),
    failsafeReport('pay.PartnerHandshakeIntegrationTest', [
      { name: 'completesTheHandshakeWithTheAcquirer' },
    ]),
  ];
  return [
    { exitCode: 0, log: 'BUILD SUCCESS' },
    {
      exitCode: 0, log: 'BUILD SUCCESS',
      reports: [surefireReport('pay.security.SettlementSignerTest', [{ name: 'signs' }])],
    },
    { exitCode: 0, log: 'BUILD SUCCESS', reports: green },
    { exitCode: 0, log: 'BUILD SUCCESS', reports: green },
  ];
}

function referenceModel() {
  return new ScriptedModel({
    'baseline-invariants': {
      invariants: [{
        kind: 'API_BEHAVIOR',
        description: 'POST /settlements accepts a valid advice',
        assertion: 'assertEquals(201, response.getStatusCode());',
        capturedFrom: 'EXISTING_TEST',
      }],
    },
    'coverage-assessment': { components: [] },
    'generate-tests': { artifacts: [] },
    'migration-patch': {
      planItemId: 'plan_1', changeType: 'SOURCE',
      summary: 'Migrate CryptoService to ML-KEM-768',
      rationale: 'CNSA 2.0 requires ML-KEM for key establishment',
      findingIds: ['fnd_1'],
      files: [{
        path: 'src/main/java/pay/security/CryptoService.java', operation: 'MODIFIED',
        content: 'package pay.security;\n\npublic class CryptoService {\n'
          + '  // ML-KEM-768 encapsulation\n}\n',
      }],
    },
  });
}
