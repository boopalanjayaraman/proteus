import { describe, expect, it } from 'vitest';
import { MigrationStage, type Baseline, type BehavioralInvariant, type MigrationRun } from '@proteus/schema';
import {
  CHECK_LABEL, CHECK_ORDER, CLASSIFICATION_COLOR, MIGRATION_STAGES, STAGE_LABEL,
  STATUS_COLOR, branchMeta, checkRows, checklist, migrationStats, openProblems, rail,
  retryDisplay, sandboxCard, shortSha, summarise, verdictLine, type ProblemSummary,
} from '../src/lib/migration';

/** PRD-11 — what the migration screen claims about progress and the contract. */

const invariant = (over: Partial<BehavioralInvariant> = {}): BehavioralInvariant => ({
  invariantId: 'inv_1', kind: 'API_BEHAVIOR',
  description: 'POST /settlements accepts a valid advice',
  assertion: 'assertEquals(201, response.getStatusCode());',
  capturedFrom: 'EXISTING_TEST', disposition: 'MUST_PRESERVE', evidenceIds: [],
  ...over,
});

const baselineOf = (over: Partial<Baseline> = {}): Baseline => ({
  _schemaVersion: 1, createdAt: new Date(), updatedAt: new Date(),
  baselineId: 'base_1', projectId: 'PQC-0184', migrationRunId: 'mig_1',
  commitSha: '7c41ab9d2f1e4c8b6a5d3e2f1a0b9c8d7e6f5a4b',
  build: { executionRunId: 'exec_1', passed: true, durationMs: 41000 },
  tests: {
    executionRunId: 'exec_2', total: 36, passed: 36, failed: 0, skipped: 0,
    knownFailures: [], inventory: [],
  },
  invariants: [], capturedAt: new Date(),
  ...over,
});

describe('AC-8 · the stage rail is a claim about progress', () => {
  it('covers every stage spec §22 defines, in order', () => {
    expect(MIGRATION_STAGES).toEqual(MigrationStage.options);
    for (const s of MIGRATION_STAGES) expect(STAGE_LABEL[s]).toBeTruthy();
    expect(rail('PREPARING_MIGRATION')).toHaveLength(18);
  });

  it('marks everything behind the current stage done and everything ahead pending', () => {
    const steps = rail('CAPTURING_BASELINE');
    const at = MIGRATION_STAGES.indexOf('CAPTURING_BASELINE');
    expect(steps[at]!.state).toBe('ACTIVE');
    expect(steps[at - 1]!.state).toBe('DONE');
    expect(steps[at + 1]!.state).toBe('PENDING');
    // Exactly one stage is ever live, or the rail is telling two stories.
    expect(steps.filter((s) => s.state === 'ACTIVE')).toHaveLength(1);
  });

  it('shows nothing as done before a run has a stage', () => {
    expect(rail(undefined).every((s) => s.state === 'PENDING')).toBe(true);
  });
});

describe('the branch panel', () => {
  it('renders the base commit short and the commit count singular', () => {
    const run = {
      branch: {
        name: 'agent/pqc/PQC-0184',
        baseCommitSha: '7c41ab9d2f1e4c8b6a5d3e2f1a0b9c8d7e6f5a4b',
        pushed: false, commitCount: 1,
      },
    } as MigrationRun;
    expect(branchMeta(run)).toBe('BASE 7c41ab9 · 1 COMMIT');
    expect(branchMeta({ ...run, branch: { ...run.branch, commitCount: 6 } } as MigrationRun))
      .toBe('BASE 7c41ab9 · 6 COMMITS');
    expect(shortSha(undefined)).toBe('');
  });
});

