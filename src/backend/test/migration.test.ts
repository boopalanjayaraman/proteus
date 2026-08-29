import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import type { Assessment, MigrationRun, PlanItem } from '@proteus/schema';
import { ScriptedModel } from '../src/agent/model';
import { RuleEngine } from '../src/core/rules/engine';
import {
  SOURCE_MUTATING_TOOL_NAMES, TEST_ENGINEERING_TOOL_NAMES, mutatesSource,
} from '../src/agent/tools/registry';
import { BaselineNotCapturable, BaselineService, commandsFor } from '../src/core/migration/baseline';
import {
  DEFAULT_DISPOSITION, classifyAll, isExecutable,
} from '../src/core/migration/invariants';
import {
  guardTestArtifact, validateAgainstBase, type ProposedTestArtifact,
} from '../src/core/migration/testGuard';
import { parseReports } from '../src/core/migration/testReports';
import { ScriptedExecutor, excerpt } from '../src/integrations/cloudbuild/executor';
import { GitWriter, migrationBranchName, safeJoin } from '../src/integrations/github/writer';
import { runTestEngineering } from '../src/worker/migrationJob';
import { InMemoryBlobStore } from '../src/integrations/storage/blobs';
import { aProject, clearAll, startTestDb, type TestDb } from './helpers/mongo';
import { failsafeReport, makeTestRepo, surefireReport, type TestRepo } from './helpers/repo';

/** PRD-11 acceptance criteria — everything that happens before a line moves. */

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
// Fixtures
// ---------------------------------------------------------------------------

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

/** A project already through approval, with a run pinned to the repo's base commit. */
async function approvedProject(baseCommitSha: string) {
  const project = await t.repos.projects.create(aProject({
    stage: 'MIGRATING',
    summary: { ...aProject().summary, migrationApproved: true, discoveryComplete: true },
  }) as never);
  const now = new Date();

  const assessment: Assessment = {
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
    policyId: 'policy_mlkem_v1', status: 'APPROVED', generatedAt: now,
  };
  await t.repos.assessments.insert(assessment);

  const run: MigrationRun = {
    _schemaVersion: 1, createdAt: now, updatedAt: now,
    migrationRunId: `mig_${project.projectId}_v1`, projectId: project.projectId,
    approval: {
      assessmentId: assessment.assessmentId, assessmentVersion: 1,
      approvedPlanItemIds: ['plan_1'], approvedBy: 'firebase-uid-1', approvedAt: now,
      acknowledgedActions: ['create a migration branch'],
    },
    branch: {
      name: migrationBranchName(project.projectId), baseCommitSha,
      pushed: false, commitCount: 0,
    },
    stage: 'PREPARING_MIGRATION', stageEnteredAt: now, status: 'RUNNING',
    attemptCount: 0,
    metrics: {
      testsPassing: 0, testsFailing: 0, autonomousRepairs: 0,
      humanGatesOpened: 0, cloudBuildAttempts: 0,
    },
    checkpoint: { stage: 'PREPARING_MIGRATION', at: now },
    startedAt: now,
  };
  await t.repos.migrationRuns.insert(run);
  return { project, run, assessment };
}

const GOOD_ACCEPTANCE_TEST = `package pay.security;

import static org.junit.jupiter.api.Assertions.*;
import org.junit.jupiter.api.Test;

class CryptoServiceKemTest {
  @Test
  void producesFips203Sizes() throws Exception {
    var kp = MlKem.generateKeyPair("ML-KEM-768");
    assertEquals(1184, kp.getPublic().getEncoded().length);
    assertEquals(1088, MlKem.encapsulate(kp.getPublic()).ciphertext().length);
  }

  @Test
  void roundTripsTheSharedSecret() throws Exception {
    var kp = MlKem.generateKeyPair("ML-KEM-768");
    var enc = MlKem.encapsulate(kp.getPublic());
    assertArrayEquals(enc.secret(), MlKem.decapsulate(kp.getPrivate(), enc.ciphertext()));
  }
}
`;

const INTEGRITY = {
  failureClassification: 'TEST_COVERAGE_GAP' as const,
  reason: 'No test exercises key transport.',
  baselineRequirementChanged: false,
  safeAutonomousModification: true,
};

