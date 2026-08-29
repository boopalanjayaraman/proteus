import type {
  BehavioralInvariant, FailureClassification, HumanGateType, StructuredFailure,
} from '@proteus/schema';
import type { RuleEngine } from '../rules/engine';
import type { Facts } from '../rules/predicates';
import { classify as classifyPath } from '../discovery/workingCopy';

/**
 * Failure classification, deterministically first (`EXEC-DIAG-001`).
 *
 * This is not an optimisation. `makeProblemKey()` takes the classification as
 * input, so a classification that varies between two otherwise identical
 * attempts produces two different problem keys — `meaningfulAttempts` never
 * passes 1, and `MAX_MEANINGFUL_AUTONOMOUS_ATTEMPTS` never fires. A guardrail
 * that looks present and is not. Stable classification is a correctness
 * requirement for the retry budget, not a preference about token spend.
 *
 * The model runs only on the residue, and whatever it returns, the repair
 * authorisation rules — not the model — decide what may be done about it.
 */

/**
 * Legacy primitives whose appearance in a failing assertion is the signal.
 *
 * Exported because the loop uses the same expression to decide which files to
 * scan for it. Two copies drift, and when they do `EXEC-DIAG-004` stops matching
 * without anything failing — the failure just falls through to the model. The
 * explicit `RSA_PUBLIC_KEY` alternative matters: `\bRSA\b` does not match inside
 * it, because `_` is a word character.
 */
export const LEGACY_ALGORITHM =
  /\b(RSA|DH|ECDH|DSA|ECDSA|3DES|DESede|PKCS1|OAEP|RSA_PUBLIC_KEY|RSA-?\d{3,4})\b/i;

/** Node types whose failures are outside the boundary entirely (`EXEC-DIAG-012`). */
const EXTERNAL_ORIGINS: Record<string, string> = {
  EXTERNAL_SERVICE: 'EXTERNAL_SERVICE',
  VENDOR_DEPENDENCY: 'VENDOR_DEPENDENCY',
  OT_DEVICE: 'OT_DEVICE',
  HSM: 'HSM',
};

export interface DiagnosisContext {
  /** Files this attempt changed — the discriminator between DIAG-002 and DIAG-009. */
  changedPaths: string[];
  /** The baseline contract. Its dispositions decide DIAG-005 against DIAG-013. */
  invariants: BehavioralInvariant[];
  /**
   * Repository files whose contents mention the legacy algorithm named in the
   * failure, with the kind of each. `EXEC-DIAG-004` turns on all of them being
   * test or mock code — if a production file asserts it too, the expectation is
   * a real requirement and the rule must not match.
   */
  referencingFiles: Array<{ path: string; content: string }>;
  /** Graph nodes, so a failure naming a partner endpoint is recognised as external. */
  externalNames: Array<{ name: string; type: string }>;
  /** Set when the failing component had no covering test (`EXEC-DIAG-006`). */
  componentHasCoveringTests?: boolean;
}

export interface Classification {
  classification: FailureClassification;
  ruleId: string;
  source: 'DETERMINISTIC' | 'MODEL';
  permitAutonomousRepair: boolean;
  /** `EXEC-DIAG-007` and `-012` are free retries — the budget is for engineering. */
  countsTowardRetryBudget: boolean;
  requiresTestIntegrityRecord: boolean;
  /** Asserted by the rule rather than left to the agent, where the rule knows. */
  baselineRequirementChanged?: boolean;
  gateType?: HumanGateType;
  raiseRecommendation?: boolean;
  rationale: string;
}

/**
 * The facts the `FAILURE_CLASSIFICATION` family evaluates against.
 *
 * Every one is established by reading the failure, the diff or the tree — none
 * is a judgment. A fact the system cannot establish is left absent rather than
 * defaulted, because a missing fact never matches and that is what keeps a rule
 * from firing on evidence nobody has.
 */
