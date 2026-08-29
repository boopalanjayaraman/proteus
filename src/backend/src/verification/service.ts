import {
  computeOverallVerdict,
  type Baseline, type BehavioralInvariant, type CryptoAssertion, type ExecutionRun,
  type Finding, type HumanGate, type MigrationChange, type MigrationPolicy,
  type MigrationRun, type PlanItem, type SandboxDeployment, type VerificationCheckResult,
  type VerificationResult,
} from '@proteus/schema';
import type { Candidate } from '../core/discovery/detect';
import type { TestInventory } from '../core/migration/testReports';
import { checkScope, type ScopeBreach } from './checks/scope';
import { scopeOf, verifyCrypto, type CryptoEvidence, type MigrationScope } from './checks/crypto';
import {
  checkBlockers, checkInvariants, checkTests, checkBuild,
  type InvariantVerification, type TestVerification,
} from './checks/tests';

/**
 * Deterministic verification (spec §34, §35; `EXEC-VER-001` … `-012`).
 *
 * Pure code. `verification/` may never import `agent/` — enforced by a test —
 * because the whole claim of this increment is that the verdict comes from tool
 * evidence rather than from a model's account of its own work. Spec §35 is
 * explicit that tests passing is not migration verified.
 *
 * `overall` is computed by `computeOverallVerdict()` over the nine checks and
 * nothing else. `cryptoAssertions` is narrative and carries a third state,
 * `NOTED`, which must never influence the gate — that is what lets the residual
 * RSA signature usages be reported honestly without failing a correct migration.
 */

export interface VerificationInput {
  run: MigrationRun;
  baseline: Baseline;
  policy: MigrationPolicy;
  approvedItems: PlanItem[];
  approvedFindings: Finding[];
  changes: MigrationChange[];
  gates: HumanGate[];
  blockedFindingIds: string[];

  /** The build at the branch head. `EXEC-VER-002` reads it, never asserts it. */
  build: ExecutionRun | null;
  /** The final test run, which every test-shaped check is measured against. */
  tests: { execution: ExecutionRun; inventory: TestInventory };
  /** Generated suites, so `EXEC-VER-004` can hold both kinds to their contract. */
  generated: { characterization: string[]; acceptance: string[] };

  /** What the detector finds in the migrated tree. The same detector discovery used. */
  candidates: Candidate[];
  /** The verification pass itself — what a query-established check cites. */
  verificationRunId: string;
  roundTrip: CryptoEvidence['roundTrip'];
  provider?: CryptoEvidence['provider'];
  target?: string;

  /** Present only once the sandbox has been deployed and exercised. */
  sandbox?: SandboxDeployment | null;
}

export interface VerificationOutcome {
  checks: VerificationCheckResult[];
  cryptoAssertions: CryptoAssertion[];
  overall: 'VERIFIED' | 'NOT_VERIFIED';
  residual: VerificationResult['residualLegacyCrypto'];
  detected: VerificationResult['detectedPqc'];
  scope: MigrationScope;
  breaches: ScopeBreach[];
  invariants: InvariantVerification;
  tests: TestVerification;
}

/**
 * Evaluates every check and computes the verdict.
 *
 * The sandbox checks FAIL before deployment rather than reading
 * `NOT_APPLICABLE`. That distinction is load-bearing: `NOT_APPLICABLE` counts as
 * satisfied in `computeOverallVerdict`, so calling an undeployed sandbox
 * inapplicable would let a run that never started claim `VERIFIED` — the exact
 * failure spec §35 exists to prevent, since it lists a started sandbox and a
 * passing end-to-end scenario among the conditions.
 *
 * The circularity `EXEC-REP-004` would otherwise create is resolved in
 * `mayDeploy()` instead, which excludes the two sandbox checks because they are
 * what deployment establishes. So the verdict stays honest and the gate stays
 * satisfiable.
 */
export function verify(input: VerificationInput): VerificationOutcome {
  const scope = scopeOf(input.approvedFindings, input.target);

  const scopeCheck = checkScope(input.changes, input.approvedItems);
  const crypto = verifyCrypto({
    candidates: input.candidates,
    scope,
    policy: input.policy,
    executionRunId: input.verificationRunId,
    roundTrip: input.roundTrip,
    ...(input.provider ? { provider: input.provider } : {}),
  });

  const tests = checkTests(input.baseline, input.tests, input.generated);
  const invariants = checkInvariants(
    input.baseline, input.tests, implicatedBy(input.tests.inventory),
  );

  // MIGRATION_POLICY_SATISFIED is claimed by two rules — EXEC-VER-001 checks the
  // diff against the approved scope, EXEC-VER-007 checks the resolved provider.
  // The check appears once, and fails if either does: a verdict that reported
  // only the more forgiving of two conditions would be worthless.
  const policySatisfied: VerificationCheckResult = {
    check: 'MIGRATION_POLICY_SATISFIED',
    status: scopeCheck.result.status === 'PASS' && crypto.policySatisfied.status === 'PASS'
      ? 'PASS' : 'FAIL',
    detail: [scopeCheck.result.detail, crypto.policySatisfied.detail].join(' · '),
    executionRunId: input.verificationRunId,
    evidenceIds: [],
    findings: [...scopeCheck.result.findings, ...crypto.policySatisfied.findings],
  };

  const checks: VerificationCheckResult[] = [
    invariants.result,
    checkBuild(input.build, input.run.branch.headCommitSha),
    tests.result,
    crypto.prohibitedAbsent,
    crypto.pqcPresent,
    policySatisfied,
    checkBlockers(input.gates, input.blockedFindingIds, input.verificationRunId),
    sandboxCheck(input.sandbox),
    e2eCheck(input.sandbox),
  ];

  return {
    checks,
    cryptoAssertions: crypto.assertions,
    // The one line that matters. A pure function of the nine checks; no branch
    // of this file can reach in and set it.
    overall: computeOverallVerdict(checks),
    residual: crypto.residual,
    detected: crypto.detected,
    scope,
    breaches: scopeCheck.breaches,
    invariants,
    tests,
  };
}