/** The model's answers for a complete, well-behaved run. */
const scriptedAgent = () => new ScriptedModel({
  'baseline-invariants': {
    invariants: [
      {
        kind: 'API_BEHAVIOR',
        description: 'POST /settlements accepts a valid advice',
        assertion: 'assertEquals(201, response.getStatusCode());',
        capturedFrom: 'EXISTING_TEST',
      },
      {
        kind: 'FAILURE_MODE',
        description: 'A malformed advice is rejected',
        assertion: 'assertEquals(400, malformedResponse.getStatusCode());',
        capturedFrom: 'EXISTING_TEST',
      },
      {
        kind: 'CRYPTO_OUTCOME',
        description: 'Key establishment succeeds with the acquirer',
        assertion: 'assertNotNull(handshake.sharedSecret());',
        capturedFrom: 'EXISTING_TEST',
      },
      {
        kind: 'MESSAGE_FORMAT',
        description: 'The wrapped session key is 256 bytes',
        assertion: 'assertEquals(256, wrapped.length);',
        capturedFrom: 'EXISTING_TEST',
      },
      {
        // EXEC-INV-004 — dropped, not repaired.
        kind: 'FUNCTIONAL_OUTCOME',
        description: 'Settlements are recorded correctly',
        assertion: 'the ledger should be right',
        capturedFrom: 'RUNTIME_OBSERVATION',
      },
    ],
  },
  'coverage-assessment': {
    components: [{
      component: 'CryptoService', path: 'src/main/java/pay/security/CryptoService.java',
      covered: false, reasoning: 'CryptoServiceTest never calls wrapSessionKey.',
    }],
  },
  // The loop that follows is PRD-12's; this test asserts on what test
  // engineering produced, so the patch only has to be well-formed.
  'migration-patch': {
    planItemId: 'plan_1',
    changeType: 'SOURCE',
    summary: 'Migrate CryptoService to ML-KEM-768',
    rationale: 'CNSA 2.0 requires it',
    findingIds: ['fnd_1'],
    files: [{
      path: 'src/main/java/pay/security/CryptoService.java',
      operation: 'MODIFIED',
      content: 'package pay.security;\n\npublic class CryptoService {\n'
        + '  // ML-KEM-768 key establishment\n}\n',
    }],
  },
  'generate-tests': {
    artifacts: [
      {
        path: 'src/test/java/pay/security/CryptoServiceKemTest.java',
        changeType: 'TEST', testKind: 'MIGRATION_ACCEPTANCE_TEST',
        content: GOOD_ACCEPTANCE_TEST,
        summary: 'Assert ML-KEM-768 sizes and round trip',
        rationale: 'EXEC-TEST-003 and EXEC-TEST-005',
        findingIds: ['fnd_1'], planItemIds: ['plan_1'],
        testIntegrity: INTEGRITY,
      },
      {
        // Refused: mocks the primitive under migration (AC-6).
        path: 'src/test/java/pay/security/KemStub.java',
        changeType: 'MOCK', testKind: 'MOCK',
        content: 'when(kem.encapsulate(any())).thenReturn(FIXED_SECRET);',
        summary: 'Stub the KEM so the suite is fast',
        rationale: 'speed',
        mockTarget: 'KEM_ENCAPSULATION',
        findingIds: [], planItemIds: [],
        testIntegrity: INTEGRITY,
      },
      {
        // Refused: asserts implicit rejection throws (AC-5).
        path: 'src/test/java/pay/security/TamperTest.java',
        changeType: 'TEST', testKind: 'MIGRATION_ACCEPTANCE_TEST',
        content: 'byte[] tampered = flip(ciphertext);\n'
          + 'assertThrows(GeneralSecurityException.class, () -> decapsulate(sk, tampered));',
        summary: 'Reject a tampered ciphertext',
        rationale: 'input validation',
        findingIds: [], planItemIds: [],
        testIntegrity: INTEGRITY,
      },
      {
        // Refused: no testIntegrity record (AC-7).
        path: 'src/test/java/pay/PartnerHandshakeMock.java',
        changeType: 'MOCK', testKind: 'MOCK',
        content: 'class PartnerHandshakeMock { String keyType() { return "ML_KEM_PUBLIC_KEY"; } }',
        summary: 'Teach the partner simulator the new key type',
        rationale: 'EXEC-MOCK-003',
        mockTarget: 'PROTOCOL_COUNTERPART',
        findingIds: [], planItemIds: [],
      },
    ],
  },
});

