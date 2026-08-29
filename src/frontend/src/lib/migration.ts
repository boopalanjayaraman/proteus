import { MigrationStage, type Baseline, type MigrationRun } from '@proteus/schema';

/**
 * What the migration screen derives, kept out of the component so it can be
 * asserted on. The stage rail in particular is a claim about progress, and a
 * rail that says "done" about a stage that never ran is the kind of thing a
 * viewer trusts and should not.
 */

/** Spec §22, in order, as the rail renders them. */
export const MIGRATION_STAGES = MigrationStage.options;

export const STAGE_LABEL: Record<string, string> = {
  PREPARING_MIGRATION: 'PREPARING MIGRATION',
  CREATING_BRANCH: 'CREATING BRANCH',
  CAPTURING_BASELINE: 'CAPTURING BASELINE',
  ASSESSING_TEST_COVERAGE: 'ASSESSING TEST COVERAGE',
  CREATING_TESTS: 'CREATING / EXTENDING TESTS',
  PREPARING_MOCKS: 'PREPARING MOCKS',
  VALIDATING_BASELINE_TESTS: 'VALIDATING BASELINE TESTS',
  APPLYING_MIGRATION_CHANGES: 'APPLYING MIGRATION CHANGES',
  BUILDING: 'BUILDING',
  RUNNING_TESTS: 'RUNNING TESTS',
  ANALYZING_FAILURE: 'ANALYZING FAILURE',
  REPAIRING: 'REPAIRING',
  REBUILDING: 'REBUILDING',
  RETESTING: 'RETESTING',
  CRYPTO_VERIFYING: 'CRYPTO VERIFYING',
  SANDBOX_DEPLOYING: 'SANDBOX DEPLOYING',
  END_TO_END_VERIFYING: 'END-TO-END VERIFYING',
  COMPLETED: 'COMPLETED',
};

export type RailState = 'DONE' | 'ACTIVE' | 'PENDING';

export interface RailStep {
  stage: string;
  label: string;
  state: RailState;
}

/**
 * The stage rail.
 *
 * Position in the ordered list decides the state, because the stages are
 * strictly sequential and the run records exactly one. A stage the run skipped
 * still shows as done — it is behind the current position, and claiming
 * otherwise would suggest work is outstanding when the run has moved past it.
 */
export function rail(stage: string | undefined): RailStep[] {
  const at = MIGRATION_STAGES.indexOf(stage as never);
  return MIGRATION_STAGES.map((s, i) => ({
    stage: s,
    label: STAGE_LABEL[s] ?? s,
    state: at < 0 ? 'PENDING' : i < at ? 'DONE' : i === at ? 'ACTIVE' : 'PENDING',
  }));
}

/** `7c41ab9d2f…` → `7c41ab9`, the form every surface shows. */
export const shortSha = (sha: string | undefined): string => (sha ?? '').slice(0, 7);

export function branchMeta(run: MigrationRun | null): string {
  if (!run) return '';
  const commits = run.branch.commitCount;
  return `BASE ${shortSha(run.branch.baseCommitSha)} · ${commits} COMMIT${commits === 1 ? '' : 'S'}`;
}

export interface BaselineChecklistItem {
  label: string;
  detail: string;
  /** MUST_PRESERVE reads as a promise; EXPECTED_TO_CHANGE reads as a prediction. */
  disposition: 'MUST_PRESERVE' | 'EXPECTED_TO_CHANGE';
  kind: string;
}

/**
 * The BASELINE CONTRACT checklist.
 *
 * Ordered so the promises come before the predictions. A reader scanning this
 * needs to know what is being protected before what is being changed, and an
 * interleaved list reads as though the agent is unsure which is which.
 */
export function checklist(baseline: Baseline | null): BaselineChecklistItem[] {
  if (!baseline) return [];
  const order = { MUST_PRESERVE: 0, EXPECTED_TO_CHANGE: 1 } as const;
  return [...baseline.invariants]
    .sort((a, b) => order[a.disposition] - order[b.disposition]
      || a.kind.localeCompare(b.kind))
    .map((i) => ({
      label: i.description,
      detail: i.assertion,
      disposition: i.disposition,
      kind: i.kind.replace(/_/g, ' '),
    }));
}

export interface BaselineSummary {
  total: number;
  passed: number;
  failed: number;
  known: number;
  buildPassed: boolean;
  /** The sentence the screen shows above the checklist. */
  headline: string;
}