export function factsForFailure(
  failure: StructuredFailure,
  ctx: DiagnosisContext,
): Facts {
  const facts: Facts = {
    failurePresent: true,
    phase: failure.phase,
    error: `${failure.error}\n${failure.relevantLogs.join('\n')}`,
  };

  const changed = new Set(ctx.changedPaths);
  const errorText = `${failure.error} ${failure.relevantLogs.join(' ')} `
    + failure.failedTests.map((t) => `${t.name} ${t.message} ${t.stackHead ?? ''}`).join(' ');

  // DIAG-002 against DIAG-009: did the agent's own change break this, or did
  // build tooling fail on a file it never touched?
  if (failure.phase === 'BUILD') {
    facts['errorFileInChangedSet'] = [...changed].some((p) => {
      const base = p.split('/').pop() ?? p;
      return errorText.includes(p) || errorText.includes(base);
    });
  }

  // DIAG-005 against DIAG-013: the same failing assertion means opposite things
  // depending on what the baseline said about it before the migration ran.
  const touched = touchedInvariant(failure, ctx.invariants);
  if (touched) {
    if (touched.disposition === 'MUST_PRESERVE') {
      facts['failingAssertionIsBaselineInvariant'] = true;
    } else {
      facts['failingAssertionIsExpectedToChangeInvariant'] = true;
    }
  }

  // DIAG-004: a legacy algorithm asserted only in test or mock code.
  if (LEGACY_ALGORITHM.test(errorText)) {
    facts['failingAssertionReferences'] = 'LEGACY_ALGORITHM';
    if (ctx.referencingFiles.length > 0) {
      facts['referencingFiles'] = [
        ...new Set(ctx.referencingFiles.map((f) => kindOf(f.path))),
      ];
    }
  }

  // DIAG-011: a fixture encodes legacy *data*, where a mock encodes legacy
  // *behaviour*. Different obsolete artifact, different repair.
  const fixture = ctx.referencingFiles.find((f) => isFixture(f.path));
  if (fixture) {
    facts['failingInputOriginatesIn'] = 'FIXTURE';
    facts['fixtureEncodesLegacyFormat'] = LEGACY_ALGORITHM.test(fixture.content);
  }

  // DIAG-012: the agent cannot fix a partner endpoint or firmware-fixed device.
  const external = ctx.externalNames.find(
    (n) => EXTERNAL_ORIGINS[n.type] && errorText.toLowerCase().includes(n.name.toLowerCase()),
  );
  if (external) facts['failureOriginatesIn'] = EXTERNAL_ORIGINS[external.type];

  if (ctx.componentHasCoveringTests !== undefined) {
    facts['componentHasCoveringTests'] = ctx.componentHasCoveringTests;
  }
  return facts;
}

/** `src/test/...` → TEST; a mock by name → MOCK; otherwise the tree's own kinds. */
function kindOf(path: string): string {
  if (/mock|simulator|stub|fake/i.test(path.split('/').pop() ?? '')) return 'MOCK';
  const kind = classifyPath(path);
  return kind === 'TEST' ? 'TEST' : kind;
}

const isFixture = (path: string): boolean =>
  /(^|\/)(src\/test\/resources|fixtures?|testdata)\//i.test(path)
  || /fixture/i.test(path.split('/').pop() ?? '');

/**
 * The invariant a failing assertion encodes, if any.
 *
 * Matched on the invariant's own executable assertion appearing in the failure's
 * text — the message Surefire produced, or the assertion the stack points at.
 * Whitespace-normalised, because the message renders the assertion differently
 * from the source that contains it.
 */