/** Baseline green, then the new acceptance test failing at base — as it must. */
const scriptedExecutor = () => new ScriptedExecutor([
  { match: /package/, exitCode: 0, log: '[INFO] BUILD SUCCESS' },
  {
    match: /verify/,
    exitCode: 0,
    log: '[INFO] Tests run: 3, Failures: 0\n[INFO] BUILD SUCCESS',
    reports: [
      surefireReport('pay.security.SettlementSignerTest', [
        { name: 'signsASettlement' }, { name: 'rejectsAnUnknownKey' },
      ]),
      failsafeReport('pay.PartnerHandshakeIntegrationTest', [
        { name: 'completesTheHandshakeWithTheAcquirer' },
      ]),
    ],
  },
]);

// ---------------------------------------------------------------------------

describe('AC-1, FR-1 · the original branch is never written', () => {
  it('branches from the approved base commit and leaves main untouched', async () => {
    const before = await repo.shaOf('main');
    const git = new GitWriter(repo.dir, 'agent/pqc/PQC-0184');
    const branch = await git.createBranch(repo.baseCommitSha);

    expect(branch.branch).toBe('agent/pqc/PQC-0184');
    expect(branch.baseCommitSha).toBe(repo.baseCommitSha);

    await git.writeFile('src/test/java/pay/NewTest.java', 'class NewTest {}');
    await git.commit('test: add', ['src/test/java/pay/NewTest.java']);

    // main is byte-identical, and the new file exists only on the branch.
    expect(await repo.shaOf('main')).toBe(before);
    expect(await repo.filesAt('main')).not.toContain('src/test/java/pay/NewTest.java');
    expect(await repo.filesAt('agent/pqc/PQC-0184'))
      .toContain('src/test/java/pay/NewTest.java');
  });

  it('refuses to commit when the migration branch is not checked out', async () => {
    const git = new GitWriter(repo.dir, 'agent/pqc/PQC-0184');
    await git.createBranch(repo.baseCommitSha);
    await git.writeFile('x.txt', 'x');

    // Someone, or something, switched back. The guarantee cannot depend on the
    // caller having sequenced this correctly.
    const { execFile } = await import('node:child_process');
    await new Promise((res) => execFile('git', ['-C', repo.dir, 'checkout', 'main'], res));

    await expect(git.commit('test: add', ['x.txt'])).rejects.toThrow(/writes are confined to/);
  });

  it('refuses a path that escapes the working copy', () => {
    expect(() => safeJoin(repo.dir, '../../etc/passwd')).toThrow(/escapes the working copy/);
    expect(() => safeJoin(repo.dir, '/etc/passwd')).toThrow(/absolute path refused/);
    expect(() => safeJoin(repo.dir, '.git/config')).toThrow(/inside \.git/);
    expect(safeJoin(repo.dir, 'src/test/A.java')).toContain('src/test/A.java');
  });
});