export function summarise(baseline: Baseline | null): BaselineSummary | null {
  if (!baseline) return null;
  const known = baseline.tests.knownFailures.length;
  return {
    total: baseline.tests.total,
    passed: baseline.tests.passed,
    failed: baseline.tests.failed,
    known,
    buildPassed: baseline.build.passed,
    headline: baseline.build.passed
      ? `${baseline.tests.passed}/${baseline.tests.total} tests passing at `
        + `${shortSha(baseline.commitSha)}`
        // Named rather than counted away: the migration is never blamed for a
        // failure that was already there, and the report says so explicitly.
        + (known > 0
          ? ` · ${known} pre-existing failure${known === 1 ? '' : 's'} recorded as known`
          : '')
      : `The base commit does not build. Recorded at ${shortSha(baseline.commitSha)}.`,
  };
}

export const DISPOSITION_COLOR: Record<string, string> = {
  MUST_PRESERVE: 'var(--ok)',
  EXPECTED_TO_CHANGE: 'var(--acc)',
};

// ---------------------------------------------------------------------------
// The loop (PRD-12)
// ---------------------------------------------------------------------------

export interface ProblemSummary {
  problemKey: string;
  classification: string;
  signature: string;
  meaningfulAttempts: number;
  budget: number;
  status: string;
}

export interface RetryDisplay {
  label: string;
  /** 0..1, for the bar. */
  fraction: number;
  exhausted: boolean;
  colour: string;
}

/**
 * The `n / 4` counter, per problem.
 *
 * Rendered per problem rather than per run because that is what the budget
 * actually counts. A run-level total would say "3 / 4" after three unrelated
 * one-attempt failures and imply the agent was one try from giving up.
 */
export function retryDisplay(problem: ProblemSummary): RetryDisplay {
  const fraction = Math.min(1, problem.meaningfulAttempts / problem.budget);
  const exhausted = problem.meaningfulAttempts >= problem.budget;
  return {
    label: `${problem.meaningfulAttempts} / ${problem.budget} MEANINGFUL ATTEMPTS`,
    fraction,
    exhausted,
    colour: exhausted ? 'var(--bad)' : fraction >= 0.5 ? 'var(--warn)' : 'var(--acc)',
  };
}

/** Problems worth showing: the unresolved ones, and anything that ran out. */
export function openProblems(problems: ProblemSummary[]): ProblemSummary[] {
  return problems.filter((p) => p.status !== 'RESOLVED');
}

export const CLASSIFICATION_COLOR: Record<string, string> = {
  MOCK_INCOMPATIBILITY: 'var(--warn)',
  TEST_FIXTURE_OUTDATED: 'var(--warn)',
  EXPECTED_BEHAVIOR_CHANGE: 'var(--acc)',
  IMPLEMENTATION_DEFECT: 'var(--bad)',
  BUILD_DEFECT: 'var(--bad)',
  DEPENDENCY_INCOMPATIBILITY: 'var(--vio)',
  CONFIGURATION_DEFECT: 'var(--vio)',
  TEST_COVERAGE_GAP: 'var(--fg3)',
  ENVIRONMENT_FAILURE: 'var(--fg3)',
  EXTERNAL_DEPENDENCY_BLOCKER: 'var(--vio)',
  UNKNOWN: 'var(--bad)',
};

/**
 * The live tiles above the feed.
 *
 * `humanEngineeringActions` is deliberately not derived from gates opened: a
 * non-blocking gate is not an intervention, and counting it would undercut the
 * claim the whole product rests on.
 */
export function migrationStats(input: {
  commitCount: number;
  testsPassing: number;
  testsFailing: number;
  autonomousRepairs: number;
  humanGatesOpened: number;
}): Array<{ value: number | string; label: string; fg: string }> {
  return [
    { value: input.commitCount, label: 'COMMITS', fg: 'var(--fg)' },
    { value: input.testsPassing, label: 'TESTS PASSING', fg: 'var(--ok)' },
    {
      value: input.testsFailing,
      label: 'FAILING',
      fg: input.testsFailing > 0 ? 'var(--bad)' : 'var(--fg3)',
    },
    { value: input.autonomousRepairs, label: 'AUTONOMOUS REPAIRS', fg: 'var(--acc)' },
  ];
}

