import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import {
  makeProblemKey, normalizeErrorSignature,
  type Assessment, type BehavioralInvariant, type ExecutionRun,
  type MigrationRun, type PlanItem, type StructuredFailure,
} from '@proteus/schema';
import { ScriptedModel } from '../src/agent/model';
import { MIN_ACTIONABLE_CONFIDENCE } from '../src/agent/flows/diagnosis';
import {
  DIAGNOSTIC_TOOL_NAMES, MIGRATION_TOOL_NAMES, WRITE_TOOL_NAMES, isWriteTool,
} from '../src/agent/tools/registry';
import {
  authoriseRepair, classifyDeterministically, factsForFailure, touchedInvariant,
  unclassified, type DiagnosisContext,
} from '../src/core/migration/diagnosis';
import { failureJson, phaseOf, relevantLines, structureFailure } from '../src/core/migration/failures';
import { BLOCKING, openGate, retryBudgetGate } from '../src/core/migration/gates';
import {
  MAX_MEANINGFUL_AUTONOMOUS_ATTEMPTS, activeThreads, recordAttempt,
} from '../src/core/migration/problems';
import { parseReports } from '../src/core/migration/testReports';
import { RuleEngine } from '../src/core/rules/engine';
import { ScriptedExecutor } from '../src/integrations/cloudbuild/executor';
import { InMemoryBlobStore } from '../src/integrations/storage/blobs';
import { migrationBranchName } from '../src/integrations/github/writer';
import { assertWithinScope, PatchRefused, stackOf,
} from '../src/worker/migrationLoop';
import { runTestEngineering } from '../src/worker/migrationJob';
import { aProject, clearAll, startTestDb, type TestDb } from './helpers/mongo';
import { failsafeReport, makeTestRepo, surefireReport, type TestRepo } from './helpers/repo';

/** PRD-12 acceptance criteria — the loop, and the two guarantees inside it. */

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

const invariant = (over: Partial<BehavioralInvariant> = {}): BehavioralInvariant => ({
  invariantId: 'inv_1', kind: 'API_BEHAVIOR',
  description: 'POST /settlements accepts a valid advice',
  assertion: 'assertEquals(201, response.getStatusCode());',
  capturedFrom: 'EXISTING_TEST', disposition: 'MUST_PRESERVE', evidenceIds: [],
  ...over,
});

const failure = (over: Partial<StructuredFailure> = {}): StructuredFailure => ({
  phase: 'INTEGRATION_TEST',
  command: 'mvn -B verify',
  exitCode: 1,
  failedTests: [{
    name: 'pay.PartnerHandshakeIntegrationTest#completesTheHandshakeWithTheAcquirer',
    message: 'Unsupported key exchange ML_KEM_PUBLIC_KEY (expected RSA_PUBLIC_KEY)',
  }],
  error: 'java.lang.IllegalArgumentException: Unsupported key exchange ML_KEM_PUBLIC_KEY '
    + '(expected RSA_PUBLIC_KEY)',
  relevantLogs: ['[ERROR] Tests run: 2, Failures: 1', 'Expected RSA_PUBLIC_KEY'],
  ...over,
});