describe('AC-2, FR-2, FR-3 · the baseline is what actually ran', () => {
  it('records the inventory and the pre-existing failures as known', async () => {
    const { run } = await approvedProject(repo.baseCommitSha);
    const executor = new ScriptedExecutor([
      { match: /package/, exitCode: 0, log: 'BUILD SUCCESS' },
      {
        match: /verify/, exitCode: 1, log: 'BUILD FAILURE',
        reports: [
          surefireReport('pay.security.SettlementSignerTest', [
            { name: 'signs' }, { name: 'rejects' }, { name: 'skipped', skipped: true },
          ]),
          failsafeReport('pay.PartnerHandshakeIntegrationTest', [
            { name: 'completesTheHandshake', failure: 'Unsupported key exchange' },
          ]),
        ],
      },
    ]);

    const baselines = new BaselineService(t.repos, executor, new InMemoryBlobStore());
    const result = await baselines.capture({
      run, workdir: repo.dir, commands: commandsFor('Maven')!, invariants: [],
    });

    // The counts come from the XML, not from Maven's summary line.
    expect(result.inventory.total).toBe(4);
    expect(result.inventory.unit).toBe(3);
    expect(result.inventory.integration).toBe(1);
    expect(result.baseline.tests.skipped).toBe(1);

    // EXEC-INV-002 — inherited, and named, so verification can subtract it.
    expect(result.baseline.tests.knownFailures).toHaveLength(1);
    expect(result.baseline.tests.knownFailures[0]!.testId)
      .toBe('pay.PartnerHandshakeIntegrationTest#completesTheHandshake');
    expect(result.baseline.tests.knownFailures[0]!.message).toContain('Unsupported key exchange');

    // Both executions are recorded — the evidence behind the checklist.
    const executions = await t.repos.executionRuns.find({ projectId: run.projectId } as never);
    expect(executions.map((e) => e.kind).sort()).toEqual(['BASELINE_BUILD', 'BASELINE_TEST']);
  });

  it('records a base commit that does not build rather than crashing', async () => {
    const { run } = await approvedProject(repo.baseCommitSha);
    const executor = new ScriptedExecutor([
      { exitCode: 1, log: '[ERROR] COMPILATION ERROR\nBUILD FAILURE', reports: [] },
    ]);
    const baselines = new BaselineService(t.repos, executor, new InMemoryBlobStore());

    const result = await baselines.capture({
      run, workdir: repo.dir, commands: commandsFor('Maven')!, invariants: [],
    });
    // Risk 4: a broken base commit is a finding about the repository. Crashing
    // on it would tell the user nothing.
    expect(result.buildPassed).toBe(false);
    expect(result.baseline.tests.total).toBe(0);
  });

  it('refuses to capture a baseline once the tree has already changed', async () => {
    const { run } = await approvedProject(repo.baseCommitSha);
    await t.repos.migrationChanges.insert({
      _schemaVersion: 1, createdAt: new Date(), updatedAt: new Date(),
      changeId: 'chg_1', projectId: run.projectId, migrationRunId: run.migrationRunId,
      attemptId: 'att_1', sequence: 1, changeType: 'SOURCE', intent: 'MIGRATION',
      summary: 's', rationale: 'r', findingIds: [], planItemIds: [], files: [],
      verificationOutcome: 'PENDING', appliedAt: new Date(),
    } as never);

    const baselines = new BaselineService(t.repos, new ScriptedExecutor([{}]), new InMemoryBlobStore());
    await expect(baselines.capture({
      run, workdir: repo.dir, commands: commandsFor('Maven')!, invariants: [],
    })).rejects.toThrow(BaselineNotCapturable);
  });

  it('reads a self-closing pass and a nested failure out of real Surefire XML', () => {
    const inv = parseReports([
      surefireReport('pay.A', [{ name: 'ok' }, { name: 'bad', failure: 'expected 256 but was 1088' }]),
    ]);
    expect(inv.passed).toBe(1);
    expect(inv.failed).toBe(1);
    const failed = inv.tests.find((x) => x.status === 'FAILED')!;
    expect(failed.message).toBe('expected 256 but was 1088');
    expect(failed.stackHead).toMatch(/^at pay\.A\.bad/);
  });
});