// ---------------------------------------------------------------------------
// Verification and the sandbox (PRD-13)
// ---------------------------------------------------------------------------

/** The order spec §35 lists them in, which is the order a reader expects. */
export const CHECK_ORDER: string[] = [
  'BASELINE_INVARIANTS_PRESERVED',
  'BUILD_SUCCESSFUL',
  'REQUIRED_TESTS_PASSED',
  'PROHIBITED_CRYPTO_ABSENT',
  'REQUIRED_PQC_PRESENT',
  'MIGRATION_POLICY_SATISFIED',
  'NO_CRITICAL_BLOCKER',
  'SANDBOX_DEPLOYMENT_SUCCESSFUL',
  'E2E_VERIFICATION_SUCCESSFUL',
];

export const CHECK_LABEL: Record<string, string> = {
  BASELINE_INVARIANTS_PRESERVED: 'Baseline behavioural invariants preserved',
  BUILD_SUCCESSFUL: 'Build successful',
  REQUIRED_TESTS_PASSED: 'Required tests passed',
  PROHIBITED_CRYPTO_ABSENT: 'Prohibited cryptography absent',
  REQUIRED_PQC_PRESENT: 'Required PQC implementation present',
  MIGRATION_POLICY_SATISFIED: 'Migration policy satisfied',
  NO_CRITICAL_BLOCKER: 'No critical unresolved blocker',
  SANDBOX_DEPLOYMENT_SUCCESSFUL: 'Sandbox deployment successful',
  E2E_VERIFICATION_SUCCESSFUL: 'End-to-end verification successful',
};

export const STATUS_COLOR: Record<string, string> = {
  PASS: 'var(--ok)',
  FAIL: 'var(--bad)',
  NOT_APPLICABLE: 'var(--fg4)',
  // Narrative, not a gate. Deliberately not the failure colour — a noted
  // residual is an honest observation, and colouring it red would tell a reader
  // the migration went wrong when it went right.
  NOTED: 'var(--warn)',
};

export const STATUS_GLYPH: Record<string, string> = {
  PASS: '✓', FAIL: '✗', NOT_APPLICABLE: '–', NOTED: '!',
};

export interface CheckRow {
  check: string;
  label: string;
  status: string;
  detail: string;
  colour: string;
  glyph: string;
  /** Present when the check cites an execution the reader can open. */
  executionRunId?: string;
  findings: Array<{ path: string; line?: number; match: string }>;
}

/** The nine checks, in spec order, whatever order they arrived in. */
export function checkRows(
  checks: Array<{
    check: string; status: string; detail: string;
    executionRunId?: string;
    findings?: Array<{ path: string; line?: number; match: string }>;
  }>,
): CheckRow[] {
  return [...checks]
    .sort((a, b) => CHECK_ORDER.indexOf(a.check) - CHECK_ORDER.indexOf(b.check))
    .map((c) => ({
      check: c.check,
      label: CHECK_LABEL[c.check] ?? c.check.replace(/_/g, ' '),
      status: c.status,
      detail: c.detail,
      colour: STATUS_COLOR[c.status] ?? 'var(--fg3)',
      glyph: STATUS_GLYPH[c.status] ?? '·',
      ...(c.executionRunId ? { executionRunId: c.executionRunId } : {}),
      findings: c.findings ?? [],
    }));
}

/**
 * The one-line verdict.
 *
 * Says how many passed out of how many required, because "NOT VERIFIED" alone
 * tells a reader nothing about whether one thing or eight are wrong.
 */
export function verdictLine(
  overall: string,
  checks: Array<{ status: string }>,
): string {
  const passed = checks.filter((c) => c.status === 'PASS').length;
  return overall === 'VERIFIED'
    ? `VERIFIED · ${passed} of ${checks.length} checks passed`
    : `NOT VERIFIED · ${passed} of ${checks.length} checks passed`;
}

export interface SandboxCard {
  url?: string;
  status: string;
  /** Always shown. `isProduction` is a literal false on the document. */
  label: string;
  startup?: string;
  e2e?: string;
  ready: boolean;
}

/**
 * The sandbox card.
 *
 * The not-production label is derived from `isProduction` rather than
 * hardcoded, so a surface cannot forget it — spec §36 requires the environment
 * never to be represented as production.
 */