export function touchedInvariant(
  failure: StructuredFailure,
  invariants: BehavioralInvariant[],
): BehavioralInvariant | undefined {
  const haystack = [
    failure.error,
    ...failure.relevantLogs,
    ...failure.failedTests.flatMap((t) => [t.name, t.message, t.stackHead ?? '']),
  ].join(' ').replace(/\s+/g, '');

  return invariants.find((i) => {
    const needle = i.assertion.replace(/\s+/g, '');
    if (needle.length < 8) return false;
    if (haystack.includes(needle)) return true;
    // Surefire reports `expected: <256> but was: <1088>` rather than the source
    // line, so an assertion is also matched by the literal it pins. The spacing
    // varies between JUnit 4 and 5 and between assertion libraries, so none of
    // it is assumed.
    const literal = /\(\s*(\d{2,})\s*,/.exec(i.assertion)?.[1];
    return Boolean(literal && new RegExp(`expected:?\\s*<?\\s*${literal}\\b`, 'i').test(
      [failure.error, ...failure.failedTests.map((t) => t.message)].join(' '),
    ));
  });
}

/**
 * Applies `EXEC-DIAG-*`, in precedence order.
 *
 * Returns null when nothing matched, which is the only condition under which
 * the model is consulted at all.
 */
export function classifyDeterministically(
  engine: RuleEngine,
  facts: Facts,
): Classification | null {
  for (const match of engine.matchExecution('FAILURE_CLASSIFICATION', facts)) {
    const outcome = match.outcome as {
      classification?: FailureClassification;
      permitAutonomousRepair?: boolean;
      countsTowardRetryBudget?: boolean;
      requiresTestIntegrityRecord?: boolean;
      baselineRequirementChanged?: boolean;
      gateType?: HumanGateType;
      action?: string;
    };
    // EXEC-DIAG-001 is procedural — it says to classify deterministically, not
    // what the classification is — so it matches every failure and carries no
    // verdict. Skipping outcomes without one is what keeps it from shadowing
    // EXEC-DIAG-008.
    if (!outcome.classification) continue;

    return {
      classification: outcome.classification,
      ruleId: match.rule.ruleId,
      source: 'DETERMINISTIC',
      permitAutonomousRepair: outcome.permitAutonomousRepair ?? false,
      countsTowardRetryBudget: outcome.countsTowardRetryBudget ?? true,
      requiresTestIntegrityRecord: outcome.requiresTestIntegrityRecord ?? false,
      ...(outcome.baselineRequirementChanged !== undefined
        ? { baselineRequirementChanged: outcome.baselineRequirementChanged }
        : {}),
      ...(outcome.gateType ? { gateType: outcome.gateType } : {}),
      ...(outcome.action === 'RAISE_RECOMMENDATION' ? { raiseRecommendation: true } : {}),
      rationale: match.rule.rationale,
    };
  }
  return null;
}

/**
 * The verdict when no classifier matched and the model could not resolve it
 * either (`EXEC-DIAG-008`).
 *
 * An unclassified failure repaired anyway is a guess with a commit attached.
 */
export function unclassified(engine: RuleEngine): Classification {
  // The same filter `classifyDeterministically` applies, and for the same
  // reason: EXEC-DIAG-001 matches every failure and carries no verdict, so
  // taking the first match would return the procedural rule rather than the
  // gate EXEC-DIAG-008 exists to raise.
  const match = engine
    .matchExecution('FAILURE_CLASSIFICATION', {
      noClassifierMatched: true,
      modelClassificationConfidence: 'LOW',
      failurePresent: true,
    })
    .find((m) => (m.outcome as { classification?: string }).classification);
  return {
    classification: 'UNKNOWN',
    ruleId: match?.rule.ruleId ?? 'EXEC-DIAG-008',
    source: 'DETERMINISTIC',
    permitAutonomousRepair: false,
    countsTowardRetryBudget: true,
    requiresTestIntegrityRecord: false,
    gateType: 'MATERIAL_ARCHITECTURE_DECISION',
    rationale: match?.rule.rationale
      ?? 'An unclassified failure repaired anyway is a guess with a commit attached.',
  };
}

// ---------------------------------------------------------------------------
// Repair authorisation — EXEC-REP-*
// ---------------------------------------------------------------------------

export interface RepairAuthorisation {
  permitted: boolean;
  /** Cited on the `MigrationChange` — `EXEC-REP-002`. */
  citedRuleIds: string[];
  /** `EXEC-REP-003` — from the second attempt, replace rather than layer. */
  revertFirst: boolean;
  gateType?: HumanGateType;
  reason: string;
}

/** What a repair may target. Anything else is `EXEC-ESC-008` territory. */
export const PERMITTED_REPAIR_TARGETS = ['MIGRATION_BRANCH', 'SANDBOX'] as const;

/**
 * Decides whether a repair may be attempted, and how.
 *
 * The rules decide, not the agent — `EXEC-REP-002` then requires the decision to
 * be cited on the change, so a repair whose justification is absent cannot be
 * distinguished from the agent trying things until the suite went green.
 */
export function authoriseRepair(
  engine: RuleEngine,
  classification: Classification,
  attemptsOnProblem: number,
): RepairAuthorisation {
  if (!classification.permitAutonomousRepair) {
    return {
      permitted: false,
      citedRuleIds: [classification.ruleId],
      revertFirst: false,
      ...(classification.gateType ? { gateType: classification.gateType } : {}),
      reason: `${classification.ruleId} classified this ${classification.classification} `
        + 'and does not permit autonomous repair.',
    };
  }

  const cited = [classification.ruleId, 'EXEC-REP-001', 'EXEC-REP-002'];

  // EXEC-REP-003. Stacked partial fixes make the diff unreviewable and the next
  // failure harder to classify, which is the thing the budget is counting.
  const revert = engine.firstExecution('REPAIR_AUTHORIZATION', {
    priorAttemptOnSameProblemKey: attemptsOnProblem,
    repairProposed: true,
  });
  const revertFirst = attemptsOnProblem >= 2;
  if (revertFirst && revert) cited.push('EXEC-REP-003');

  return {
    permitted: true,
    citedRuleIds: [...new Set(cited)],
    revertFirst,
    reason: `${classification.ruleId} permits autonomous repair of a `
      + `${classification.classification}; confined to the migration branch by EXEC-REP-001.`,
  };
}