describe('AC-3, FR-4, FR-5, FR-6 · invariants are classified by rule', () => {
  it('defaults MESSAGE_FORMAT to expected-to-change and everything else to preserve', () => {
    expect(DEFAULT_DISPOSITION.MESSAGE_FORMAT).toBe('EXPECTED_TO_CHANGE');
    expect(DEFAULT_DISPOSITION.API_BEHAVIOR).toBe('MUST_PRESERVE');
    expect(DEFAULT_DISPOSITION.FAILURE_MODE).toBe('MUST_PRESERVE');
    expect(DEFAULT_DISPOSITION.CRYPTO_OUTCOME).toBe('MUST_PRESERVE');
    expect(DEFAULT_DISPOSITION.FUNCTIONAL_OUTCOME).toBe('MUST_PRESERVE');
  });

  it('classifies the wrapped-key length as expected to change, not a regression', () => {
    const { classified } = classifyAll([
      {
        kind: 'MESSAGE_FORMAT', description: 'The wrapped session key is 256 bytes',
        assertion: 'assertEquals(256, wrapped.length);', capturedFrom: 'EXISTING_TEST',
      },
      {
        // Same fact arriving as a crypto outcome. RSA-2048 wraps to 256 and
        // ML-KEM-768 produces 1088, so preserving it would block a correct
        // migration whichever kind the model chose.
        kind: 'CRYPTO_OUTCOME', description: 'Ciphertext length is 256 bytes',
        assertion: 'assertEquals(256, ciphertext.length);', capturedFrom: 'EXISTING_TEST',
      },
    ], 'PQC-0184');

    expect(classified.map((c) => c.invariant.disposition))
      .toEqual(['EXPECTED_TO_CHANGE', 'EXPECTED_TO_CHANGE']);
    expect(classified[1]!.override?.reason).toMatch(/EXEC-INV-003 exception/);
  });

  it('keeps key establishment itself as must-preserve', () => {
    const { classified } = classifyAll([{
      kind: 'CRYPTO_OUTCOME', description: 'Key establishment succeeds with a valid peer',
      assertion: 'assertNotNull(handshake.sharedSecret());', capturedFrom: 'EXISTING_TEST',
    }], 'PQC-0184');
    // The exception covers the algorithm identifier and the encoding — not
    // whether the handshake works at all.
    expect(classified[0]!.invariant.disposition).toBe('MUST_PRESERVE');
  });

  it('ignores an unreasoned attempt to downgrade a failure mode', () => {
    const { classified } = classifyAll([{
      kind: 'FAILURE_MODE', description: 'A malformed advice is rejected',
      assertion: 'assertEquals(400, response.getStatusCode());',
      capturedFrom: 'EXISTING_TEST',
      proposedDisposition: 'EXPECTED_TO_CHANGE',
    }], 'PQC-0184');
    // A migration that turns a rejection into an acceptance passes every
    // happy-path test, so this is the one that must not slip.
    expect(classified[0]!.invariant.disposition).toBe('MUST_PRESERVE');
    expect(classified[0]!.override).toBeUndefined();
  });

  it('honours a reasoned override where the rule allows one', () => {
    const { classified } = classifyAll([{
      kind: 'MESSAGE_FORMAT', description: 'The settlement advice envelope shape',
      assertion: 'assertEquals(EXPECTED_ENVELOPE, actual.toJson());',
      capturedFrom: 'EXISTING_TEST',
      proposedDisposition: 'MUST_PRESERVE',
      overrideReason: 'The acquirer depends on this shape under a published API contract.',
    }], 'PQC-0184');
    expect(classified[0]!.invariant.disposition).toBe('MUST_PRESERVE');
    expect(classified[0]!.override?.from).toBe('EXPECTED_TO_CHANGE');
  });

  it('drops an invariant that is prose rather than an assertion', () => {
    expect(isExecutable('the ledger should be right')).toBe(false);
    expect(isExecutable('assertEquals(201, response.getStatusCode());')).toBe(true);

    const { classified, rejected } = classifyAll([
      {
        kind: 'FUNCTIONAL_OUTCOME', description: 'Settlements are recorded correctly',
        assertion: 'the ledger should be right', capturedFrom: 'RUNTIME_OBSERVATION',
      },
    ], 'PQC-0184');

    // Dropped, not repaired. Inventing an assertion would put a check into the
    // contract that nothing observed.
    expect(classified).toHaveLength(0);
    expect(rejected[0]!.reason).toMatch(/EXEC-INV-004|executable assertion/);
  });
});