describe('AC-3, AC-8 · the baseline contract as the reader sees it', () => {
  it('puts what must be preserved before what will change', () => {
    const items = checklist(baselineOf({
      invariants: [
        invariant({ invariantId: 'i1', kind: 'MESSAGE_FORMAT', disposition: 'EXPECTED_TO_CHANGE',
          description: 'The wrapped key is 256 bytes', assertion: 'assertEquals(256, w.length);' }),
        invariant({ invariantId: 'i2', kind: 'FAILURE_MODE',
          description: 'A malformed advice is rejected', assertion: 'assertEquals(400, r.code());' }),
      ],
    }));
    // A reader needs to know what is protected before what is changing.
    expect(items.map((i) => i.disposition)).toEqual(['MUST_PRESERVE', 'EXPECTED_TO_CHANGE']);
    // The executable assertion is shown verbatim — an invariant the reader
    // cannot see is one they cannot check.
    expect(items[1]!.detail).toBe('assertEquals(256, w.length);');
    expect(items[1]!.kind).toBe('MESSAGE FORMAT');
  });

  it('names pre-existing failures rather than counting them away', () => {
    const s = summarise(baselineOf({
      tests: {
        executionRunId: 'e', total: 36, passed: 35, failed: 1, skipped: 0,
        knownFailures: [{ testId: 'pay.A#b', name: 'b', message: 'was already red' }],
        inventory: [],
      },
    }))!;
    expect(s.headline).toContain('35/36 tests passing at 7c41ab9');
    expect(s.headline).toContain('1 pre-existing failure recorded as known');
    expect(s.known).toBe(1);
  });

  it('says plainly when the base commit does not build', () => {
    const s = summarise(baselineOf({
      build: { executionRunId: 'e', passed: false, durationMs: 900 },
    }))!;
    // Risk 4 — recorded and reported, not hidden behind a green checklist.
    expect(s.buildPassed).toBe(false);
    expect(s.headline).toMatch(/does not build/);
  });

  it('is empty, not invented, before a baseline exists', () => {
    expect(checklist(null)).toEqual([]);
    expect(summarise(null)).toBeNull();
  });
});

describe('AC-9, FR-14 · the retry counter is per problem', () => {
  const problem = (over: Partial<ProblemSummary> = {}): ProblemSummary => ({
    problemKey: 'MOCK_INCOMPATIBILITY|pay.A#b|unsupported key exchange',
    classification: 'MOCK_INCOMPATIBILITY',
    signature: 'Unsupported key exchange ML_KEM_PUBLIC_KEY',
    meaningfulAttempts: 1, budget: 4, status: 'ACTIVE',
    ...over,
  });

  it('renders n / 4 and escalates at the budget', () => {
    expect(retryDisplay(problem()).label).toBe('1 / 4 MEANINGFUL ATTEMPTS');
    expect(retryDisplay(problem()).exhausted).toBe(false);
    expect(retryDisplay(problem({ meaningfulAttempts: 4 })).exhausted).toBe(true);
    expect(retryDisplay(problem({ meaningfulAttempts: 4 })).colour).toBe('var(--bad)');
    // The bar never overflows, even if a count somehow exceeds the budget.
    expect(retryDisplay(problem({ meaningfulAttempts: 9 })).fraction).toBe(1);
  });

  it('hides a problem the repair resolved', () => {
    const all = [problem(), problem({ problemKey: 'other', status: 'RESOLVED' })];
    // A resolved problem still occupying the panel would suggest the agent is
    // stuck on something it already fixed.
    expect(openProblems(all).map((p) => p.problemKey)).toEqual([problem().problemKey]);
    expect(openProblems(all.map((p) => ({ ...p, status: 'RESOLVED' })))).toEqual([]);
  });

  it('shows a repair count rather than a gate count in the tiles', () => {
    const tiles = migrationStats({
      commitCount: 6, testsPassing: 36, testsFailing: 0,
      autonomousRepairs: 1, humanGatesOpened: 0,
    });
    expect(tiles.map((t) => t.label)).toEqual([
      'COMMITS', 'TESTS PASSING', 'FAILING', 'AUTONOMOUS REPAIRS',
    ]);
    // Zero failing is not an alarm colour; one is.
    expect(tiles[2]!.fg).toBe('var(--fg3)');
    expect(migrationStats({
      commitCount: 1, testsPassing: 35, testsFailing: 1,
      autonomousRepairs: 0, humanGatesOpened: 0,
    })[2]!.fg).toBe('var(--bad)');
  });

  it('gives every failure classification a colour', () => {
    for (const c of [
      'MOCK_INCOMPATIBILITY', 'TEST_FIXTURE_OUTDATED', 'EXPECTED_BEHAVIOR_CHANGE',
      'IMPLEMENTATION_DEFECT', 'BUILD_DEFECT', 'DEPENDENCY_INCOMPATIBILITY',
      'CONFIGURATION_DEFECT', 'TEST_COVERAGE_GAP', 'ENVIRONMENT_FAILURE',
      'EXTERNAL_DEPENDENCY_BLOCKER', 'UNKNOWN',
    ]) {
      expect(CLASSIFICATION_COLOR[c], c).toBeTruthy();
    }
  });
});