/** `EXEC-VER-010` — deployed is not running; the startup probe is the difference. */
function sandboxCheck(sandbox: SandboxDeployment | null | undefined): VerificationCheckResult {
  if (!sandbox) {
    return {
      check: 'SANDBOX_DEPLOYMENT_SUCCESSFUL',
      status: 'FAIL',
      detail: 'Not yet deployed. Deployment is gated on the other checks passing '
        + '(EXEC-REP-004), so this is established afterwards — until then the migration '
        + 'is not verified.',
      evidenceIds: [], findings: [],
    };
  }
  const ok = sandbox.status === 'READY' && sandbox.startupCheck?.passed === true;
  return {
    check: 'SANDBOX_DEPLOYMENT_SUCCESSFUL',
    status: ok ? 'PASS' : 'FAIL',
    detail: ok
      ? `${sandbox.service.name} ready at ${sandbox.service.url} · `
        + `${sandbox.startupCheck?.detail ?? 'startup probe passed'}`
      : `${sandbox.status.toLowerCase()} · `
        + `${sandbox.startupCheck?.detail ?? 'startup probe did not pass'}`,
    evidenceIds: ok ? [sandbox.sandboxDeploymentId] : [],
    findings: [],
  };
}

/** `EXEC-VER-011` — against the deployed service, not a local harness. */
function e2eCheck(sandbox: SandboxDeployment | null | undefined): VerificationCheckResult {
  if (!sandbox?.e2e) {
    return {
      check: 'E2E_VERIFICATION_SUCCESSFUL',
      status: 'FAIL',
      detail: 'No end-to-end run yet. It runs against the sandbox URL once the startup '
        + 'probe passes; until it has, nothing has exercised the migrated application '
        + 'as a running system.',
      evidenceIds: [], findings: [],
    };
  }
  const failed = sandbox.e2e.scenarios.filter((s) => !s.passed);
  return {
    check: 'E2E_VERIFICATION_SUCCESSFUL',
    status: sandbox.e2e.passed ? 'PASS' : 'FAIL',
    detail: sandbox.e2e.passed
      ? `${sandbox.e2e.scenarios.length} scenario(s) passed against ${sandbox.service.url}`
        + (sandbox.e2e.latencyDeltaMs !== undefined
          ? ` · latency ${sandbox.e2e.latencyDeltaMs >= 0 ? '+' : ''}`
            + `${sandbox.e2e.latencyDeltaMs}ms vs baseline`
          : '')
      : `${failed.length} scenario(s) failed: ${failed.map((s) => s.name).join(', ')}`,
    executionRunId: sandbox.e2e.executionRunId,
    evidenceIds: [],
    findings: failed.map((s) => ({ path: s.name, match: 'failed' })),
  };
}

/**
 * Whether a failing test in the final run implicates an invariant.
 *
 * The same matcher the repair loop uses to tell `EXEC-DIAG-005` from
 * `EXEC-DIAG-013`, applied in the other direction. Sharing it is deliberate: a
 * failure that raised a gate during repair must not quietly pass verification.
 */
export function implicatedBy(inventory: TestInventory) {
  const failures = inventory.tests.filter((t) => t.status === 'FAILED');
  const haystack = failures
    .map((t) => `${t.testId} ${t.message ?? ''} ${t.stackHead ?? ''}`)
    .join(' ');
  const squashed = haystack.replace(/\s+/g, '');

  return (invariant: BehavioralInvariant): { failed: boolean; observed?: string } => {
    const needle = invariant.assertion.replace(/\s+/g, '');
    let match = needle.length >= 8 && squashed.includes(needle);

    // Surefire reports `expected: <256> but was: <1088>`, never the source line,
    // so an assertion is also matched by the literal it pins.
    const literal = /\(\s*(\d{2,})\s*,/.exec(invariant.assertion)?.[1];
    const observedRe = literal
      ? new RegExp(`expected:?\\s*<?\\s*${literal}\\b[^0-9]{0,20}([0-9]+)`, 'i')
      : null;
    const observed = observedRe?.exec(haystack)?.[1];
    if (observed) match = true;

    return {
      failed: match,
      ...(observed ? { observed: `${observed} (was ${literal})` } : {}),
    };
  };
}

/**
 * Why deployment is or is not permitted (`EXEC-REP-004`).
 *
 * Spec §35 is explicit that tests passing is not migration verified, so
 * deploying before the verdict would put an unverified build behind a URL the
 * user is invited to trust.
 */
export function mayDeploy(
  outcome: Pick<VerificationOutcome, 'checks'>,
): { permitted: boolean; reason: string } {
  // The sandbox checks are excluded here for the obvious reason: they are what
  // deployment would establish.
  const preDeployment = outcome.checks.filter(
    (c) => c.check !== 'SANDBOX_DEPLOYMENT_SUCCESSFUL'
      && c.check !== 'E2E_VERIFICATION_SUCCESSFUL',
  );
  const failed = preDeployment.filter((c) => c.status === 'FAIL');

  return failed.length === 0
    ? {
        permitted: true,
        reason: `${preDeployment.length} pre-deployment check(s) pass; EXEC-REP-004 permits `
          + 'the sandbox deploy.',
      }
    : {
        permitted: false,
        reason: `EXEC-REP-004 refuses deployment: ${failed.map((c) => c.check).join(', ')} `
          + `${failed.length === 1 ? 'is' : 'are'} failing. Spec §35 — tests passing is not `
          + 'migration verified.',
      };
}