describe('AC-5, FR-10 · the implicit-rejection trap', () => {
  const artifact = (content: string): ProposedTestArtifact => ({
    path: 'src/test/java/pay/KemTest.java', changeType: 'TEST',
    testKind: 'MIGRATION_ACCEPTANCE_TEST', content, testIntegrity: INTEGRITY,
  });

  it('refuses a test asserting that a tampered ciphertext throws', () => {
    const verdict = guardTestArtifact(artifact(
      'byte[] tampered = flipBit(ciphertext);\n'
      + 'assertThrows(GeneralSecurityException.class, () -> decaps(sk, tampered));',
    ));
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) return;
    expect(verdict.refusals[0]!.ruleId).toBe('EXEC-TEST-004');
    expect(verdict.refusals[0]!.reason).toMatch(/implicitly rejected/);
  });

  it('permits the same assertion for a wrong-length ciphertext, which does reject', () => {
    // FIPS 203 §7.3 rejects at the input check. Refusing this too would push the
    // agent away from the assertion it is supposed to make.
    const verdict = guardTestArtifact(artifact(
      'byte[] wrongLength = Arrays.copyOf(ciphertext, 100);\n'
      + 'assertThrows(IllegalArgumentException.class, () -> decaps(sk, wrongLength));',
    ));
    expect(verdict.allowed).toBe(true);
  });

  it('permits the correct assertion — a different shared secret, and no exception', () => {
    const verdict = guardTestArtifact(artifact(
      'byte[] tampered = flipBit(ciphertext);\n'
      + 'assertFalse(Arrays.equals(secret, decaps(sk, tampered)));',
    ));
    expect(verdict.allowed).toBe(true);
  });
});

describe('AC-6, FR-11 · the primitive under migration is never mocked', () => {
  it('refuses a declared mock of encapsulation', () => {
    const verdict = guardTestArtifact({
      path: 'src/test/java/pay/KemStub.java', changeType: 'MOCK', testKind: 'MOCK',
      content: 'class KemStub {}', mockTarget: 'KEM_DECAPSULATION', testIntegrity: INTEGRITY,
    });
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) return;
    expect(verdict.refusals[0]!.ruleId).toBe('EXEC-MOCK-004');
    expect(verdict.refusals[0]!.classification).toBe('PROHIBITED_TEST_CONSTRUCTION');
  });

  it('refuses a stub that is written into the body but not declared', () => {
    // The declaration is the part the model controls, so the body is the half
    // that actually has to hold.
    for (const content of [
      'when(kem.encapsulate(pk)).thenReturn(FIXED);',
      'doReturn(SECRET).when(provider).decapsulate(any());',
      'var p = mock(Provider.class);',
      'when(handshake.getSharedSecret()).thenReturn(ZEROS);',
    ]) {
      const verdict = guardTestArtifact({
        path: 'src/test/java/pay/X.java', changeType: 'MOCK', testKind: 'MOCK',
        content, mockTarget: 'PROTOCOL_COUNTERPART', testIntegrity: INTEGRITY,
      });
      expect(verdict.allowed, content).toBe(false);
    }
  });

  it('permits mocking the peer, which is the whole point of a partner simulator', () => {
    const verdict = guardTestArtifact({
      path: 'src/test/java/pay/PartnerHandshakeMock.java', changeType: 'MOCK', testKind: 'MOCK',
      content: 'class PartnerHandshakeMock {\n'
        + '  String keyType() { return "ML_KEM_PUBLIC_KEY"; }\n'
        + '  byte[] respond(byte[] request) { return realKem.encapsulate(request); }\n}',
      mockTarget: 'PROTOCOL_COUNTERPART', testIntegrity: INTEGRITY,
    });
    expect(verdict.allowed).toBe(true);
  });
});