export function sandboxCard(sandbox: {
  service: { url?: string };
  status: string;
  isProduction: boolean;
  startupCheck?: { passed: boolean; detail?: string; startupMs?: number };
  e2e?: { passed: boolean; scenarios: Array<{ passed: boolean }>; latencyDeltaMs?: number };
} | null): SandboxCard | null {
  if (!sandbox) return null;
  const passed = sandbox.e2e?.scenarios.filter((s) => s.passed).length ?? 0;
  return {
    ...(sandbox.service.url ? { url: sandbox.service.url } : {}),
    status: sandbox.status,
    label: sandbox.isProduction ? 'PRODUCTION' : 'SANDBOX · NOT PRODUCTION',
    ...(sandbox.startupCheck
      ? {
          startup: sandbox.startupCheck.passed
            ? `Started in ${((sandbox.startupCheck.startupMs ?? 0) / 1000).toFixed(1)}s`
            : sandbox.startupCheck.detail ?? 'did not start',
        }
      : {}),
    ...(sandbox.e2e
      ? {
          e2e: `${passed}/${sandbox.e2e.scenarios.length} scenarios passed`
            + (sandbox.e2e.latencyDeltaMs !== undefined
              ? ` · latency ${sandbox.e2e.latencyDeltaMs >= 0 ? '+' : ''}`
                + `${sandbox.e2e.latencyDeltaMs}ms vs baseline`
              : ''),
        }
      : {}),
    ready: sandbox.status === 'READY',
  };
}

// ---------------------------------------------------------------------------
// Completion — Sandbox & Report (PRD-14)
// ---------------------------------------------------------------------------

export interface OutcomeTile {
  value: string;
  label: string;
  note: string;
  fg: string;
}

/**
 * The four outcome tiles.
 *
 * Every value comes from `summary.autonomy`, which the loop and the verification
 * wrote from data. The notes explain what each number means, because "0" under
 * HUMAN ENGINEERING ACTIONS is the product's central claim and a bare zero does
 * not make it.
 */
export function outcomeTiles(input: {
  autonomy: {
    eligibleItems: number; completedAutonomously: number; completionPct: number | null;
    humanEngineeringActions: number; approvals: number;
  };
  autonomousRepairs: number;
  recommendations: Array<{ name: string; disposition: string }>;
  repairSummary?: string;
}): OutcomeTile[] {
  const a = input.autonomy;
  const recs = input.recommendations;
  return [
    {
      value: a.completionPct === null ? '—' : `${a.completionPct}%`,
      label: 'AUTONOMOUS COMPLETION',
      note: `${a.completedAutonomously} of ${a.eligibleItems} eligible migration`
        + `${a.eligibleItems === 1 ? '' : 's'} completed from approved finding to `
        + 'verified sandbox.',
      fg: a.completionPct === 100 ? 'var(--ok)' : 'var(--warn)',
    },
    {
      value: String(a.humanEngineeringActions),
      label: 'HUMAN ENGINEERING ACTIONS',
      note: a.humanEngineeringActions === 0
        ? `${a.approvals === 1 ? 'One approval' : `${a.approvals} approvals`} at the `
          + 'assessment gate; no further intervention.'
        : 'Engineering intervention was required — see the report for what and why.',
      fg: a.humanEngineeringActions === 0 ? 'var(--ok)' : 'var(--warn)',
    },
    {
      value: String(input.autonomousRepairs),
      label: 'AUTONOMOUS REPAIRS',
      note: input.autonomousRepairs === 0
        ? 'Nothing needed repairing.'
        : input.repairSummary ?? 'Diagnosed and repaired without asking.',
      fg: 'var(--vio)',
    },
    {
      value: String(recs.length),
      label: 'RECOMMENDATIONS RAISED',
      note: recs.length === 0
        ? 'Nothing fell outside the autonomy boundary.'
        // Named rather than counted: a reader needs to know which three.
        : `${recs.map((r) => r.name.split(' · ')[0]).join(', ')} — each with an owner `
          + 'and an action.',
      fg: 'var(--warn)',
    },
  ];
}

export interface ArtifactCard {
  artifactId: string;
  title: string;
  meta: string;
  ext: string;
  colour: string;
}

const ARTIFACT_COLOR: Record<string, string> = {
  MIGRATION_REPORT: 'var(--acc)',
  ASSESSMENT_REPORT: 'var(--acc)',
  GIT_DIFF: 'var(--vio)',
  BUILD_TEST_EVIDENCE: 'var(--warn)',
};

