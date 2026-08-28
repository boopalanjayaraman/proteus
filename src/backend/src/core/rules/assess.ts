import type {
  CryptoUsage,
  Disposition,
  FailureClassification,
  MigrationImpact,
  RecommendationDisposition,
  Severity,
  VerificationCheck,
} from '@proteus/schema';
import type { RuleEngine } from './engine';
import type { Facts } from './predicates';

/**
 * The three deterministic decisions the product makes from rules: what a finding is,
 * what to do about it, and why a build failed. Each returns the rule that decided,
 * so the answer is always attributable in the audit trail.
 */

export interface Decision<T> {
  value: T;
  ruleId: string;
  gating: boolean;
}

// ---------------------------------------------------------------------------
// Classification — is this quantum-vulnerable, and how badly
// ---------------------------------------------------------------------------

export interface Classification {
  quantumVulnerable: boolean;
  severity?: Severity;
  impact?: MigrationImpact;
  ruleIds: string[];
}

export function classifyAlgorithm(engine: RuleEngine, facts: Facts): Classification | null {
  const matches = engine.matchStandards('ALGORITHM_CLASSIFICATION', facts);
  if (matches.length === 0) return null;
  // A gating (Tier A) classification outranks an informative corroboration.
  const primary = matches.find((m) => m.gating) ?? matches[0]!;
  return {
    quantumVulnerable: Boolean(primary.outcome['quantumVulnerable']),
    severity: primary.outcome['severity'] as Severity | undefined,
    impact: primary.outcome['impact'] as MigrationImpact | undefined,
    ruleIds: matches.map((m) => m.rule.ruleId),
  };
}

// ---------------------------------------------------------------------------
// Migration target
// ---------------------------------------------------------------------------

export interface MigrationTarget {
  target: string;
  targetFamily: string;
  parameterSet?: string;
  securityCategory?: number;
  ruleIds: string[];
}

export function resolveTarget(engine: RuleEngine, facts: Facts): MigrationTarget | null {
  const targets = engine.matchStandards('MIGRATION_TARGET', facts);
  if (targets.length === 0) return null;
  const primary = targets.find((t) => t.gating) ?? targets[0]!;

  // Parameter selection is a separate decision from "which family replaces this" —
  // FIPS203-3.2-001 enumerates what is approved, FIPS203-8-001 picks the default.
  const paramFacts: Facts = { ...facts, algorithm: primary.outcome['target'] };
  const params = engine.matchStandards('PARAMETER_SELECTION', paramFacts);
  const selection = params.find((p) => p.outcome['parameterSet']);

  return {
    target: String(primary.outcome['target']),
    targetFamily: String(primary.outcome['targetFamily'] ?? ''),
    parameterSet: selection?.outcome['parameterSet'] as string | undefined,
    securityCategory: selection?.outcome['securityCategory'] as number | undefined,
    ruleIds: [...targets.map((t) => t.rule.ruleId), ...(selection ? [selection.rule.ruleId] : [])],
  };
}

// ---------------------------------------------------------------------------
// Disposition — what the agent proposes to do, and who owns it
// ---------------------------------------------------------------------------

export interface DispositionDecision {
  disposition: Disposition;
  ruleId: string;
  autonomyBoundary?: string;
  recommendation?: {
    disposition: RecommendationDisposition;
    subtype?: string;
    suggestedOwner?: string;
  };
  suppressedBy?: string[];
}

export function resolveDisposition(
  engine: RuleEngine,
  facts: Facts,
): DispositionDecision | null {
  // A prohibition outranks any disposition it contradicts — the engine must be able
  // to refuse regardless of what the disposition rules would otherwise allow.
  const prohibitions = engine
    .matchStandards('PROHIBITION', facts)
    .filter((p) => p.outcome['engineBehaviour'] === 'SUPPRESS_PLAN_ITEM');

  const matches = engine.matchExecution('DISPOSITION', facts);
  if (matches.length === 0) return null;
  const first = matches[0]!; // precedence-ordered: AUTONOMOUS_MIGRATION is last

  const rec = first.outcome['recommendationDisposition'];
  return {
    disposition: first.outcome['disposition'] as Disposition,
    ruleId: first.rule.ruleId,
    autonomyBoundary: first.outcome['autonomyBoundary'] as string | undefined,
    recommendation:
      typeof rec === 'string' && rec !== 'fromDispositionRule'
        ? {
            disposition: rec as RecommendationDisposition,
            subtype: first.outcome['subtype'] as string | undefined,
            suggestedOwner: first.outcome['suggestedOwner'] as string | undefined,
          }
        : undefined,
    suppressedBy: prohibitions.length ? prohibitions.map((p) => p.rule.ruleId) : undefined,
  };
}

