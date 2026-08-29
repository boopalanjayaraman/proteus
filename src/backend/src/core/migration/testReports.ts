import type { Baseline, ExecutionRun } from '@proteus/schema';
import type { TestReportFile } from '../../integrations/cloudbuild/executor';

/**
 * The test inventory, read from JUnit XML.
 *
 * This is the only place the number of tests, their names and their outcomes
 * come from. Not the model, and not the "Tests run: 34" line Maven prints —
 * that line is a summary of a summary, and it disappears entirely when the
 * build fails before the reactor finishes. The XML files survive either way,
 * which is exactly when the evidence matters most.
 *
 * Parsed with regexes rather than an XML library on purpose: Surefire's output
 * is a fixed, machine-generated shape, and the alternative is a dependency whose
 * failure modes are less predictable than the format it would be reading.
 */

export interface ParsedTest {
  testId: string;
  name: string;
  suite: string;
  status: 'PASSED' | 'FAILED' | 'SKIPPED';
  message?: string;
  stackHead?: string;
  /** Failsafe writes integration tests; surefire writes unit tests. */
  scope: 'UNIT' | 'INTEGRATION';
}

export interface TestInventory {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  unit: number;
  integration: number;
  tests: ParsedTest[];
}

const TESTCASE = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
const ATTR = (raw: string, name: string): string | undefined =>
  new RegExp(`\\b${name}="([^"]*)"`).exec(raw)?.[1];

/** `&lt;` and friends, as Surefire writes them into message attributes. */
function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#10;/g, '\n').replace(/&amp;/g, '&');
}

export function parseReports(reports: TestReportFile[]): TestInventory {
  const tests: ParsedTest[] = [];

  for (const report of reports) {
    // The directory decides the scope, not the class name. A project free to
    // name its integration tests anything is still bound by which plugin ran
    // them, and that is what the baseline's unit/integration split means.
    const scope: ParsedTest['scope'] =
      /failsafe-reports/.test(report.path) ? 'INTEGRATION' : 'UNIT';

    for (const match of report.xml.matchAll(TESTCASE)) {
      const attrs = match[1] ?? '';
      const body = match[3] ?? '';
      const name = ATTR(attrs, 'name');
      if (!name) continue;
      const suite = ATTR(attrs, 'classname') ?? 'unknown';

      const failure = /<(failure|error)\b([^>]*?)(\/>|>([\s\S]*?)<\/\1>)/.exec(body);
      const skipped = /<skipped\b/.test(body);

      tests.push({
        // Stable across runs and across builds, so a failure can be matched to
        // the same test in the baseline it is being compared against.
        testId: `${suite}#${name}`,
        name,
        suite,
        status: failure ? 'FAILED' : skipped ? 'SKIPPED' : 'PASSED',
        ...(failure
          ? {
              message: unescapeXml(
                ATTR(failure[2] ?? '', 'message') ?? ATTR(failure[2] ?? '', 'type') ?? 'failed',
              ).slice(0, 500),
              stackHead: firstStackLine(unescapeXml(failure[4] ?? '')),
            }
          : {}),
        scope,
      });
    }
  }

  tests.sort((a, b) => a.testId.localeCompare(b.testId));

  return {
    total: tests.length,
    passed: tests.filter((t) => t.status === 'PASSED').length,
    failed: tests.filter((t) => t.status === 'FAILED').length,
    skipped: tests.filter((t) => t.status === 'SKIPPED').length,
    unit: tests.filter((t) => t.scope === 'UNIT').length,
    integration: tests.filter((t) => t.scope === 'INTEGRATION').length,
    tests,
  };
}

const firstStackLine = (trace: string): string | undefined =>
  trace.split('\n').map((l) => l.trim()).find((l) => l.startsWith('at '));

/** The shape `ExecutionRun.tests` stores. */
export function executionTests(inv: TestInventory): NonNullable<ExecutionRun['tests']> {
  return {
    total: inv.total, passed: inv.passed, failed: inv.failed, skipped: inv.skipped,
    failures: inv.tests
      .filter((t) => t.status === 'FAILED')
      .map((t) => ({
        testId: t.testId, name: t.name, suite: t.suite,
        message: t.message ?? 'failed',
        ...(t.stackHead ? { stackHead: t.stackHead } : {}),
      })),
  };
}

/**
 * The baseline's view: an inventory, plus the failures the migration inherits.
 *
 * `EXEC-INV-002` — a test failing before anything moved is not evidence about
 * the migration. Recording it here is what later lets verification subtract it
 * instead of blaming the agent for it, and what lets the report state plainly
 * that it is unchanged.
 */
export function baselineTests(inv: TestInventory): Baseline['tests'] & { executionRunId: string } {
  return {
    executionRunId: '',
    total: inv.total, passed: inv.passed, failed: inv.failed, skipped: inv.skipped,
    knownFailures: inv.tests
      .filter((t) => t.status === 'FAILED')
      .map((t) => ({ testId: t.testId, name: t.name, ...(t.message ? { message: t.message } : {}) })),
    inventory: inv.tests.map((t) => ({
      testId: t.testId, name: t.name, suite: t.suite, status: t.status,
    })),
  };
}

/**
 * Which components already have a test exercising them.
 *
 * `EXEC-TEST-001` turns on this answer, so it is computed from the test suites
 * that actually ran rather than from filenames on disk: a `CryptoServiceTest`
 * that exists but exercises nothing about key transport is a coverage gap, and
 * only the executed suite names can distinguish that from real coverage.
 */
export function coveredSuites(inv: TestInventory): Set<string> {
  return new Set(inv.tests.map((t) => t.suite));
}