/** The evidence package, in the order the UX lists it. */
export const ARTIFACT_ORDER = [
  'MIGRATION_REPORT', 'ASSESSMENT_REPORT', 'GIT_DIFF', 'BUILD_TEST_EVIDENCE',
];

export function artifactCards(
  artifacts: Array<{
    artifactId: string; kind: string; title: string; displayMeta: string;
    format: string; status: string;
  }>,
): ArtifactCard[] {
  return artifacts
    // A generating or failed artifact is not downloadable, and offering it would
    // hand the reader a broken link.
    .filter((a) => a.status === 'READY')
    .sort((a, b) => ARTIFACT_ORDER.indexOf(a.kind) - ARTIFACT_ORDER.indexOf(b.kind))
    .map((a) => ({
      artifactId: a.artifactId,
      title: a.title,
      meta: a.displayMeta,
      ext: a.format === 'MARKDOWN' ? 'MD' : a.format,
      colour: ARTIFACT_COLOR[a.kind] ?? 'var(--acc)',
    }));
}

export const OUTCOME_LABEL: Record<string, string> = {
  VERIFIED: 'VERIFIED MIGRATION',
  PARTIALLY_MIGRATED: 'PARTIALLY MIGRATED',
  HUMAN_ACTION_REQUIRED: 'HUMAN ACTION REQUIRED',
};

export const OUTCOME_COLOR: Record<string, string> = {
  VERIFIED: 'var(--ok)',
  PARTIALLY_MIGRATED: 'var(--warn)',
  HUMAN_ACTION_REQUIRED: 'var(--bad)',
};

// ---------------------------------------------------------------------------
// Live test progress (PRD-16 §17)
// ---------------------------------------------------------------------------

export type ProgressGroup = 'MIGRATION_TARGET' | 'NEW_EVIDENCE' | 'REGRESSION_SURFACE';

export const GROUP_LABEL: Record<ProgressGroup, string> = {
  MIGRATION_TARGET: 'Migration targets',
  NEW_EVIDENCE: 'New evidence',
  REGRESSION_SURFACE: 'Regression surface',
};

/** The order the questions are worth asking in. */
export const GROUP_ORDER: ProgressGroup[] = [
  'MIGRATION_TARGET', 'NEW_EVIDENCE', 'REGRESSION_SURFACE',
];

export interface SuiteRow {
  suite: string;
  short: string;
  group: ProgressGroup;
  state: 'RUNNING' | 'PASSED' | 'FAILED';
  total?: number;
  failures?: number;
  seconds?: number;
  failed: Array<{ method: string; message?: string; at?: string }>;
}

/**
 * Rebuilds the run's progress from the events that carried it.
 *
 * The screen holds no state of its own for this. The events are already
 * persisted and already replayed on reconnect, so a viewer who refreshes
 * mid-build sees the same picture rather than an empty panel — the same property
 * that makes every other live screen in this product survive a refresh.
 */
export function progressFromEvents(
  events: Array<{ type: string; title: string; message?: string; level: string }>,
): { phase?: string; suites: SuiteRow[]; testsFinished: number; counted?: string } {
  const bySuite = new Map<string, SuiteRow>();
  let phase: string | undefined;
  let counted: string | undefined;
  let lastFailed: SuiteRow | undefined;

  for (const e of events) {
    if (e.level !== 'DETAIL') continue;
    if (e.type !== 'TEST_STARTED' && e.type !== 'TEST_FAILED') continue;

    // Matched rather than split off the end: the count itself contains the
    // separator, so splitting on it returns half the answer.
    const match = /(\d+\/\d+ tests · \d+\/\d+ suites|\d+ suites so far)/
      .exec(e.message ?? '');
    if (match) counted = match[1];

    if (/^(Compiling|Running unit tests|Running integration tests|Packaging|Preparing)/
      .test(e.title)) {
      phase = e.title;
      continue;
    }

    // "✗ methodName" — a named failing method, attached to the suite above it.
    if (e.title.startsWith('✗ ')) {
      const method = e.title.slice(2);
      const suite = [...bySuite.values()].find((s) => s.short === e.message?.split(' · ')[0]);
      const row = suite ?? lastFailed;
      if (row) {
        row.failed.push({ method });
        lastFailed = row;
      }
      continue;
    }

    // An assertion message with no suite of its own belongs to the last failure.
    if (lastFailed && !e.title.includes(' — ') && /expected|Exception|Error/.test(e.title)) {
      const entry = lastFailed.failed.at(-1);
      if (entry && !entry.message) entry.message = e.title;
      continue;
    }

    const [name, result] = e.title.split(' — ');
    if (!name) continue;
    const group = groupFromLabel(e.message?.split(' · ')[0]);
    const row: SuiteRow = bySuite.get(name) ?? {
      suite: name, short: name, group, state: 'RUNNING', failed: [],
    };
    row.group = group;
    if (result) {
      row.state = /failed/.test(result) ? 'FAILED' : 'PASSED';
      row.total = Number(/(\d+)/.exec(result)?.[1] ?? 0);
      const seconds = /([\d.]+)s/.exec(e.message ?? '');
      if (seconds) row.seconds = Number(seconds[1]);
      if (row.state === 'FAILED') lastFailed = row;
    }
    bySuite.set(name, row);
  }

  const suites = [...bySuite.values()];
  return {
    ...(phase ? { phase } : {}),
    suites,
    testsFinished: suites.reduce((n, s) => n + (s.total ?? 0), 0),
    ...(counted ? { counted } : {}),
  };
}

