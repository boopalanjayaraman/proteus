import type {
  Baseline, BehavioralInvariant, ExecutionRun, HumanGate, VerificationCheckResult,
} from '@proteus/schema';
import type { TestInventory } from '../../core/migration/testReports';

/**
 * The test and invariant checks (`EXEC-VER-002` … `-005`, `-009`).
 *
 * Every one reads from an `ExecutionRun` or a `Baseline`. None of them is
 * asserted, and none consults a model — spec §46's deterministic-first
 * principle is not a style preference here, it is what makes the verdict mean
 * anything.
 */

/** `EXEC-VER-002` — the build passed, at the head the verdict is about. */
export function checkBuild(
  build: ExecutionRun | null,
  branchHead: string | undefined,
): VerificationCheckResult {
  if (!build) {
    return {
      check: 'BUILD_SUCCESSFUL', status: 'FAIL',
      detail: 'No build execution recorded at the branch head.',
      evidenceIds: [], findings: [],
    };
  }

  // Pinned to the head so a green build from an intermediate attempt cannot
  // satisfy the check for a later, different tree.
  const rightTree = !branchHead || build.commitSha === branchHead;
  const passed = build.status === 'SUCCESS' && rightTree;

  return {
    check: 'BUILD_SUCCESSFUL',
    status: passed ? 'PASS' : 'FAIL',
    detail: passed
      ? `${build.command} exited ${build.exitCode ?? 0} at ${build.commitSha.slice(0, 7)}`
      : rightTree
        ? `${build.command} exited ${build.exitCode ?? 'non-zero'}`
        : `the newest build ran against ${build.commitSha.slice(0, 7)}, not the branch head `
          + `${branchHead?.slice(0, 7)}`,
    executionRunId: build.executionRunId,
    evidenceIds: [],
    findings: [],
  };
}

export interface TestVerification {
  result: VerificationCheckResult;
  /** Tests that passed at baseline and no longer do. The actual regression set. */
  regressions: string[];
  /** Generated tests that had to pass and did. */
  acceptancePassed: string[];
}

/**
 * `EXEC-VER-003` and `-004` — a subset relation, never a count.
 *
 * Counts hide substitution: four new tests passing while four old ones break
 * leaves the total unchanged and the migration broken. Expressed as
 * `baselinePassing ⊆ currentPassing`, with the baseline's pre-existing failures
 * excluded per `EXEC-INV-002` — the migration is never blamed for a test that
 * was already red.
 *
 * The pair in `-004` matters too: characterization tests passing shows behaviour
 * was preserved, acceptance tests passing shows behaviour changed. Either alone
 * is satisfiable by doing nothing, or by breaking everything.
 */
export function checkTests(
  baseline: Baseline,
  current: { execution: ExecutionRun; inventory: TestInventory },
  generated: { characterization: string[]; acceptance: string[] },
): TestVerification {
  const known = new Set(baseline.tests.knownFailures.map((f) => f.testId));
  const baselinePassing = baseline.tests.inventory
    .filter((t) => t.status === 'PASSED')
    .map((t) => t.testId);

  const currentStatus = new Map(current.inventory.tests.map((t) => [t.testId, t.status]));

  /*
   * "Did not run" and "now fails" are opposite facts, and this used to report
   * both as the second one.
   *
   * `mvn verify` runs surefire then failsafe. When a unit test fails, Maven
   * stops and the integration tests never execute — so their baseline entries
   * have no current result. A run reported
   * `PartnerHandshakeIntegrationTest#completesTheHandshakeWithTheAcquirer` as a
   * regression when it had not been given the chance to run at all, while the
   * actual failures were three unit tests in another suite entirely. Anyone
   * reading the evidence package was pointed at the wrong file.
   *
   * Both still fail the check — you cannot claim a required test passed when it
   * did not run — but they are counted and named separately.
   */
  const regressions = baselinePassing.filter(
    (id) => !known.has(id) && currentStatus.get(id) === 'FAILED',
  );
  const notRun = baselinePassing.filter(
    (id) => !known.has(id) && currentStatus.get(id) === undefined,
  );

  // A generated test is identified by its suite, because one file produces many
  // test methods and the plan named the file.
  const suitePassed = (suite: string): boolean => {
    const own = [...currentStatus.entries()].filter(([id]) => id.startsWith(`${suite}#`));
    return own.length > 0 && own.every(([, s]) => s === 'PASSED');
  };

  const characterizationFailed = generated.characterization.filter((s) => !suitePassed(s));
  const acceptanceFailed = generated.acceptance.filter((s) => !suitePassed(s));
  const acceptancePassed = generated.acceptance.filter(suitePassed);

  const passed = regressions.length === 0
    && notRun.length === 0
    && characterizationFailed.length === 0
    && acceptanceFailed.length === 0;

  return {
    regressions,
    acceptancePassed,
    result: {
      check: 'REQUIRED_TESTS_PASSED',
      status: passed ? 'PASS' : 'FAIL',
      detail: passed
        ? `Every one of the ${baselinePassing.length} tests passing at baseline still passes`
          + `${generated.acceptance.length > 0
            ? `; ${generated.acceptance.length} acceptance and `
              + `${generated.characterization.length} characterization suite(s) pass`
            : ''}`
          + `${known.size > 0
            ? `. ${known.size} pre-existing failure(s) remain unchanged and are not `
              + 'attributed to the migration'
            : ''}`
        : [
            regressions.length > 0
              && `${regressions.length} test(s) that passed at baseline now fail: `
                + regressions.slice(0, 5).join(', '),
            notRun.length > 0
              && `${notRun.length} test(s) that passed at baseline did not run — an `
                + 'earlier phase failed and the build stopped before reaching them: '
                + notRun.slice(0, 5).join(', '),
            acceptanceFailed.length > 0
              && `acceptance suite(s) failing: ${acceptanceFailed.join(', ')}`,
            characterizationFailed.length > 0
              && `characterization suite(s) failing: ${characterizationFailed.join(', ')}`,
          ].filter(Boolean).join('; '),
      executionRunId: current.execution.executionRunId,
      evidenceIds: [],
      findings: regressions.map((id) => ({ path: id, match: 'passed at baseline, now failing' })),
    },
  };
}

