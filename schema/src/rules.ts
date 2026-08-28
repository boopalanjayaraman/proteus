import { z } from 'zod';

/**
 * Schemas for the two rule files in engine/rulesets/.
 *
 * The YAML is validated on load, so a malformed rule fails at startup with a path
 * rather than misbehaving silently at evaluation time. `when` and `then` are held
 * open — their keys are family-specific and grow — but the fields that carry
 * authority are closed, because those are what the gating discipline rests on.
 */

// ---------------------------------------------------------------------------
// Predicate values
// ---------------------------------------------------------------------------

export const ComparisonOp = z.enum(['lt', 'lte', 'eq', 'gte', 'gt']);
export type ComparisonOp = z.infer<typeof ComparisonOp>;

export const Comparison = z.object({
  op: ComparisonOp,
  value: z.union([z.number(), z.string()]),
});
export type Comparison = z.infer<typeof Comparison>;

/** One clause of a `when` block. */
export const PredicateValue: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    Comparison,
    z.array(z.union([z.string(), z.number()])),
    z.array(z.record(z.string(), PredicateValue)), // anyOf
  ]),
);

export const WhenClause = z.record(z.string(), PredicateValue);
export type WhenClause = z.infer<typeof WhenClause>;

export const ThenClause = z.record(z.string(), z.unknown());
export type ThenClause = z.infer<typeof ThenClause>;

/** Closed set — an action the agent may be forbidden to take. */
export const ProhibitedAction = z.enum([
  'REPLACE_ALGORITHM',
  'MODIFY_SOURCE',
  'UPGRADE_DEPENDENCY',
  'MODIFY_CONFIGURATION',
  'GENERATE_KEY',
  'REUSE_EXISTING_KEY_MATERIAL',
  'CREATE_TEST',
  'MODIFY_TEST',
  'MODIFY_MOCK',
  'REMOVE_LEGACY_ALGORITHM',
  'DEPLOY_SANDBOX',
  'ASSUME_CAPABILITY',
]);
export type ProhibitedAction = z.infer<typeof ProhibitedAction>;

// ---------------------------------------------------------------------------
// Standards rules — pqc-migration-rules.yaml
// ---------------------------------------------------------------------------

export const RuleAuthority = z.enum(['NORMATIVE_FINAL', 'NORMATIVE_DRAFT', 'INFORMATIVE']);
export type RuleAuthority = z.infer<typeof RuleAuthority>;

export const StandardsFamily = z.enum([
  'ALGORITHM_CLASSIFICATION',
  'USAGE_CLASSIFICATION',
  'MIGRATION_TARGET',
  'PARAMETER_SELECTION',
  'PROHIBITION',
  'DETECTION_SIGNATURE',
  'USAGE_CONSTRAINT',
  'TRANSITION_TIMELINE',
  'HYBRID_CONSTRUCTION',
  'DISPOSITION',
  'INVENTORY_FIELD',
  'VERIFICATION_ASSERTION',
]);
export type StandardsFamily = z.infer<typeof StandardsFamily>;

export const StandardsRule = z
  .object({
    ruleId: z.string().min(1),
    family: StandardsFamily,
    title: z.string().min(1),
    authority: RuleAuthority,
    evidenceClass: z.enum(['OBSERVED', 'INFERRED']),
    normativeStrength: z.enum([
      'SHALL',
      'SHALL_NOT',
      'SHOULD',
      'SHOULD_NOT',
      'MAY',
      'STATEMENT',
    ]),
    confidence: z.number().min(0).max(1),
    machineEvaluable: z.boolean(),
    gating: z.boolean(),
    inDemoScope: z.boolean(),
    when: WhenClause.default({}),
    then: ThenClause.default({}),
    prohibitedActions: z.array(ProhibitedAction).default([]),
    quote: z.string().min(1),
    source: z.object({
      document: z.string(),
      section: z.string(),
      page: z.number().int().positive(),
    }),
    supersedes: z.array(z.string()).default([]),
    notes: z.string().default(''),
  })
  .superRefine((r, ctx) => {
    // The gating discipline, enforced at load rather than trusted from the file.
    if (r.gating && r.authority !== 'NORMATIVE_FINAL') {
      ctx.addIssue({
        code: 'custom',
        path: ['gating'],
        message: `${r.ruleId}: only NORMATIVE_FINAL may gate (is ${r.authority})`,
      });
    }
    if (r.gating && r.evidenceClass !== 'OBSERVED') {
      ctx.addIssue({
        code: 'custom',
        path: ['gating'],
        message: `${r.ruleId}: an INFERRED rule may not gate`,
      });
    }
    if (r.evidenceClass === 'INFERRED' && r.confidence >= 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['confidence'],
        message: `${r.ruleId}: INFERRED cannot carry confidence 1.0`,
      });
    }
  });