const groupFromLabel = (label?: string): ProgressGroup => {
  const entry = (Object.entries(GROUP_LABEL) as Array<[ProgressGroup, string]>)
    .find(([, l]) => l === label);
  return entry?.[0] ?? 'REGRESSION_SURFACE';
};

export interface GroupSummary {
  group: ProgressGroup;
  label: string;
  finished: number;
  total: number;
  fraction: number;
  failed: boolean;
  suites: SuiteRow[];
}

/** One bar per question, in the order a reader wants them answered. */
export function groupSummaries(suites: SuiteRow[]): GroupSummary[] {
  return GROUP_ORDER.map((group) => {
    const own = suites.filter((s) => s.group === group);
    const finished = own.filter((s) => s.state !== 'RUNNING').length;
    return {
      group,
      label: GROUP_LABEL[group],
      finished,
      total: own.length,
      fraction: own.length === 0 ? 0 : finished / own.length,
      failed: own.some((s) => s.state === 'FAILED'),
      suites: own,
    };
  // A group with nothing in it is not a group; showing an empty bar for
  // "regression surface" on a repository with no other tests reads as a defect.
  }).filter((g) => g.total > 0);
}

// ---------------------------------------------------------------------------
// Sandbox capacity and expiry (PRD-16)
// ---------------------------------------------------------------------------

export interface CapacityState {
  configured: boolean;
  perUserUsed?: number;
  perUserLimit?: number;
  totalUsed?: number;
  totalLimit?: number;
  canRetain?: boolean;
  boundBy?: 'USER' | 'PLATFORM';
  ownProjects?: string[];
  nextExpiryAt?: string;
}

/**
 * What to tell someone before they start, not after.
 *
 * Capacity is not a failure — the migration still verifies — but it is a
 * surprise if the first mention of it is in the report.
 */
export function capacityNotice(state: CapacityState): string | null {
  if (!state.configured || state.canRetain !== false) return null;
  if (state.boundBy === 'USER') {
    return `You are hosting ${state.perUserUsed} of ${state.perUserLimit} sandboxes. `
      + 'The next migration will still be verified end to end, but its sandbox will be '
      + 'released straight afterwards. Tear one down below to keep the next link.';
  }
  return `The platform is hosting ${state.totalUsed} of ${state.totalLimit} sandboxes. `
    + 'Your migration will still be verified end to end; its sandbox will be released '
    + 'afterwards rather than kept'
    + (state.nextExpiryAt
      ? `. The earliest slot frees ${new Date(state.nextExpiryAt).toLocaleDateString()}.`
      : '.');
}

/** "expires in 6 days" — or the plain truth when it already has. */
export function expiryLabel(expiresAt: string | Date | undefined, now = Date.now()): string {
  if (!expiresAt) return '';
  const ms = new Date(expiresAt).getTime() - now;
  if (ms <= 0) return 'EXPIRED · AWAITING RECLAIM';
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return `EXPIRES IN ${days} DAY${days === 1 ? '' : 'S'}`;
  const hours = Math.max(1, Math.round(ms / 3_600_000));
  return `EXPIRES IN ${hours} HOUR${hours === 1 ? '' : 'S'}`;
}