describe('AC-7, FR-12, FR-13 · every test change is justified before it is made', () => {
  it('refuses a test, mock or fixture change with no integrity record', () => {
    for (const changeType of ['TEST', 'MOCK', 'FIXTURE'] as const) {
      const verdict = guardTestArtifact({
        path: 'src/test/java/pay/X.java', changeType, testKind: 'CHARACTERIZATION',
        content: 'assertEquals(1, 1);',
      });
      expect(verdict.allowed, changeType).toBe(false);
      if (verdict.allowed) continue;
      expect(verdict.refusals[0]!.ruleId).toBe('EXEC-MOCK-001');
    }
  });

  it('requires a gate when the record admits a baseline requirement changed', () => {
    const verdict = guardTestArtifact({
      path: 'src/test/java/pay/X.java', changeType: 'TEST', testKind: 'CHARACTERIZATION',
      content: 'assertEquals(1, 1);',
      testIntegrity: { ...INTEGRITY, baselineRequirementChanged: true },
    });
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) return;
    expect(verdict.refusals[0]!.gateType).toBe('BASELINE_CONTRACT_CHANGE');
  });

  it('raises a gate rather than letting a MUST_PRESERVE assertion be softened', () => {
    const invariants = [
      {
        invariantId: 'inv_1', kind: 'FAILURE_MODE' as const,
        description: 'A malformed advice is rejected',
        assertion: 'assertEquals(400, response.getStatusCode());',
        capturedFrom: 'EXISTING_TEST' as const,
        disposition: 'MUST_PRESERVE' as const, evidenceIds: [],
      },
      {
        invariantId: 'inv_2', kind: 'MESSAGE_FORMAT' as const,
        description: 'The wrapped key is 256 bytes',
        assertion: 'assertEquals(256, wrapped.length);',
        capturedFrom: 'EXISTING_TEST' as const,
        disposition: 'EXPECTED_TO_CHANGE' as const, evidenceIds: [],
      },
    ];

    const touching = guardTestArtifact({
      path: 'src/test/java/pay/ControllerTest.java', changeType: 'TEST',
      testKind: 'CHARACTERIZATION',
      content: 'assertEquals(400, response.getStatusCode()); // relaxed',
      testIntegrity: INTEGRITY,
    }, { invariants });
    expect(touching.allowed).toBe(false);
    if (!touching.allowed) {
      expect(touching.refusals[0]!.ruleId).toBe('EXEC-TEST-007');
      expect(touching.refusals[0]!.gateType).toBe('BASELINE_CONTRACT_CHANGE');
    }

    // The expected-to-change one is not gated: editing that assertion IS the
    // migration, and gating it would end a correct run with a human action.
    const expected = guardTestArtifact({
      path: 'src/test/java/pay/HandshakeTest.java', changeType: 'TEST',
      testKind: 'CHARACTERIZATION',
      content: 'assertEquals(256, wrapped.length);',
      testIntegrity: INTEGRITY,
    }, { invariants });
    expect(expected.allowed).toBe(true);
  });
});

describe('AC-4, FR-7, FR-8 · validated against the unmigrated build', () => {
  it('keeps an acceptance test that fails at base and rejects one that passes', () => {
    const verdict = validateAgainstBase([
      { testId: 'KemTest', testKind: 'MIGRATION_ACCEPTANCE_TEST', passedAtBase: false },
      { testId: 'VacuousTest', testKind: 'MIGRATION_ACCEPTANCE_TEST', passedAtBase: true },
      { testId: 'CharTest', testKind: 'CHARACTERIZATION', passedAtBase: true },
      { testId: 'BrokenCharTest', testKind: 'CHARACTERIZATION', passedAtBase: false },
    ]);
    expect(verdict.accepted).toEqual(['KemTest', 'CharTest']);
    expect(verdict.vacuous).toEqual(['VacuousTest']);
    expect(verdict.brokenAtBase).toEqual(['BrokenCharTest']);
  });
});

describe('A3 holds no tool that modifies implementation source', () => {
  it('cannot apply a patch during the phase that must not modify source', () => {
    for (const name of SOURCE_MUTATING_TOOL_NAMES) {
      expect(TEST_ENGINEERING_TOOL_NAMES as readonly string[]).not.toContain(name);
      expect(mutatesSource(name)).toBe(true);
    }
    // And it does hold what it needs, or the assertion above proves nothing.
    expect(TEST_ENGINEERING_TOOL_NAMES).toContain('generate_test');
    expect(TEST_ENGINEERING_TOOL_NAMES).toContain('create_branch');
  });
});