export interface InvariantVerification {
  result: VerificationCheckResult;
  /** MUST_PRESERVE invariants a failing test implicates. A contract breach. */
  broken: BehavioralInvariant[];
  /**
   * EXPECTED_TO_CHANGE invariants, with what was observed after. Reported rather
   * than asserted — the ciphertext growing from 256 to 1088 bytes is the
   * migration working, and asserting it would block the correct outcome.
   */
  changed: Array<{ invariant: BehavioralInvariant; observedAfter: string }>;
}

/**
 * `EXEC-VER-005` — the baseline contract, re-checked.
 *
 * An invariant is implicated by a failing test when the failure's own text
 * carries its assertion, which is the same matching the repair loop uses to
 * decide `EXEC-DIAG-005` against `EXEC-DIAG-013`. Using one matcher for both is
 * deliberate: a failure that raised a gate during repair must not quietly pass
 * verification, and vice versa.
 */
export function checkInvariants(
  baseline: Baseline,
  current: { execution: ExecutionRun; inventory: TestInventory },
  implicates: (invariant: BehavioralInvariant) => { failed: boolean; observed?: string },
): InvariantVerification {
  const broken: BehavioralInvariant[] = [];
  const changed: InvariantVerification['changed'] = [];

  for (const invariant of baseline.invariants) {
    const outcome = implicates(invariant);
    if (invariant.disposition === 'MUST_PRESERVE') {
      if (outcome.failed) broken.push(invariant);
    } else {
      changed.push({
        invariant,
        // "unchanged" is itself worth recording: an invariant predicted to
        // change that did not is information about the migration.
        observedAfter: outcome.observed
          ?? (outcome.failed ? 'differs from the baseline value' : 'unchanged'),
      });
    }
  }

  const preserved = baseline.invariants.filter((i) => i.disposition === 'MUST_PRESERVE').length;

  return {
    broken,
    changed,
    result: {
      check: 'BASELINE_INVARIANTS_PRESERVED',
      status: broken.length === 0 ? 'PASS' : 'FAIL',
      detail: broken.length === 0
        ? `All ${preserved} must-preserve invariant(s) hold`
          + (changed.length > 0
            ? `; ${changed.length} expected-to-change invariant(s) recorded before and after`
            : '')
        : `${broken.length} must-preserve invariant(s) no longer hold: `
          + broken.map((i) => i.description).join('; '),
      executionRunId: current.execution.executionRunId,
      evidenceIds: [],
      findings: broken.map((i) => ({ path: i.invariantId, match: i.assertion })),
    },
  };
}

/**
 * `EXEC-VER-009` — nothing critical left open.
 *
 * Recommendations are deliberately excluded. The HSM and the OT gateway are
 * unresolved external items with named owners that were never in the approved
 * scope; blocking verification on them would make a correct, fully-delivered
 * migration unverifiable. Only open *blocking* gates and blocked in-scope
 * findings count.
 */
export function checkBlockers(
  gates: HumanGate[],
  blockedFindingIds: string[],
  /**
   * The verification pass itself. This check is established by a query rather
   * than a command, and the verification run is the command it was evaluated
   * inside — so that is what it cites, rather than a fabricated evidence id.
   */
  verificationRunId: string,
): VerificationCheckResult {
  const openBlocking = gates.filter((g) => g.status === 'OPEN' && g.blocking);
  const openNonBlocking = gates.filter((g) => g.status === 'OPEN' && !g.blocking);
  const passed = openBlocking.length === 0 && blockedFindingIds.length === 0;

  return {
    check: 'NO_CRITICAL_BLOCKER',
    status: passed ? 'PASS' : 'FAIL',
    detail: passed
      ? 'No open blocking gate and no blocked in-scope finding'
        + (openNonBlocking.length > 0
          ? `. ${openNonBlocking.length} non-blocking gate(s) remain open and do not `
            + 'prevent verification'
          : '')
      : [
          openBlocking.length > 0
            && `${openBlocking.length} open blocking gate(s): `
              + openBlocking.map((g) => g.title).join('; '),
          blockedFindingIds.length > 0
            && `${blockedFindingIds.length} in-scope finding(s) blocked`,
        ].filter(Boolean).join('; '),
    executionRunId: verificationRunId,
    evidenceIds: [],
    findings: openBlocking.map((g) => ({ path: g.gateId, match: g.title })),
  };
}
