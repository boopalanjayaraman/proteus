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
