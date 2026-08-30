import type { Baseline, MigrationChange, PlanItem } from '@proteus/schema';

/**
 * Live test progress, read off the build's own output (PRD-16 §17).
 *
 * The reason this is a parser rather than an instrumentation: driving the
 * repository's suite one test at a time would give the same information and
 * change what the tests mean. Spring caches its context across classes in one
 * JVM, and a suite with shared state behaves differently in isolation — so a
 * baseline captured one way and a verification run captured another would
 * compare two unlike measurements and report regressions the migration did not
 * cause (`EXEC-VER-003`).
 *
 * So the run is untouched and the progress is read from it. Everything here
 * comes from a line Maven has already printed, or from the baseline inventory.
 * Nothing is estimated.
 */

export type ProgressGroup = 'MIGRATION_TARGET' | 'NEW_EVIDENCE' | 'REGRESSION_SURFACE';

export const GROUP_LABEL: Record<ProgressGroup, string> = {
  MIGRATION_TARGET: 'Migration targets',
  NEW_EVIDENCE: 'New evidence',
  REGRESSION_SURFACE: 'Regression surface',
};

export type ProgressEvent =
  /** A build phase changed — compiling, unit tests, integration tests. */
  | { kind: 'PHASE'; phase: string }
  /** A test class started. */
  | { kind: 'SUITE_STARTED'; suite: string; group: ProgressGroup }
  /** A test class finished, with its counts. */
  | {
      kind: 'SUITE_FINISHED';
      suite: string;
      group: ProgressGroup;
      total: number; failures: number; errors: number; skipped: number;
      seconds: number;
      passed: boolean;
    }
  /**
   * One failing method, named. Surefire prints these individually and prints
   * passing methods only as a count — which is the right asymmetry for a feed:
   * nobody needs thirty-four passing names, everybody needs the one that broke.
   */
  | { kind: 'TEST_FAILED'; suite: string; method: string; seconds: number }
  /** The assertion message and source line belonging to the failure above. */
  | { kind: 'FAILURE_DETAIL'; message: string; at?: string };

// ---------------------------------------------------------------------------
// The lines, exactly as Maven writes them
// ---------------------------------------------------------------------------

const PHASE = /^\[INFO\]\s+---\s+(\S+?):[\d.]+:(\S+)\s+\(/;
const RUNNING = /^\[INFO\]\s+Running\s+(\S+)\s*$/;
const SUITE_RESULT =
  /^\[(?:INFO|ERROR)\]\s+Tests run:\s*(\d+),\s*Failures:\s*(\d+),\s*Errors:\s*(\d+),\s*Skipped:\s*(\d+)(?:,\s*Time elapsed:\s*([\d.]+)\s*s)?.*?--\s+in\s+(\S+)\s*$/;
const METHOD_FAILED =
  /^\[ERROR\]\s+(\S+?)\.(\w+)\s+--\s+Time elapsed:\s*([\d.]+)\s*s\s*<<<\s*(?:FAILURE|ERROR)!/;
const ASSERTION = /^(?:[\w.$]*(?:Error|Exception)):\s*(.+)$/;
const STACK_AT = /^\s+at\s+([\w.$]+\([^)]*\))\s*$/;

/** `surefire:test` → unit tests; `failsafe:verify` → integration tests. */
const PHASE_LABEL: Record<string, string> = {
  compiler: 'Compiling',
  surefire: 'Running unit tests',
  failsafe: 'Running integration tests',
  resources: 'Preparing resources',
  jar: 'Packaging',
  'spring-boot': 'Packaging',
};

/**
 * Assigns each suite to the question it answers.
 *
 * Grouping by package would be arbitrary. Grouping by what a suite is evidence
 * *for* is not, and it maps to what a viewer wants to know: does the thing you
 * changed still work, does the thing you added prove anything, did you break
 * anything else.
 *
 * Decided once, before the run, from data that already exists.
 */