// ---------------------------------------------------------------------------
// Failure classification — deterministic first, model only for the residue
// ---------------------------------------------------------------------------

export interface FailureDecision {
  classification: FailureClassification;
  ruleId: string;
  source: 'DETERMINISTIC';
  permitAutonomousRepair: boolean;
  countsTowardRetryBudget: boolean;
  gateType?: string;
  requiresTestIntegrityRecord: boolean;
}

/**
 * Returns null when no classifier matched — the caller then asks the Diagnostic
 * Agent, and records that the classification came from a model rather than a rule.
 * Spec §46: the deterministic path is tried first, always.
 */
export function classifyFailure(engine: RuleEngine, facts: Facts): FailureDecision | null {
  const matches = engine
    .matchExecution('FAILURE_CLASSIFICATION', facts)
    .filter((m) => m.outcome['classification']);
  if (matches.length === 0) return null;
  const first = matches[0]!; // precedence: baseline-invariant failure wins outright

  return {
    classification: first.outcome['classification'] as FailureClassification,
    ruleId: first.rule.ruleId,
    source: 'DETERMINISTIC',
    permitAutonomousRepair: first.outcome['permitAutonomousRepair'] === true,
    // Defaults to true: a failure counts against the budget unless a rule exempts it.
    countsTowardRetryBudget: first.outcome['countsTowardRetryBudget'] !== false,
    gateType: first.outcome['gateType'] as string | undefined,
    requiresTestIntegrityRecord: first.outcome['requiresTestIntegrityRecord'] === true,
  };
}

// ---------------------------------------------------------------------------
// Verification checks the rules require
// ---------------------------------------------------------------------------

export interface RequiredCheck {
  check: VerificationCheck;
  ruleId: string;
  gating: boolean;
  assertion: unknown;
}

export function requiredChecks(engine: RuleEngine, facts: Facts): RequiredCheck[] {
  return engine
    .matchExecution('VERIFICATION', facts)
    .filter((m) => m.outcome['check'])
    .map((m) => ({
      check: m.outcome['check'] as VerificationCheck,
      ruleId: m.rule.ruleId,
      gating: m.gating,
      assertion: m.outcome['assert'] ?? m.outcome['assertions'] ?? null,
    }));
}

// ---------------------------------------------------------------------------
// Detection — candidate locations for the discovery agent
// ---------------------------------------------------------------------------

export interface DetectionCandidate {
  ruleId: string;
  patterns: string[];
  impliesUsage?: CryptoUsage;
  strength: 'STRONG' | 'WEAK';
  requireAll: boolean;
  excludeWhenAlsoMatches: string[];
}

export function detectionsFor(engine: RuleEngine, facts: Facts): DetectionCandidate[] {
  return engine.matchExecution('DETECTION_SIGNATURE', facts).map((m) => ({
    ruleId: m.rule.ruleId,
    patterns: (m.outcome['patterns'] as string[]) ?? [],
    impliesUsage: m.outcome['impliesUsage'] as CryptoUsage | undefined,
    // A detection rule that does not claim STRONG is weak: it proposes a usage for
    // investigation and must never auto-assign one.
    strength: m.outcome['strength'] === 'STRONG' ? 'STRONG' : 'WEAK',
    requireAll: m.outcome['requireAll'] === true,
    excludeWhenAlsoMatches: (m.outcome['excludeWhenAlsoMatches'] as string[]) ?? [],
  }));
}
