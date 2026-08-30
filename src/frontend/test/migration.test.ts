import { describe, expect, it } from 'vitest';
import { MigrationStage, type Baseline, type BehavioralInvariant, type MigrationRun } from '@proteus/schema';
import {
  ARTIFACT_ORDER, CHECK_LABEL, CHECK_ORDER, CLASSIFICATION_COLOR, MIGRATION_STAGES,
  OUTCOME_COLOR, OUTCOME_LABEL, STAGE_LABEL, STATUS_COLOR, artifactCards, branchMeta,
  capacityNotice, checkRows, checklist, expiryLabel, groupSummaries, migrationStats,
  openProblems, outcomeTiles, progressFromEvents, rail, retryDisplay, sandboxCard,
  shortSha, summarise, verdictLine, type ProblemSummary, rootBlocker, nextSteps,
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

describe('AC-7, AC-2 · the completion screen', () => {
  const autonomy = {
    eligibleItems: 1, completedAutonomously: 1, completionPct: 100,
    humanEngineeringActions: 0, approvals: 1,
  };
  const recs = [
    { name: 'Luna Network HSM 7 · firmware 7.4.0', disposition: 'HARDWARE_REPLACEMENT' },
    { name: 'Gateway-X200 · firmware 4.2.1', disposition: 'VENDOR_DECISION' },
    { name: 'pay-api leaf certificate', disposition: 'FOLLOW_ON_WORKSTREAM' },
  ];

  it('reads 100%, zero human actions, one repair and three recommendations', () => {
    const tiles = outcomeTiles({ autonomy, autonomousRepairs: 1, recommendations: recs });
    expect(tiles.map((t) => t.value)).toEqual(['100%', '0', '1', '3']);
    expect(tiles.map((t) => t.label)).toEqual([
      'AUTONOMOUS COMPLETION', 'HUMAN ENGINEERING ACTIONS',
      'AUTONOMOUS REPAIRS', 'RECOMMENDATIONS RAISED',
    ]);
    // A bare zero does not make the product's central claim; the note does.
    expect(tiles[1]!.note).toBe('One approval at the assessment gate; no further intervention.');
    expect(tiles[1]!.fg).toBe('var(--ok)');
    // Named rather than counted — a reader needs to know which three.
    expect(tiles[3]!.note).toContain('Luna Network HSM 7');
    expect(tiles[3]!.note).toContain('Gateway-X200');
  });

  it('does not claim success when a human had to intervene', () => {
    const tiles = outcomeTiles({
      autonomy: { ...autonomy, completionPct: 50, completedAutonomously: 1, eligibleItems: 2,
        humanEngineeringActions: 1 },
      autonomousRepairs: 0, recommendations: [],
    });
    expect(tiles[0]!.value).toBe('50%');
    expect(tiles[0]!.fg).toBe('var(--warn)');
    expect(tiles[1]!.fg).toBe('var(--warn)');
    expect(tiles[1]!.note).toMatch(/intervention was required/);
  });

  it('renders an em dash before a migration has run, not 0%', () => {
    const tiles = outcomeTiles({
      autonomy: { ...autonomy, completionPct: null, completedAutonomously: 0 },
      autonomousRepairs: 0, recommendations: [],
    });
    expect(tiles[0]!.value).toBe('—');
  });

  it('orders the evidence package and offers only what is downloadable', () => {
    const cards = artifactCards([
      { artifactId: 'a1', kind: 'GIT_DIFF', title: 'Git diff',
        displayMeta: '2 COMMITS · 2 FILES · +12 −5', format: 'DIFF', status: 'READY' },
      { artifactId: 'a2', kind: 'MIGRATION_REPORT', title: 'Migration report',
        displayMeta: '9 PAGES · FULL AUDIT TRAIL', format: 'MARKDOWN', status: 'READY' },
      { artifactId: 'a3', kind: 'ASSESSMENT_REPORT', title: 'Assessment report v1',
        displayMeta: '6 PAGES', format: 'MARKDOWN', status: 'READY' },
      { artifactId: 'a4', kind: 'BUILD_TEST_EVIDENCE', title: 'Build & test evidence',
        displayMeta: '6 EXECUTIONS · 3 ATTEMPTS', format: 'JSON', status: 'GENERATING' },
    ]);
    expect(cards.map((c) => c.title)).toEqual([
      'Migration report', 'Assessment report v1', 'Git diff',
    ]);
    // A generating artifact would hand the reader a broken link.
    expect(cards.map((c) => c.artifactId)).not.toContain('a4');
    expect(cards[0]!.ext).toBe('MD');
    expect(cards[2]!.ext).toBe('DIFF');
    expect(ARTIFACT_ORDER).toHaveLength(4);
  });

  it('labels each of spec §40 three outcomes', () => {
    for (const o of ['VERIFIED', 'PARTIALLY_MIGRATED', 'HUMAN_ACTION_REQUIRED']) {
      expect(OUTCOME_LABEL[o]).toBeTruthy();
      expect(OUTCOME_COLOR[o]).toBeTruthy();
    }
    expect(OUTCOME_COLOR.VERIFIED).toBe('var(--ok)');
    expect(OUTCOME_COLOR.HUMAN_ACTION_REQUIRED).toBe('var(--bad)');
  });
});

describe('PRD-16 · live test progress and sandbox lifecycle on screen', () => {
  /** The events the loop emits, in the shape the feed carries them. */
  const detail = (type: string, title: string, message: string) =>
    ({ type, title, message, level: 'DETAIL' });

  const RUN = [
    detail('TEST_STARTED', 'Running unit tests', '3/5 tests · 1/4 suites'),
    detail('TEST_STARTED', 'CryptoServiceTest', 'Migration targets · 0/5 tests · 0/4 suites'),
    detail('TEST_STARTED', 'CryptoServiceTest — 2 passed',
           'Migration targets · 0.03s · 2/5 tests · 1/4 suites'),
    detail('TEST_STARTED', 'LedgerRepositoryTest', 'Regression surface · 2/5 tests · 1/4 suites'),
    detail('TEST_FAILED', 'WrapLengthTest — 1 of 2 failed',
           'New evidence · 0.03s · 4/5 tests · 2/4 suites'),
    detail('TEST_FAILED', '✗ wrapsToTwoFiftySix', 'WrapLengthTest'),
    detail('TEST_FAILED', 'org.opentest4j.AssertionFailedError: expected: <256> but was: <1088>', ''),
  ];

  it('rebuilds the run from its own events, so a refresh restores the picture', () => {
    const progress = progressFromEvents(RUN);
    expect(progress.phase).toBe('Running unit tests');
    // The denominator the baseline supplied, carried on every line.
    expect(progress.counted).toBe('4/5 tests · 2/4 suites');
    expect(progress.suites.map((s) => s.short)).toEqual([
      'CryptoServiceTest', 'LedgerRepositoryTest', 'WrapLengthTest',
    ]);
    expect(progress.suites[0]!.state).toBe('PASSED');
    expect(progress.suites[1]!.state).toBe('RUNNING');
    expect(progress.suites[2]!.state).toBe('FAILED');
  });

  it('attaches the failing method and its assertion to the suite that failed', () => {
    const failed = progressFromEvents(RUN).suites.find((s) => s.state === 'FAILED')!;
    // The asymmetry worth rendering: passing methods are only a count, failing
    // ones are named with the reason.
    expect(failed.failed).toHaveLength(1);
    expect(failed.failed[0]!.method).toBe('wrapsToTwoFiftySix');
    expect(failed.failed[0]!.message).toContain('expected: <256> but was: <1088>');
  });

  it('groups by the question each suite answers, and hides empty groups', () => {
    const groups = groupSummaries(progressFromEvents(RUN).suites);
    expect(groups.map((g) => g.label)).toEqual([
      'Migration targets', 'New evidence', 'Regression surface',
    ]);
    expect(groups[0]!.fraction).toBe(1);
    expect(groups[1]!.failed).toBe(true);
    // A running suite is not finished.
    expect(groups[2]!.finished).toBe(0);
    // An empty bar for a group with nothing in it reads as a defect.
    expect(groupSummaries([])).toEqual([]);
  });

  it('says what will happen before a migration, not after', () => {
    expect(capacityNotice({ configured: false })).toBeNull();
    expect(capacityNotice({ configured: true, canRetain: true })).toBeNull();

    const mine = capacityNotice({
      configured: true, canRetain: false, boundBy: 'USER',
      perUserUsed: 3, perUserLimit: 3,
    })!;
    // Capacity is not a failure, but it is a surprise if the first mention of it
    // is in the report.
    expect(mine).toContain('3 of 3');
    expect(mine).toContain('still be verified end to end');
    expect(mine).toContain('Tear one down');

    const platform = capacityNotice({
      configured: true, canRetain: false, boundBy: 'PLATFORM',
      totalUsed: 30, totalLimit: 30, nextExpiryAt: '2026-09-05T00:00:00Z',
    })!;
    expect(platform).toContain('30 of 30');
    expect(platform).toMatch(/earliest slot frees/);
  });

  it('states the expiry plainly, including once it has passed', () => {
    const now = Date.parse('2026-08-29T12:00:00Z');
    expect(expiryLabel('2026-09-04T12:00:00Z', now)).toBe('EXPIRES IN 6 DAYS');
    expect(expiryLabel('2026-08-30T12:00:00Z', now)).toBe('EXPIRES IN 1 DAY');
    expect(expiryLabel('2026-08-29T15:00:00Z', now)).toBe('EXPIRES IN 3 HOURS');
    // Not hidden — a sandbox past its clock is awaiting the sweep, and the
    // screen should not imply the link still works.
    expect(expiryLabel('2026-08-28T12:00:00Z', now)).toBe('EXPIRED · AWAITING RECLAIM');
    expect(expiryLabel(undefined)).toBe('');
  });
});

describe('what a person is actually supposed to do', () => {
  /**
   * A run that ends unverified sets `actionRequired` and often has no open gate
   * — the loop did not stop to ask a question, it ran out of attempts. The
   * screen said "human action required" with no gate and no options, which is a
   * dead end: it names a need without naming the act.
   */
  const checks = (failing: string[]) =>
    ['BASELINE_INVARIANTS_PRESERVED', 'BUILD_SUCCESSFUL', 'REQUIRED_TESTS_PASSED',
     'PROHIBITED_CRYPTO_ABSENT', 'REQUIRED_PQC_PRESENT', 'MIGRATION_POLICY_SATISFIED',
     'NO_CRITICAL_BLOCKER', 'SANDBOX_DEPLOYMENT_SUCCESSFUL', 'E2E_VERIFICATION_SUCCESSFUL']
      .map((check) => ({ check, status: failing.includes(check) ? 'FAIL' : 'PASS' }));

  it('names the build as the root cause when everything cascades from it', () => {
    // Exactly PQC-0009: the build fails, the tests "fail" because nothing
    // compiled, and the sandbox is simply never reached.
    const r = rootBlocker(checks([
      'BUILD_SUCCESSFUL', 'REQUIRED_TESTS_PASSED',
      'SANDBOX_DEPLOYMENT_SUCCESSFUL', 'E2E_VERIFICATION_SUCCESSFUL',
    ]));
    expect(r?.check).toBe('BUILD_SUCCESSFUL');
    expect(r?.downstream).toHaveLength(3);
  });

  it('does not blame the sandbox, which only ever fails downstream', () => {
    const r = rootBlocker(checks(['SANDBOX_DEPLOYMENT_SUCCESSFUL', 'E2E_VERIFICATION_SUCCESSFUL']));
    // Nothing upstream failed, so the sandbox is the honest answer here.
    expect(r?.check).toBe('SANDBOX_DEPLOYMENT_SUCCESSFUL');
  });

  it('uses causal order, not the display order the screen renders in', () => {
    // Display order puts the baseline invariants first; a diagnosis must not.
    const r = rootBlocker(checks(['BASELINE_INVARIANTS_PRESERVED', 'BUILD_SUCCESSFUL']));
    expect(r?.check).toBe('BUILD_SUCCESSFUL');
  });

  it('returns nothing when everything passed', () => {
    expect(rootBlocker(checks([]))).toBeNull();
  });

  it('explains that downstream failures are consequences, not separate problems', () => {
    const steps = nextSteps('BUILD_SUCCESSFUL');
    expect(steps[0]?.detail).toContain('consequences');
    // And always offers a way forward, not just a diagnosis.
    expect(steps.some((s) => s.label.includes('re-run'))).toBe(true);
  });

  it('sends an open blocking gate to the gate, not to the diff', () => {
    const steps = nextSteps('NO_CRITICAL_BLOCKER');
    expect(steps[0]?.detail).toContain('Answer it on this screen');
  });
});