export function buildGroups(input: {
  baseline: Baseline | null;
  approvedItems: PlanItem[];
  changes: MigrationChange[];
}): Map<string, ProgressGroup> {
  const groups = new Map<string, ProgressGroup>();

  // Everything the baseline saw starts as regression surface.
  for (const t of input.baseline?.tests.inventory ?? []) {
    groups.set(t.suite, 'REGRESSION_SURFACE');
  }

  // A suite whose subject the approved plan touches is a migration target.
  // `CryptoService.java` → `CryptoServiceTest`, which is the convention every
  // Java project in scope follows.
  const targets = new Set(
    input.approvedItems
      .flatMap((p) => p.expectedChanges.flatMap((c) => c.paths))
      .map((path) => path.split('/').pop()?.replace(/\.\w+$/, ''))
      .filter((n): n is string => Boolean(n)),
  );
  for (const suite of groups.keys()) {
    const simple = suite.split('.').pop() ?? suite;
    if ([...targets].some((t) => simple === `${t}Test` || simple === `${t}IntegrationTest`)) {
      groups.set(suite, 'MIGRATION_TARGET');
    }
  }

  // Suites the agent wrote this run.
  for (const change of input.changes) {
    if (change.intent !== 'TEST_ENGINEERING' && !change.testIntegrity) continue;
    for (const f of change.files) {
      const suite = suiteOf(f.path);
      if (suite) groups.set(suite, 'NEW_EVIDENCE');
    }
  }

  return groups;
}