export type StandardsRule = z.infer<typeof StandardsRule>;

export const StandardsRuleset = z.object({
  schemaVersion: z.number().int(),
  corpus: z.array(
    z.object({
      document: z.string(),
      title: z.string().optional(),
      pages: z.number().int().positive(),
      publisher: z.string().optional(),
      status: z.string().optional(),
      authority: RuleAuthority,
      tier: z.string().optional(),
    }),
  ),
  rules: z.array(StandardsRule),
});
export type StandardsRuleset = z.infer<typeof StandardsRuleset>;

// ---------------------------------------------------------------------------
// Execution rules — migration-execution-rules.yaml
// ---------------------------------------------------------------------------

export const Provenance = z.enum(['STANDARDS_DERIVED', 'SPEC_DERIVED', 'ENGINEERING']);
export type Provenance = z.infer<typeof Provenance>;

export const ExecutionFamily = z.enum([
  'DETECTION_SIGNATURE',
  'DISPOSITION',
  'INVARIANT_CAPTURE',
  'TEST_GENERATION',
  'MOCK_STRATEGY',
  'FAILURE_CLASSIFICATION',
  'REPAIR_AUTHORIZATION',
  'ESCALATION',
  'VERIFICATION',
]);
export type ExecutionFamily = z.infer<typeof ExecutionFamily>;

export const ExecutionRule = z
  .object({
    ruleId: z.string().min(1),
    family: ExecutionFamily,
    title: z.string().min(1),
    provenance: Provenance,
    specSection: z.string().optional(),
    derivedFrom: z.array(z.string()).default([]),
    gating: z.boolean(),
    stage: z.string(),
    when: WhenClause.default({}),
    then: ThenClause.default({}),
    prohibitedActions: z.array(ProhibitedAction).default([]),
    rationale: z.string().min(1),
    schemaNote: z.string().optional(),
  })
  .superRefine((r, ctx) => {
    if (r.gating && r.provenance === 'ENGINEERING') {
      ctx.addIssue({
        code: 'custom',
        path: ['gating'],
        message: `${r.ruleId}: an ENGINEERING rule may not gate — it has no external authority`,
      });
    }
    if (r.provenance === 'STANDARDS_DERIVED' && r.derivedFrom.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['derivedFrom'],
        message: `${r.ruleId}: STANDARDS_DERIVED must name the standards rule it derives from`,
      });
    }
    if (r.provenance === 'SPEC_DERIVED' && !r.specSection) {
      ctx.addIssue({
        code: 'custom',
        path: ['specSection'],
        message: `${r.ruleId}: SPEC_DERIVED must name the specification section`,
      });
    }
  });
export type ExecutionRule = z.infer<typeof ExecutionRule>;

export const ExecutionRuleset = z.object({
  schemaVersion: z.number().int(),
  subtypes: z.record(z.string(), z.array(z.string())).default({}),
  policy: z.object({
    maxMeaningfulAutonomousAttempts: z.number().int().positive(),
    autonomyBoundary: z.string(),
    originalBranch: z.string(),
    productionAccess: z.string(),
  }),
  rules: z.array(ExecutionRule),
});
export type ExecutionRuleset = z.infer<typeof ExecutionRuleset>;

/** Either kind, as the evaluator sees it. */
export type AnyRule = StandardsRule | ExecutionRule;

export function isExecutionRule(r: AnyRule): r is ExecutionRule {
  return 'provenance' in r;
}