describe('the whole phase, end to end', () => {
  it('branches, captures, writes what is allowed and refuses what is not', async () => {
    const { project, run } = await approvedProject(repo.baseCommitSha);
    const mainBefore = await repo.shaOf('main');

    const outcome = await runTestEngineering(project, run, {
      repos: t.repos,
      projects: null as never, // Not reached: workdir is supplied, so nothing clones.
      engine,
      model: scriptedAgent(),
      executor: scriptedExecutor(),
      blobs: new InMemoryBlobStore(),
      logger,
      workdir: repo.dir,
    });

    // AC-1 — the original branch never moved.
    expect(await repo.shaOf('main')).toBe(mainBefore);
    expect(await repo.branches()).toContain(`agent/pqc/${project.projectId}`);

    // AC-3 — four invariants survive; the fifth was prose and was dropped.
    expect(outcome.invariants).toHaveLength(4);
    const byKind = Object.fromEntries(outcome.invariants.map((i) => [i.kind, i.disposition]));
    expect(byKind.MESSAGE_FORMAT).toBe('EXPECTED_TO_CHANGE');
    expect(byKind.API_BEHAVIOR).toBe('MUST_PRESERVE');
    expect(byKind.FAILURE_MODE).toBe('MUST_PRESERVE');

    // AC-5, AC-6, AC-7 — three of the four proposals refused, each by its rule.
    expect(outcome.written).toEqual(['src/test/java/pay/security/CryptoServiceKemTest.java']);
    expect(outcome.refused.map((r) => r.refusals[0]!.ruleId).sort())
      .toEqual(['EXEC-MOCK-001', 'EXEC-MOCK-004', 'EXEC-TEST-004']);

    // The one accepted test is committed on the branch, with its record. The
    // migration patch that follows is PRD-12's and is asserted there.
    const changes = await t.repos.migrationChanges.find({ projectId: project.projectId } as never);
    const engineered = changes.filter((c) => c.intent === 'TEST_ENGINEERING');
    expect(engineered).toHaveLength(1);
    expect(engineered[0]!.changeType).toBe('TEST');
    expect(engineered[0]!.testIntegrity?.baselineRequirementChanged).toBe(false);
    expect(engineered[0]!.commitSha).toBeTruthy();

    const baseline = await t.repos.baselines.findOne({ projectId: project.projectId } as never);
    expect(baseline!.commitSha).toBe(repo.baseCommitSha);
    expect(baseline!.tests.total).toBe(3);
    expect(baseline!.invariants).toHaveLength(4);

    // AC-4 — the acceptance test was run against the base commit and, having
    // failed there as it must, was kept.
    expect(outcome.vacuous).toEqual([]);

    const stored = await t.repos.migrationRuns.findOne({
      migrationRunId: run.migrationRunId,
    } as never);
    expect(stored!.baselineId).toBe(`base_${run.migrationRunId}`);
    // The test commit, plus the patch the loop went on to apply. Test
    // engineering's own contribution is the first one.
    expect(stored!.branch.commitCount).toBeGreaterThanOrEqual(1);

    // The feed tells the story a viewer needs, in order.
    const events = await t.repos.events.since(project.projectId, 0);
    const types = events.map((e) => e.type);
    expect(types).toContain('BRANCH_CREATED');
    expect(types).toContain('BASELINE_CAPTURE_STARTED');
    expect(types).toContain('BASELINE_CAPTURE_COMPLETED');
    expect(types).toContain('TEST_CREATED');
    expect(events.filter((e) => e.type === 'MIGRATION_BLOCKER_IDENTIFIED')).toHaveLength(3);
  }, 60_000);
});

describe('log excerpting is deterministic', () => {
  it('keeps the lines that carry the failure and drops the rest', () => {
    const log = [
      '[INFO] Scanning for projects...',
      '[INFO] Building payments-api 1.3.0',
      '[ERROR] Tests run: 3, Failures: 1',
      '[ERROR] completesTheHandshake  Time elapsed: 0.02 s',
      'java.lang.IllegalArgumentException: Unsupported key exchange',
      '[INFO] BUILD FAILURE',
    ].join('\n');
    const lines = excerpt(log);
    expect(lines).toContain('[ERROR] Tests run: 3, Failures: 1');
    expect(lines).toContain('[INFO] BUILD FAILURE');
    expect(lines).not.toContain('[INFO] Scanning for projects...');
  });
});