describe('AC-9 · the verification list and the sandbox card', () => {
  const check = (over: Partial<{ check: string; status: string; detail: string }> = {}) => ({
    check: 'BUILD_SUCCESSFUL', status: 'PASS', detail: 'mvn -B verify exited 0', ...over,
  });

  it('renders the nine checks in the order spec §35 lists them', () => {
    const rows = checkRows([
      check({ check: 'E2E_VERIFICATION_SUCCESSFUL' }),
      check({ check: 'BASELINE_INVARIANTS_PRESERVED' }),
      check({ check: 'BUILD_SUCCESSFUL' }),
    ]);
    // Arrived in one order, read in another. A reader following the spec's list
    // should find them where the spec puts them.
    expect(rows.map((r) => r.check)).toEqual([
      'BASELINE_INVARIANTS_PRESERVED', 'BUILD_SUCCESSFUL', 'E2E_VERIFICATION_SUCCESSFUL',
    ]);
    expect(rows[0]!.label).toBe('Baseline behavioural invariants preserved');
    expect(CHECK_ORDER).toHaveLength(9);
    for (const c of CHECK_ORDER) expect(CHECK_LABEL[c]).toBeTruthy();
  });

  it('never colours a NOTED assertion as a failure', () => {
    // A noted residual is an honest observation about work that was never in
    // scope. Colouring it red tells the reader the migration went wrong.
    expect(STATUS_COLOR.NOTED).toBe('var(--warn)');
    expect(STATUS_COLOR.FAIL).toBe('var(--bad)');
    expect(STATUS_COLOR.NOTED).not.toBe(STATUS_COLOR.FAIL);
    expect(STATUS_COLOR.PASS).toBe('var(--ok)');
  });

  it('says how many checks passed, not just the verdict', () => {
    const checks = [check(), check({ status: 'FAIL' }), check({ status: 'PASS' })];
    // "NOT VERIFIED" alone tells a reader nothing about whether one thing or
    // eight are wrong.
    expect(verdictLine('NOT_VERIFIED', checks)).toBe('NOT VERIFIED · 2 of 3 checks passed');
    expect(verdictLine('VERIFIED', [check(), check()]))
      .toBe('VERIFIED · 2 of 2 checks passed');
  });

  it('labels the sandbox from isProduction rather than a caption', () => {
    const card = sandboxCard({
      service: { url: 'https://sandbox.example.run.app' },
      status: 'READY',
      isProduction: false,
      startupCheck: { passed: true, startupMs: 2400 },
      e2e: {
        passed: true,
        scenarios: [{ passed: true }, { passed: true }, { passed: true }],
        latencyDeltaMs: 4.1,
      },
    })!;
    expect(card.label).toBe('SANDBOX · NOT PRODUCTION');
    expect(card.ready).toBe(true);
    expect(card.startup).toBe('Started in 2.4s');
    expect(card.e2e).toBe('3/3 scenarios passed · latency +4.1ms vs baseline');
  });

  it('shows no URL until the sandbox is actually ready', () => {
    const card = sandboxCard({
      service: {}, status: 'BUILDING_IMAGE', isProduction: false,
    })!;
    expect(card.ready).toBe(false);
    expect(card.url).toBeUndefined();
    // The label is there whatever the state — spec §36 requires the environment
    // never to be represented as production.
    expect(card.label).toBe('SANDBOX · NOT PRODUCTION');
    expect(sandboxCard(null)).toBeNull();
  });
});
