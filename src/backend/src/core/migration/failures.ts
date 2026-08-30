import type { ExecutionPhase, ExecutionRun, StructuredFailure } from '@proteus/schema';
import type { TestInventory } from './testReports';

/**
 * Turning a build into evidence (spec §33).
 *
 * A Maven run prints thousands of lines and about a dozen of them say what went
 * wrong. Sending the rest to a model costs tokens, buries the signal, and — the
 * part that actually matters — makes the failure look different every run,
 * because logs carry timestamps, durations and temp paths. A classification
 * that varies between identical attempts produces a different `problemKey` each
 * time, so `meaningfulAttempts` never reaches four and the retry budget silently
 * never fires.
 *
 * So the extraction is deterministic and bounded, and the full log stays in blob
 * storage for anyone who wants it.
 */

const MAX_RELEVANT_LINES = 20;

/**
 * Lines that carry a cause, in priority order.
 *
 * Ordered rather than filtered flat: when a run produces more than twenty
 * interesting lines, the ones that survive should be the exception and the
 * assertion, not the twenty `[WARNING]`s that preceded them.
 */
const RELEVANCE: Array<{ re: RegExp; weight: number }> = [
  { re: /^\s*(Caused by|java\.\w+\.\w*Exception|[\w.]+Exception|[\w.]+Error):/i, weight: 0 },
  { re: /expected[:\s].{0,80}(but was|actual)/i, weight: 1 },
  { re: /\[ERROR\].*(COMPILATION|cannot find symbol|incompatible types|does not exist)/i, weight: 1 },
  { re: /(could not resolve|NoSuchAlgorithmException|NoSuchProviderException)/i, weight: 1 },
  { re: /^\s*\[ERROR\]/, weight: 2 },
  { re: /Tests run:.*(Failures: [1-9]|Errors: [1-9])/, weight: 3 },
  { re: /BUILD FAILURE/, weight: 4 },
];

function relevance(line: string): number | null {
  for (const { re, weight } of RELEVANCE) if (re.test(line)) return weight;
  return null;
}

/**
 * The phase a failure belongs to.
 *
 * Derived from which reports contain the failures rather than from the command,
 * because `mvn verify` runs unit and integration tests in one invocation. The
 * classifiers turn on this distinction — `EXEC-DIAG-002` is about BUILD and
 * `EXEC-DIAG-004` about the test phases — so guessing it from the command would
 * misroute half the failures in a Maven project.
 */
export function phaseOf(execution: ExecutionRun, inventory: TestInventory): ExecutionPhase {
  const failed = inventory.tests.filter((t) => t.status === 'FAILED');
  if (failed.length === 0) {
    // Non-zero exit with no failing test: nothing got as far as running.
    return execution.kind === 'DEPLOY' ? 'DEPLOY' : 'BUILD';
  }
  return failed.some((t) => t.scope === 'INTEGRATION') ? 'INTEGRATION_TEST' : 'UNIT_TEST';
}

export interface FailureContext {
  execution: ExecutionRun;
  inventory: TestInventory;
  /** The full log, for extraction. Never stored here — it is already in GCS. */
  log: string;
}

/**
 * Reduces a failed execution to the evidence a diagnosis can be made from.
 *
 * The integration failure is preferred as the headline error when both a unit
 * and an integration test failed: the unit failure is usually a consequence, and
 * naming the consequence would produce a `problemKey` for a symptom.
 */
export function structureFailure(ctx: FailureContext): StructuredFailure {
  const { execution, inventory, log } = ctx;
  const failed = inventory.tests.filter((t) => t.status === 'FAILED');

  /*
   * The full log lives in blob storage, and that read can come back empty — a
   * missing object, an unreachable bucket, a credential that expired mid-run.
   * The caller cannot tell the difference between "the build printed nothing"
   * and "the log could not be fetched", and neither can this.
   *
   * But the fifty most relevant lines are already on the ExecutionRun in Mongo,
   * put there by the executor, and they are chosen by nearly the same rule this
   * function applies. So they are the fallback.
   *
   * Without it, a compile failure reaches the diagnostic agent as
   * `error: "mvn -B verify exited 1"` with `relevant_logs: []` — the agent is
   * asked to repair a build and told nothing whatever about what is wrong with
   * it. `cannot find symbol` is right there in the excerpt; it was simply never
   * read.
   */
  const source = log.trim() ? log : execution.logExcerpt.join('\n');

  const headline = failed.find((t) => t.scope === 'INTEGRATION') ?? failed[0];
  const error = headline?.message
    ?? firstErrorLine(source)
    ?? `${execution.command} exited ${execution.exitCode ?? 'non-zero'}`;

  return {
    phase: phaseOf(execution, inventory),
    command: execution.command,
    exitCode: execution.exitCode ?? 1,
    failedTests: failed.map((t) => ({
      name: t.testId,
      message: t.message ?? 'failed',
      ...(t.stackHead ? { stackHead: t.stackHead } : {}),
    })),
    error: error.slice(0, 500),
    relevantLogs: relevantLines(source),
    ...(execution.logGcsUri ? { fullLogGcsUri: execution.logGcsUri } : {}),
  };
}

/** At most twenty lines, chosen by relevance and then by order of appearance. */
export function relevantLines(log: string): string[] {
  const scored: Array<{ line: string; weight: number; index: number }> = [];
  log.split('\n').forEach((raw, index) => {
    const line = raw.trimEnd();
    if (!line.trim()) return;
    const weight = relevance(line);
    if (weight !== null) scored.push({ line: line.trim(), weight, index });
  });

  return scored
    .sort((a, b) => a.weight - b.weight || a.index - b.index)
    .slice(0, MAX_RELEVANT_LINES)
    // Re-sorted into log order once selected: a reader follows a log downward,
    // and priority order would present the cause after its own stack trace.
    .sort((a, b) => a.index - b.index)
    .map((s) => s.line);
}

/**
 * Maven's own section headings, which say only that something went wrong.
 *
 * `[ERROR] COMPILATION ERROR :` is the first `[ERROR]` line of every failed
 * compile, so taking it as the headline gives every compile failure in the
 * project the same `error` string — and therefore the same `problemKey`. Two
 * unrelated defects would then share one retry budget and the second would be
 * refused for attempts spent on the first.
 */
const HEADING = /^(COMPILATION ERROR|BUILD FAILURE|ERRORS?|Failures?)\s*:?$/i;

function firstErrorLine(log: string): string | undefined {
  const lines = log
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^\[ERROR\]|Exception:|Error:/.test(l))
    .map((l) => l.replace(/^\[ERROR\]\s*/, '').trim())
    .filter((l) => l && !HEADING.test(l));

  // The first line that carries a cause, rather than the first that is merely
  // marked as an error.
  return lines.find((l) => relevance(l) !== null && relevance(l)! <= 1) ?? lines[0];
}

/**
 * The compact JSON the feed renders verbatim (spec §33).
 *
 * Deliberately the same object the model is given. A viewer reading the feed and
 * the model reading the evidence should be looking at the same thing, or the
 * screen is showing a summary of a decision made on something else.
 */
export function failureJson(failure: StructuredFailure, attempt: number): string {
  return JSON.stringify({
    attempt,
    phase: failure.phase.toLowerCase(),
    command: failure.command,
    exit_code: failure.exitCode,
    failed_test: failure.failedTests[0]?.name,
    error: failure.error,
    relevant_logs: failure.relevantLogs,
  }, null, 2);
}