/** `src/test/java/pay/security/CryptoServiceTest.java` → `pay.security.CryptoServiceTest` */
export function suiteOf(path: string): string | null {
  const m = /src\/test\/(?:java|kotlin)\/(.+)\.(?:java|kt)$/.exec(path);
  return m?.[1] ? m[1].replace(/\//g, '.') : null;
}

export interface ProgressTotals {
  suites: number;
  tests: number;
  /** False on the very first run, where the baseline does not exist yet. */
  known: boolean;
}

/**
 * The denominator, which the baseline already holds.
 *
 * Maven never announces how many classes it is about to run — which is why a
 * progress bar looked impossible. But the baseline recorded every test on the
 * base commit before anything moved, and the suites the agent added since are
 * known from its own change records. Together they are exact.
 */
export function totalsFor(input: {
  baseline: Baseline | null;
  changes: MigrationChange[];
}): ProgressTotals {
  if (!input.baseline) return { suites: 0, tests: 0, known: false };

  const suites = new Set(input.baseline.tests.inventory.map((t) => t.suite));
  const tests = input.baseline.tests.total;

  for (const change of input.changes) {
    if (change.intent !== 'TEST_ENGINEERING' && !change.testIntegrity) continue;
    for (const f of change.files) {
      const suite = suiteOf(f.path);
      // A generated suite's test count is unknown until it runs, so it counts
      // as one suite and is left out of the test total rather than guessed.
      if (suite && !suites.has(suite)) suites.add(suite);
    }
  }

  return { suites: suites.size, tests, known: true };
}

/**
 * Turns one line of build output into an event, or nothing.
 *
 * Stateless apart from the suite grouping, so the same function serves the local
 * executor's stdout and Cloud Build's streamed log without either knowing about
 * the other.
 */
export function parseLine(
  line: string,
  groups: Map<string, ProgressGroup>,
): ProgressEvent | null {
  const phase = PHASE.exec(line);
  if (phase) {
    const label = PHASE_LABEL[phase[1]!];
    return label ? { kind: 'PHASE', phase: label } : null;
  }

  const running = RUNNING.exec(line);
  if (running) {
    const suite = running[1]!;
    return { kind: 'SUITE_STARTED', suite, group: groupOf(suite, groups) };
  }

  const result = SUITE_RESULT.exec(line);
  if (result) {
    const [, total, failures, errors, skipped, seconds, suite] = result;
    return {
      kind: 'SUITE_FINISHED',
      suite: suite!,
      group: groupOf(suite!, groups),
      total: Number(total), failures: Number(failures),
      errors: Number(errors), skipped: Number(skipped),
      seconds: Number(seconds ?? 0),
      passed: Number(failures) === 0 && Number(errors) === 0,
    };
  }

  const failed = METHOD_FAILED.exec(line);
  if (failed) {
    return {
      kind: 'TEST_FAILED',
      suite: failed[1]!, method: failed[2]!, seconds: Number(failed[3]),
    };
  }

  const assertion = ASSERTION.exec(line);
  if (assertion) return { kind: 'FAILURE_DETAIL', message: assertion[1]!.slice(0, 300) };

  const at = STACK_AT.exec(line);
  if (at) return { kind: 'FAILURE_DETAIL', message: '', at: at[1]! };

  return null;
}

/**
 * A suite the baseline never saw is new evidence, whatever produced it.
 *
 * Defaulting to regression surface would be worse: it would put a test the agent
 * wrote into the group that answers "did you break anything you were not
 * touching", which is the one question it cannot answer.
 */
const groupOf = (suite: string, groups: Map<string, ProgressGroup>): ProgressGroup =>
  groups.get(suite) ?? 'NEW_EVIDENCE';

// ---------------------------------------------------------------------------
// Accumulated state, for the screen
// ---------------------------------------------------------------------------

export interface SuiteProgress {
  suite: string;
  group: ProgressGroup;
  state: 'RUNNING' | 'PASSED' | 'FAILED';
  total?: number;
  failures?: number;
  seconds?: number;
  /** Named failing methods, with their assertion message where one was printed. */
  failed: Array<{ method: string; message?: string; at?: string }>;
}

export interface RunProgress {
  phase?: string;
  totals: ProgressTotals;
  suitesFinished: number;
  testsFinished: number;
  suites: SuiteProgress[];
}

/**
 * Folds events into the shape the screen renders.
 *
 * Kept out of the component and out of the loop so it can be asserted on
 * directly — a progress bar that claims 7 of 13 when 8 have run is the kind of
 * thing nobody notices until a demo.
 */
export class ProgressTracker {
  private readonly bySuite = new Map<string, SuiteProgress>();
  private phase: string | undefined;
  /** The suite a bare assertion line belongs to. Surefire prints it after. */
  private lastFailure: { suite: string; method: string } | null = null;

  constructor(private readonly totals: ProgressTotals) {}

  apply(event: ProgressEvent): void {
    switch (event.kind) {
      case 'PHASE':
        this.phase = event.phase;
        break;

      case 'SUITE_STARTED':
        this.bySuite.set(event.suite, {
          suite: event.suite, group: event.group, state: 'RUNNING', failed: [],
        });
        break;

      case 'SUITE_FINISHED': {
        const existing = this.bySuite.get(event.suite);
        this.bySuite.set(event.suite, {
          suite: event.suite,
          group: event.group,
          state: event.passed ? 'PASSED' : 'FAILED',
          total: event.total,
          failures: event.failures + event.errors,
          seconds: event.seconds,
          // Cleared when the suite passes. A run rebuilds after every plan item,
          // so a suite that failed mid-migration and passes at the end kept its
          // old failing methods and rendered them, in red, underneath a green
          // tick — `peerKeyUsesTheApprovedAlgorithm … found RSA` sitting under a
          // suite marked ✓, on a migration that verified. The names are only
          // meaningful for the build that produced them.
          failed: event.passed ? [] : existing?.failed ?? [],
        });
        break;
      }

      case 'TEST_FAILED': {
        const suite = this.bySuite.get(event.suite)
          ?? { suite: event.suite, group: 'NEW_EVIDENCE' as ProgressGroup,
               state: 'RUNNING' as const, failed: [] };
        // Deduped by name: a suite is re-run after every repair, so the same
        // method fails once per attempt and the list would grow with each.
        if (!suite.failed.some((f) => f.method === event.method)) {
          suite.failed.push({ method: event.method });
        }
        this.bySuite.set(event.suite, suite);
        this.lastFailure = { suite: event.suite, method: event.method };
        break;
      }

      case 'FAILURE_DETAIL': {
        if (!this.lastFailure) break;
        const suite = this.bySuite.get(this.lastFailure.suite);
        const entry = suite?.failed.find((f) => f.method === this.lastFailure!.method);
        if (!entry) break;
        // The message arrives on one line and the source location on the next.
        if (event.message && !entry.message) entry.message = event.message;
        if (event.at && !entry.at) entry.at = event.at;
        break;
      }
    }
  }

  snapshot(): RunProgress {
    const suites = [...this.bySuite.values()];
    const finished = suites.filter((s) => s.state !== 'RUNNING');
    return {
      ...(this.phase ? { phase: this.phase } : {}),
      totals: this.totals,
      suitesFinished: finished.length,
      testsFinished: finished.reduce((n, s) => n + (s.total ?? 0), 0),
      suites,
    };
  }
}