/** The mock and its test both assert the legacy key type. No production file does. */
const MOCK_CONTEXT: DiagnosisContext = {
  changedPaths: ['src/main/java/pay/security/CryptoService.java'],
  invariants: [invariant()],
  referencingFiles: [
    {
      path: 'src/test/java/pay/PartnerHandshakeMock.java',
      content: 'String keyType() { return "RSA_PUBLIC_KEY"; }',
    },
    {
      path: 'src/test/java/pay/PartnerHandshakeIntegrationTest.java',
      content: 'assertEquals("RSA_PUBLIC_KEY", mock.keyType());',
    },
  ],
  externalNames: [],
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

async function approvedProject(baseCommitSha: string, items: PlanItem[] = [planItem()]) {
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
    planItems: items,
    policyId: 'policy_mlkem_v1', status: 'APPROVED', generatedAt: now,
  };
  await t.repos.assessments.insert(assessment);

  const run: MigrationRun = {
    _schemaVersion: 1, createdAt: now, updatedAt: now,
    migrationRunId: `mig_${project.projectId}_v1`, projectId: project.projectId,
    approval: {
      assessmentId: assessment.assessmentId, assessmentVersion: 1,
      approvedPlanItemIds: items.map((i) => i.planItemId),
      approvedBy: 'firebase-uid-1', approvedAt: now,
      acknowledgedActions: ['create a migration branch'],
    },
    branch: {
      name: migrationBranchName(project.projectId), baseCommitSha, pushed: false, commitCount: 0,
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

const execution = (over: Partial<ExecutionRun> = {}): ExecutionRun => ({
  _schemaVersion: 1, createdAt: new Date(), updatedAt: new Date(),
  executionRunId: 'exec_1', projectId: 'PQC-0184', migrationRunId: 'mig_1',
  kind: 'INTEGRATION_TEST', environment: 'CLOUD_BUILD', provider: {},
  commitSha: 'abc1234def5678', command: 'mvn -B verify', exitCode: 1, status: 'FAILURE',
  logExcerpt: [], startedAt: new Date(),
  ...over,
});

// ---------------------------------------------------------------------------

describe('AC-1, FR-5 · the demo failure classifies without a model call', () => {
  it('reaches MOCK_INCOMPATIBILITY through EXEC-DIAG-004', () => {
    const facts = factsForFailure(failure(), MOCK_CONTEXT);
    expect(facts['failingAssertionReferences']).toBe('LEGACY_ALGORITHM');
    expect([...(facts['referencingFiles'] as string[])].sort()).toEqual(['MOCK', 'TEST']);

    const result = classifyDeterministically(engine, facts)!;
    expect(result.classification).toBe('MOCK_INCOMPATIBILITY');
    expect(result.ruleId).toBe('EXEC-DIAG-004');
    expect(result.source).toBe('DETERMINISTIC');
    expect(result.permitAutonomousRepair).toBe(true);
    expect(result.requiresTestIntegrityRecord).toBe(true);
  });

  it('does not match when a production file also asserts the legacy algorithm', () => {
    // The discriminator. If source code asserts RSA, the expectation is a real
    // requirement and this is not an obsolete stand-in.
    const result = classifyDeterministically(engine, factsForFailure(failure(), {
      ...MOCK_CONTEXT,
      referencingFiles: [
        ...MOCK_CONTEXT.referencingFiles,
        {
          path: 'src/main/java/pay/security/PartnerKeyProvider.java',
          content: 'if (!"RSA_PUBLIC_KEY".equals(type)) throw new IllegalArgumentException();',
        },
      ],
    }));
    expect(result?.ruleId).not.toBe('EXEC-DIAG-004');
  });

  it('never lets the procedural rule stand in for a classification', () => {
    // EXEC-DIAG-001 matches every failure and carries no verdict. If it were
    // treated as a match, EXEC-DIAG-008's gate would never be reached.
    const result = classifyDeterministically(engine, {
      failurePresent: true, phase: 'BUILD', error: 'something nobody has seen before',
    });
    expect(result).toBeNull();
  });

  it('routes a compile error in a changed file away from one outside it', () => {
    const changed = classifyDeterministically(engine, factsForFailure(failure({
      phase: 'BUILD', failedTests: [],
      error: '[ERROR] /src/main/java/pay/security/CryptoService.java:[31,20] cannot find symbol',
      relevantLogs: ['[ERROR] COMPILATION ERROR'],
    }), { ...MOCK_CONTEXT, referencingFiles: [] }))!;
    expect(changed.classification).toBe('IMPLEMENTATION_DEFECT');
    expect(changed.ruleId).toBe('EXEC-DIAG-002');

    const elsewhere = classifyDeterministically(engine, factsForFailure(failure({
      phase: 'BUILD', failedTests: [],
      error: '[ERROR] Failed to execute goal: plugin execution not covered by lifecycle',
      relevantLogs: [],
    }), { ...MOCK_CONTEXT, referencingFiles: [] }))!;
    // Editing source that was working is exactly what conflating these produces.
    expect(elsewhere.classification).toBe('BUILD_DEFECT');
    expect(elsewhere.ruleId).toBe('EXEC-DIAG-009');
  });

  it('recognises the provider that predates the algorithm', () => {
    const result = classifyDeterministically(engine, factsForFailure(failure({
      phase: 'BUILD', failedTests: [],
      error: 'java.security.NoSuchAlgorithmException: ML-KEM-768 KeyPairGenerator not available',
      relevantLogs: [],
    }), { ...MOCK_CONTEXT, referencingFiles: [] }))!;
    expect(result.classification).toBe('DEPENDENCY_INCOMPATIBILITY');
    expect(result.ruleId).toBe('EXEC-DIAG-003');
  });
});

describe('AC-5, FR-7 · a failing baseline invariant is never a test defect', () => {
  const wrapped = invariant({
    invariantId: 'inv_len', kind: 'MESSAGE_FORMAT',
    description: 'The wrapped session key is 256 bytes',
    assertion: 'assertEquals(256, wrapped.length);',
    disposition: 'MUST_PRESERVE',
  });

  const lengthFailure = failure({
    failedTests: [{
      name: 'pay.PartnerHandshakeIntegrationTest#transportsASessionKeyToTheAcquirer',
      message: 'expected: <256> but was: <1088>',
    }],
    error: 'org.opentest4j.AssertionFailedError: expected: <256> but was: <1088>',
    relevantLogs: ['assertEquals(256, wrapped.length);'],
  });

  it('classifies a MUST_PRESERVE breach as a gate, not a repair', () => {
    const facts = factsForFailure(lengthFailure, { ...MOCK_CONTEXT, invariants: [wrapped] });
    expect(facts['failingAssertionIsBaselineInvariant']).toBe(true);

    const result = classifyDeterministically(engine, facts)!;
    expect(result.classification).toBe('EXPECTED_BEHAVIOR_CHANGE');
    expect(result.ruleId).toBe('EXEC-DIAG-005');
    // No test is modified. Spec §25 forbids weakening a legitimate requirement
    // to achieve a pass, and this is the rule that makes that enforceable.
    expect(result.permitAutonomousRepair).toBe(false);
    expect(result.gateType).toBe('BASELINE_CONTRACT_CHANGE');
  });

  it('outranks the mock classifier when both could match', () => {
    // EXEC-DIAG-004 would claim this too — the failing test is test code. The
    // precedence table is what stops a regression being repaired as a stale mock.
    const both = factsForFailure(
      failure({
        ...lengthFailure,
        error: `${lengthFailure.error} RSA_PUBLIC_KEY`,
      }),
      { ...MOCK_CONTEXT, invariants: [wrapped] },
    );
    expect(both['failingAssertionReferences']).toBe('LEGACY_ALGORITHM');
    expect(classifyDeterministically(engine, both)!.ruleId).toBe('EXEC-DIAG-005');
  });

  it('treats the same assertion as an authorised update when it was expected to change', () => {
    // The other half, and the reason D-003 replaced `mustHold: true`. RSA-2048
    // wraps to 256 and ML-KEM-768 produces 1088, so this failure IS the
    // migration working. Gating it would end a correct run with a human action.
    const expected = { ...wrapped, disposition: 'EXPECTED_TO_CHANGE' as const };
    const facts = factsForFailure(lengthFailure, { ...MOCK_CONTEXT, invariants: [expected] });
    expect(facts['failingAssertionIsExpectedToChangeInvariant']).toBe(true);
    expect(facts['failingAssertionIsBaselineInvariant']).toBeUndefined();

    const result = classifyDeterministically(engine, facts)!;
    expect(result.ruleId).toBe('EXEC-DIAG-013');
    expect(result.classification).toBe('EXPECTED_BEHAVIOR_CHANGE');
    expect(result.permitAutonomousRepair).toBe(true);
    // Asserted by the rule, not left to the agent that wants the edit permitted.
    expect(result.baselineRequirementChanged).toBe(false);
    expect(result.requiresTestIntegrityRecord).toBe(true);
  });

  it('matches an invariant through the literal Surefire reports, not just the source line', () => {
    // Surefire prints `expected: <256> but was: <1088>`, never the assertion.
    // Matching only on source text would miss every real failure.
    expect(touchedInvariant(
      failure({
        relevantLogs: [],
        failedTests: [{ name: 'x', message: 'expected: <256> but was: <1088>' }],
        error: 'expected: <256> but was: <1088>',
      }),
      [wrapped],
    )?.invariantId).toBe('inv_len');
  });
});

describe('AC-2, FR-8 · one problem, one key', () => {
  it('collapses twenty runs of the same failure to a single key', () => {
    const keys = new Set<string>();
    for (let i = 0; i < 20; i++) {
      keys.add(makeProblemKey({
        classification: 'MOCK_INCOMPATIBILITY',
        failedTest: 'pay.PartnerHandshakeIntegrationTest#completesTheHandshake',
        // Everything that varies between runs and means nothing: a build id, a
        // timestamp, a temp path, a duration.
        error: `[build-${i}] 2026-08-29T10:${String(i).padStart(2, '0')}:00Z `
          + `/tmp/proteus-${i}a3f9c2/src/Main.java:${40 + i} `
          + `Unsupported key exchange ML_KEM_PUBLIC_KEY after ${1200 + i}ms`,
      }));
    }
    expect(keys.size).toBe(1);
  });

  it('keeps genuinely different failures apart', () => {
    const a = makeProblemKey({
      classification: 'MOCK_INCOMPATIBILITY', failedTest: 'A#x', error: 'Unsupported key exchange',
    });
    const b = makeProblemKey({
      classification: 'MOCK_INCOMPATIBILITY', failedTest: 'A#x', error: 'Connection refused',
    });
    const c = makeProblemKey({
      classification: 'IMPLEMENTATION_DEFECT', failedTest: 'A#x', error: 'Unsupported key exchange',
    });
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it('normalises versions and counts without eating the words around them', () => {
    expect(normalizeErrorSignature('failed after 1203ms on bcprov-jdk18on 1.72'))
      .toBe(normalizeErrorSignature('failed after 87ms on bcprov-jdk18on 1.78'));
    expect(normalizeErrorSignature('Unsupported key exchange')).toContain('unsupported key exchange');
  });
});

describe('AC-3, AC-4, FR-9, FR-10 · the retry budget', () => {
  it('opens a non-blocking gate at four meaningful attempts', async () => {
    const { run } = await approvedProject(repo.baseCommitSha);
    const classification = classifyDeterministically(
      engine, factsForFailure(failure(), MOCK_CONTEXT),
    )!;

    let thread;
    for (let i = 1; i <= MAX_MEANINGFUL_AUTONOMOUS_ATTEMPTS; i++) {
      thread = await recordAttempt(t.repos, run, classification, failure(), `att_${i}`);
      expect(thread.counted).toBe(true);
      expect(thread.display).toBe(`${i} / 4`);
    }
    expect(thread!.exhausted).toBe(true);

    const { gate } = await openGate(
      t.repos,
      retryBudgetGate(run, thread!.thread.problemKey, 4, classification, failure()),
      thread!.thread.problemKey,
    );
    // Non-blocking by rule: four failures on one problem say nothing about the
    // rest of the approved scope, and halting everything would defeat the
    // one-approval model.
    expect(gate.blocking).toBe(false);
    expect(BLOCKING.RETRY_BUDGET_EXHAUSTED).toBe(false);

    const project = await t.repos.projects.byId(run.projectId);
    // A non-blocking gate is counted but does not claim the user must act.
    expect(project!.summary.counts.openGates).toBe(1);
    expect(project!.actionRequired).toBe(false);
  });

  it('leaves the budget at zero after ten infrastructure failures', async () => {
    const { run } = await approvedProject(repo.baseCommitSha);
    const flake = failure({
      phase: 'BUILD', failedTests: [],
      error: 'Cloud Build step timed out after 900s', relevantLogs: ['connection refused'],
    });
    const classification = classifyDeterministically(
      engine, factsForFailure(flake, { ...MOCK_CONTEXT, referencingFiles: [] }),
    )!;
    expect(classification.ruleId).toBe('EXEC-DIAG-007');
    expect(classification.countsTowardRetryBudget).toBe(false);

    let thread;
    for (let i = 0; i < 10; i++) {
      thread = await recordAttempt(t.repos, run, classification, flake, `att_${i}`);
    }
    // Charging a flake would exhaust the budget without a single engineering
    // attempt having been made — worse than having no limit at all.
    expect(thread!.thread.meaningfulAttempts).toBe(0);
    expect(thread!.exhausted).toBe(false);
    expect(thread!.thread.attemptIds).toHaveLength(10);
  });

  it('exempts a failure that originates outside the boundary', () => {
    const external = classifyDeterministically(engine, factsForFailure(
      failure({ error: 'acquirer-gateway refused the ML-KEM handshake' }),
      {
        ...MOCK_CONTEXT,
        referencingFiles: [],
        externalNames: [{ name: 'acquirer-gateway', type: 'EXTERNAL_SERVICE' }],
      },
    ))!;
    expect(external.classification).toBe('EXTERNAL_DEPENDENCY_BLOCKER');
    expect(external.ruleId).toBe('EXEC-DIAG-012');
    expect(external.countsTowardRetryBudget).toBe(false);
    expect(external.permitAutonomousRepair).toBe(false);
    // A recommendation with an owner, not a gate: unrelated approved work
    // continues around something the agent was never going to fix.
    expect(external.raiseRecommendation).toBe(true);
  });

  it('counts per problem, not per run', async () => {
    const { run } = await approvedProject(repo.baseCommitSha);
    const c = classifyDeterministically(engine, factsForFailure(failure(), MOCK_CONTEXT))!;

    await recordAttempt(t.repos, run, c, failure(), 'att_1');
    await recordAttempt(t.repos, run, c, failure({ error: 'a completely different failure' }), 'att_2');

    const threads = await activeThreads(t.repos, run.migrationRunId);
    expect(threads).toHaveLength(2);
    expect(threads.every((x) => x.meaningfulAttempts === 1)).toBe(true);
  });
});

describe('FR-11, FR-12 · repairs are authorised, not assumed', () => {
  it('permits a repair only where the classification allows one, and cites it', () => {
    const mock = classifyDeterministically(engine, factsForFailure(failure(), MOCK_CONTEXT))!;
    const first = authoriseRepair(engine, mock, 1);
    expect(first.permitted).toBe(true);
    // EXEC-REP-002 — a repair whose justification is not recorded cannot be
    // distinguished from the agent trying things until the suite went green.
    expect(first.citedRuleIds).toContain('EXEC-DIAG-004');
    expect(first.citedRuleIds).toContain('EXEC-REP-002');
    expect(first.revertFirst).toBe(false);
  });

  it('reverts rather than layering from the second attempt on', () => {
    const mock = classifyDeterministically(engine, factsForFailure(failure(), MOCK_CONTEXT))!;
    const second = authoriseRepair(engine, mock, 2);
    expect(second.revertFirst).toBe(true);
    expect(second.citedRuleIds).toContain('EXEC-REP-003');
  });

  it('refuses a repair the classification does not permit, and names the gate', () => {
    const refused = authoriseRepair(engine, unclassified(engine), 1);
    expect(refused.permitted).toBe(false);
    expect(refused.gateType).toBe('MATERIAL_ARCHITECTURE_DECISION');
    expect(refused.reason).toMatch(/does not permit autonomous repair/);
  });
});

describe('AC-7, FR-6 · A4 cannot change what it judges', () => {
  it('holds no write tool', () => {
    for (const name of DIAGNOSTIC_TOOL_NAMES) {
      expect(isWriteTool(name), `${name} writes`).toBe(false);
      expect(WRITE_TOOL_NAMES as readonly string[]).not.toContain(name);
    }
    // And A3 does hold them, or the assertion above proves nothing about the split.
    expect(MIGRATION_TOOL_NAMES).toContain('apply_patch');
    expect(DIAGNOSTIC_TOOL_NAMES as readonly string[]).not.toContain('apply_patch');
  });

  it('escalates a low-confidence diagnosis instead of acting on it', () => {
    expect(MIN_ACTIONABLE_CONFIDENCE).toBe(0.6);
    const gate = unclassified(engine);
    expect(gate.classification).toBe('UNKNOWN');
    expect(gate.permitAutonomousRepair).toBe(false);
    expect(gate.ruleId).toBe('EXEC-DIAG-008');
  });
});

describe('FR-4 · structured evidence, bounded and stable', () => {
  it('reduces a log to at most twenty lines, in log order', () => {
    const noise = Array.from({ length: 400 }, (_, i) => `[INFO] Downloading artifact ${i}`);
    const log = [
      ...noise.slice(0, 200),
      '[ERROR] Tests run: 2, Failures: 1, Errors: 0',
      'java.lang.IllegalArgumentException: Unsupported key exchange ML_KEM_PUBLIC_KEY',
      'Expected RSA_PUBLIC_KEY',
      ...noise.slice(200),
      '[INFO] BUILD FAILURE',
    ].join('\n');

    const lines = relevantLines(log);
    expect(lines.length).toBeLessThanOrEqual(20);
    expect(lines).toContain('java.lang.IllegalArgumentException: Unsupported key exchange ML_KEM_PUBLIC_KEY');
    expect(lines.some((l) => l.includes('Downloading artifact'))).toBe(false);
    // A reader follows a log downward; priority order would print the cause
    // after its own consequence.
    expect(lines.indexOf('[ERROR] Tests run: 2, Failures: 1, Errors: 0'))
      .toBeLessThan(lines.indexOf('[INFO] BUILD FAILURE'));
  });

  it('takes the phase from which reports failed, not from the command', () => {
    const both = parseReports([
      surefireReport('pay.util.CryptoUtilsTest', [{ name: 'hashes' }]),
      failsafeReport('pay.PartnerHandshakeIntegrationTest', [
        { name: 'completesTheHandshake', failure: 'Unsupported key exchange' },
      ]),
    ]);
    // `mvn verify` runs both plugins in one invocation, so the command says
    // nothing about which phase failed — and EXEC-DIAG-002 vs -004 turns on it.
    expect(phaseOf(execution(), both)).toBe('INTEGRATION_TEST');

    const unit = parseReports([
      surefireReport('pay.util.CryptoUtilsTest', [{ name: 'hashes', failure: 'boom' }]),
    ]);
    expect(phaseOf(execution(), unit)).toBe('UNIT_TEST');
    expect(phaseOf(execution(), parseReports([]))).toBe('BUILD');
  });

  it('renders the compact JSON spec §33 specifies', () => {
    const json = JSON.parse(failureJson(failure(), 1));
    expect(json).toMatchObject({
      attempt: 1,
      phase: 'integration_test',
      command: 'mvn -B verify',
      exit_code: 1,
      failed_test: 'pay.PartnerHandshakeIntegrationTest#completesTheHandshakeWithTheAcquirer',
    });
    expect(json.relevant_logs).toHaveLength(2);
  });

  it('prefers the integration failure as the headline when both phases broke', () => {
    const structured = structureFailure({
      execution: execution(),
      inventory: parseReports([
        surefireReport('pay.A', [{ name: 'consequence', failure: 'NullPointerException' }]),
        failsafeReport('pay.B', [{ name: 'cause', failure: 'Unsupported key exchange' }]),
      ]),
      log: '',
    });
    // Naming the unit failure would produce a problemKey for a symptom.
    expect(structured.error).toContain('Unsupported key exchange');
    expect(structured.failedTests).toHaveLength(2);
  });
});

describe('the approved scope is a contract', () => {
  it('refuses a patch that touches a file the plan did not declare', () => {
    const item = planItem();
    expect(() => assertWithinScope(
      ['src/main/java/pay/security/CryptoService.java'],
      item.expectedChanges.flatMap((c) => c.paths),
      item,
    )).not.toThrow();

    expect(() => assertWithinScope(
      ['src/main/java/pay/security/CryptoService.java', 'src/main/java/pay/store/Ledger.java'],
      item.expectedChanges.flatMap((c) => c.paths),
      item,
    )).toThrow(PatchRefused);
  });

  it('honours a declared glob', () => {
    const item = planItem({
      expectedChanges: [{
        changeType: 'SOURCE', paths: ['src/main/java/pay/security/*.java'], description: 'x',
      }],
    });
    expect(() => assertWithinScope(
      ['src/main/java/pay/security/CryptoService.java'],
      ['src/main/java/pay/security/*.java'], item,
    )).not.toThrow();
    expect(() => assertWithinScope(
      ['src/main/java/pay/store/Ledger.java'],
      ['src/main/java/pay/security/*.java'], item,
    )).toThrow(PatchRefused);
  });
});

describe('AC-8 · the reference scenario, end to end', () => {
  /**
   * Baseline green, the migration patch lands, the partner mock fails exactly
   * as the fixture guarantees, the agent repairs it, and the retest is green.
   * One autonomous repair, no human action.
   */
  it('repairs the partner mock autonomously and finishes green', async () => {
    const { project, run } = await approvedProject(repo.baseCommitSha);

    // The executions this run makes, in order: the baseline build, the baseline
    // test, the run after the patch, and the run after the repair. No
    // base-commit validation run happens because no tests are generated here.
    const runs: Array<ConstructorParameters<typeof ScriptedExecutor>[0][number]> = [
      { exitCode: 0, log: 'BUILD SUCCESS' },
      {
        exitCode: 0,
        log: '[INFO] Tests run: 1, Failures: 0\n[INFO] BUILD SUCCESS',
        reports: [surefireReport('pay.security.SettlementSignerTest', [{ name: 'signs' }])],
      },
      {
        // The migration patch lands and the partner mock breaks — the fixture's
        // guaranteed failure, and the whole reason there is a repair loop.
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
      {
        // After the repair.
        exitCode: 0,
        log: '[INFO] Tests run: 2, Failures: 0\n[INFO] BUILD SUCCESS',
        reports: [
          surefireReport('pay.security.SettlementSignerTest', [{ name: 'signs' }]),
          failsafeReport('pay.PartnerHandshakeIntegrationTest', [
            { name: 'completesTheHandshakeWithTheAcquirer' },
          ]),
        ],
      },
    ];
    let call = 0;
    const stepping = {
      environment: 'CLOUD_BUILD' as const,
      async run(spec: { command: string }) {
        const answer = runs[Math.min(call++, runs.length - 1)]!;
        void spec;
        return {
          exitCode: answer.exitCode ?? 0,
          status: (answer.exitCode ?? 0) === 0 ? 'SUCCESS' as const : 'FAILURE' as const,
          log: answer.log ?? '',
          logExcerpt: (answer.log ?? '').split('\n').filter(Boolean),
          durationMs: 1000,
          reports: answer.reports ?? [],
          provider: {},
        };
      },
    };

    // The mock the repair will rewrite has to exist for the classifier to find it.
    await repo.write(
      'src/test/java/pay/PartnerHandshakeMock.java',
      'package pay;\nclass PartnerHandshakeMock {\n'
      + '  String keyType() { return "RSA_PUBLIC_KEY"; }\n}\n',
    );

    const model = new ScriptedModel({
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
    });

    const outcome = await runTestEngineering(project, run, {
      repos: t.repos,
      projects: null as never,
      engine,
      model,
      executor: stepping,
      blobs: new InMemoryBlobStore(),
      logger,
      workdir: repo.dir,
    });

    const loop = outcome.loop!;
    expect(loop.completed).toEqual(['plan_1']);
    expect(loop.blocked).toEqual([]);
    // One repair. The claim the product makes on Screen 4.
    expect(loop.autonomousRepairs).toBe(1);

    // Zero human actions: no gate was opened at all.
    expect(await t.repos.humanGates.count()).toBe(0);
    const stored = (await t.repos.projects.byId(project.projectId))!;
    expect(stored.summary.autonomy.humanEngineeringActions).toBe(0);
    expect(stored.summary.autonomy.completionPct).toBe(100);

    // The repair carries its integrity record and cites what authorised it.
    const repair = (await t.repos.migrationChanges.find({
      projectId: project.projectId,
    } as never)).find((c) => c.intent === 'REPAIR')!;
    expect(repair.changeType).toBe('MOCK');
    expect(repair.testIntegrity?.failureClassification).toBe('MOCK_INCOMPATIBILITY');
    expect(repair.testIntegrity?.baselineRequirementChanged).toBe(false);
    expect(repair.rationale).toContain('EXEC-DIAG-004');
    expect(repair.rationale).toContain('EXEC-REP-002');

    // AC-9's rows: FAIL → DIAGNOSIS → REPAIR → retest, in that order.
    const events = await t.repos.events.since(project.projectId, 0);
    const story = events
      .filter((e) => ['TEST_FAILED', 'FAILURE_DIAGNOSED', 'AUTONOMOUS_REPAIR_STARTED',
        'AUTONOMOUS_REPAIR_COMPLETED', 'TEST_PASSED'].includes(e.type))
      .map((e) => e.type);
    expect(story).toEqual([
      'TEST_FAILED', 'FAILURE_DIAGNOSED', 'AUTONOMOUS_REPAIR_STARTED',
      'AUTONOMOUS_REPAIR_COMPLETED', 'TEST_PASSED',
    ]);

    // The failure row carries the structured JSON verbatim (spec §33).
    const failed = events.find((e) => e.type === 'TEST_FAILED')!;
    const json = JSON.parse(failed.message!);
    expect(json.error).toContain('Unsupported key exchange');
    expect(json.relevant_logs.length).toBeLessThanOrEqual(20);

    // The diagnosis names the rule, not a model opinion.
    const diagnosed = events.find((e) => e.type === 'FAILURE_DIAGNOSED')!;
    expect(diagnosed.title).toContain('EXEC-DIAG-004');
    expect(diagnosed.actor).toBe('SYSTEM');

    // The problem was opened and then resolved by the repair.
    const threads = await t.repos.problemThreads.find({ projectId: project.projectId } as never);
    expect(threads).toHaveLength(1);
    expect(threads[0]!.classification).toBe('MOCK_INCOMPATIBILITY');
    expect(threads[0]!.status).toBe('RESOLVED');
    expect(threads[0]!.meaningfulAttempts).toBe(1);
  }, 60_000);
});

describe('AC-6, FR-2 · every iteration is a checkpoint', () => {
  it('records the plan item it was on, so a restart resumes there', async () => {
    const { project, run } = await approvedProject(repo.baseCommitSha);
    const model = new ScriptedModel({
      'baseline-invariants': { invariants: [] },
      'coverage-assessment': { components: [] },
      'generate-tests': { artifacts: [] },
      // No patch answer: the item fails, which is fine — the checkpoint is
      // written before the patch is attempted, which is the property under test.
    });

    await runTestEngineering(project, run, {
      repos: t.repos, projects: null as never, engine, model,
      executor: new ScriptedExecutor([{ exitCode: 0, log: 'BUILD SUCCESS', reports: [] }]),
      blobs: new InMemoryBlobStore(), logger, workdir: repo.dir,
    });

    const stored = (await t.repos.migrationRuns.findOne({
      migrationRunId: run.migrationRunId,
    } as never))!;
    // An evicted worker repeats at most this one item rather than the run.
    expect(stored.checkpoint.cursor).toEqual({ planItemId: 'plan_1' });
    expect(stored.checkpoint.at).toBeInstanceOf(Date);
  }, 60_000);

  it('reports an item it could not produce a change for, rather than crashing', async () => {
    const { project, run } = await approvedProject(repo.baseCommitSha);
    const model = new ScriptedModel({
      'baseline-invariants': { invariants: [] },
      'coverage-assessment': { components: [] },
      'generate-tests': { artifacts: [] },
    });

    const outcome = await runTestEngineering(project, run, {
      repos: t.repos, projects: null as never, engine, model,
      executor: new ScriptedExecutor([{ exitCode: 0, log: 'BUILD SUCCESS', reports: [] }]),
      blobs: new InMemoryBlobStore(), logger, workdir: repo.dir,
    });

    expect(outcome.loop!.blocked).toHaveLength(1);
    expect(outcome.loop!.completed).toEqual([]);
    const gate = (await t.repos.humanGates.find({ projectId: project.projectId } as never))[0]!;
    // A model failure is not a guardrail refusal, and the gate says which it was.
    expect(gate.title).toMatch(/[Cc]ould not produce/);
  }, 60_000);
});

describe('FR-1 · the loop is the orchestrator’s, not the model’s', () => {
  it('never asks the model whether to continue', async () => {
    const { project, run } = await approvedProject(repo.baseCommitSha);
    const model = new ScriptedModel({
      'baseline-invariants': { invariants: [] },
      'coverage-assessment': { components: [] },
      'generate-tests': { artifacts: [] },
      'migration-patch': {
        planItemId: 'plan_1', changeType: 'SOURCE', summary: 's', rationale: 'r',
        findingIds: [],
        files: [{
          path: 'src/main/java/pay/security/CryptoService.java',
          operation: 'MODIFIED', content: 'package pay.security;\npublic class CryptoService {}\n',
        }],
      },
    });

    await runTestEngineering(project, run, {
      repos: t.repos, projects: null as never, engine, model,
      executor: new ScriptedExecutor([{ exitCode: 0, log: 'BUILD SUCCESS', reports: [] }]),
      blobs: new InMemoryBlobStore(), logger, workdir: repo.dir,
    });

    // Three narrow questions and one patch. Nothing that asks the model to
    // decide whether the work is done — that comes from an exit code.
    const purposes = model.calls.map((c) => c.purpose);
    expect(purposes).toEqual([
      'baseline-invariants', 'coverage-assessment', 'generate-tests', 'migration-patch',
    ]);
  }, 60_000);
});

describe('the agent is told the runtime it is migrating for', () => {
  /**
   * A run spent its entire repair budget on `NoSuchAlgorithmException: ML-KEM-768
   * KEM not available`.
   *
   * The repository is Java 17. `javax.crypto.KEM` arrived in Java 21. No
   * provider registration can make `KEM.getInstance` resolve on 17 — so the
   * three repairs that registered providers were all answering the wrong
   * question. The agent was never told the version: the stack was hardcoded as
   * `language: 'Java'` while the discovered profile sat unread on the project.
   */
  const withProfile = (profile: Record<string, unknown> | undefined) =>
    stackOf({ repository: { profile } } as never);

  it('carries the discovered version, not just the language', () => {
    expect(withProfile({ language: 'Java', languageVersion: '17', buildSystem: 'Maven' }))
      .toMatchObject({ language: 'Java', languageVersion: '17', buildSystem: 'Maven' });
  });

  it('carries the framework too, which changes what a patch may assume', () => {
    expect(withProfile({
      language: 'Java', languageVersion: '17', buildSystem: 'Maven',
      framework: 'Spring Boot 3.2',
    }).framework).toBe('Spring Boot 3.2');
  });

  it('falls back rather than refusing when a project was never analysed', () => {
    // No profile is not a reason to refuse to migrate.
    expect(withProfile(undefined)).toMatchObject({ language: 'Java', buildSystem: 'Maven' });
    expect(withProfile(undefined).languageVersion).toBeUndefined();
  });

  it('does not invent a version it was not given', () => {
    expect(withProfile({ language: 'Kotlin', buildSystem: 'Gradle' }))
      .toEqual({ language: 'Kotlin', buildSystem: 'Gradle' });
  });
});
