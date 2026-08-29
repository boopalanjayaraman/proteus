import { ChangeType, CryptoUsage, FailureClassification, PlanItemMode } from '@proteus/schema';
import { z } from 'zod';

/**
 * Agent tool tables.
 *
 * Each agent's capability boundary is a list, not an instruction. A1 cannot
 * create a branch because the tool is absent from its table — not because a
 * prompt asks it not to. That is the whole argument for four agents rather than
 * one (agent architecture §2), and it is only true if the tables stay honest.
 */

export const READ_ONLY_TOOL_NAMES = [
  'list_files',
  'read_file',
  'search_repository',
  'inspect_dependencies',
  'inspect_configuration',
  'inspect_tests',
  'analyze_uploaded_document',
  'assert_finding',
  'attach_evidence',
  'upsert_graph_node',
  'upsert_graph_edge',
] as const;

/**
 * Anything that changes the repository, the build, or the outside world.
 *
 * A1 must never hold one of these. The list exists so a test can assert it,
 * rather than a reviewer having to notice.
 */
export const WRITE_TOOL_NAMES = [
  'create_branch', 'apply_patch', 'revert_patch', 'commit', 'push',
  'generate_test', 'generate_mock', 'generate_fixture',
  'run_cloud_build', 'run_tests', 'deploy_sandbox', 'run_e2e',
] as const;

export type ToolName = (typeof READ_ONLY_TOOL_NAMES)[number] | (typeof WRITE_TOOL_NAMES)[number];

export const isWriteTool = (name: string): boolean =>
  (WRITE_TOOL_NAMES as readonly string[]).includes(name);

// ---------------------------------------------------------------------------
// Tool input schemas — the same Zod definitions the database validates against,
// so structured model output lands pre-validated in the shape Mongo stores.
// ---------------------------------------------------------------------------

/**
 * The agent's judgment on a weak detection signal.
 *
 * It may only choose among usages the enum defines, and it must say what in the
 * code convinced it. `UNKNOWN` is a permitted answer: an agent that must always
 * decide will always decide, including when it should not.
 */
export const ResolveUsageInput = z.object({
  candidateId: z.string(),
  usage: CryptoUsage,
  reasoning: z.string().min(1),
  confidence: z.number().min(0).max(1),
});
export type ResolveUsageInput = z.infer<typeof ResolveUsageInput>;

/**
 * A relationship the agent believes exists between a document and the code.
 *
 * Always INFERRED — a correlation is reasoning, not observation. The evidence
 * schema rejects OBSERVED from a model actor, so this cannot be forged upward.
 */
export const CorrelationInput = z.object({
  claim: z.string().min(1),
  documentFileId: z.string().optional(),
  documentPage: z.number().int().positive().optional(),
  relatedFindingIds: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(0.99),
  reasoning: z.string().min(1),
});
export type CorrelationInput = z.infer<typeof CorrelationInput>;

export const DiscoveryVerdict = z.object({
  sufficient: z.boolean(),
  reasoning: z.string().min(1),
  outstandingQuestions: z.array(z.string()).default([]),
});
export type DiscoveryVerdict = z.infer<typeof DiscoveryVerdict>;

// ---------------------------------------------------------------------------
// A2 — the Assessment Agent
// ---------------------------------------------------------------------------

/**
 * A2 reads persisted state and writes prose. Nothing else.
 *
 * Absent from this list, deliberately: every read-only repository tool A1 holds.
 * A2 assesses what discovery established; if it could re-read the source it
 * would be free to assess something discovery never recorded, and the assessment
 * would stop being a view of the audit trail (agent architecture §2).
 */
export const ASSESSMENT_TOOL_NAMES = [
  'get_findings',
  'get_graph',
  'get_evidence',
  'get_policy',
  'compose_plan_item',
  'write_assessment',
  'raise_recommendation',
] as const;

/** Tools that read the repository. A2 must hold none of them. */
export const REPOSITORY_TOOL_NAMES = [
  'list_files', 'read_file', 'search_repository',
  'inspect_dependencies', 'inspect_configuration', 'inspect_tests',
] as const;

export const isRepositoryTool = (name: string): boolean =>
  (REPOSITORY_TOOL_NAMES as readonly string[]).includes(name);

/**
 * What the agent says about one finding.
 *
 * `disposition` is absent by design: the rules assigned it before A2 ran, and a
 * field the model could fill is a field the model could change.
 */
export const FindingNarrativeInput = z.object({
  findingId: z.string(),
  title: z.string().min(1),
  summaryLine: z.string().min(1),
  description: z.string().min(1),
  /** Present even for NO_CHANGE_REQUIRED — "no modification, and here is why". */
  agentIntent: z.string().min(1),
});
export type FindingNarrativeInput = z.infer<typeof FindingNarrativeInput>;

export const PlanItemInput = z.object({
  targetName: z.string().min(1),
  findingIds: z.array(z.string()).min(1),
  mode: PlanItemMode,
  action: z.string().min(1),
  rationale: z.string().min(1),
  expectedChanges: z
    .array(
      z.object({
        changeType: ChangeType,
        /** Path patterns, not exact files: the agent has not edited anything yet. */
        paths: z.array(z.string()).default([]),
        description: z.string().min(1),
      }),
    )
    .default([]),
  conditions: z.array(z.string()).default([]),
  risk: z.enum(['LOW', 'MEDIUM', 'HIGH']),
});
export type PlanItemInput = z.infer<typeof PlanItemInput>;

export const RecommendationNarrativeInput = z.object({
  findingId: z.string(),
  /** The recommended action, in prose. An item with no action is a complaint. */
  action: z.string().min(1),
});
export type RecommendationNarrativeInput = z.infer<typeof RecommendationNarrativeInput>;

/** The four questions Screen 3 must answer (spec §14). */
export const AssessmentSummaryInput = z.object({
  headline: z.string().min(1),
  whatExists: z.string().min(1),
  whatIsVulnerable: z.string().min(1),
  whatAgentWillChange: z.string().min(1),
  whatAgentWillNotChange: z.string().min(1),
});
export type AssessmentSummaryInput = z.infer<typeof AssessmentSummaryInput>;

// ---------------------------------------------------------------------------
// A3 — branch, baseline and test engineering (PRD-11)
// ---------------------------------------------------------------------------

/**
 * A3's table.
 *
 * It writes tests and mocks and it runs builds, but it holds no
 * `apply_patch` for implementation source — that arrives with A4 in PRD-12.
 * The separation is the reason `EXEC-INV-001` ("no source modification during
 * baseline capture") can be structural rather than a prompt instruction: during
 * this phase the capability to modify source is not on the table at all.
 */
export const TEST_ENGINEERING_TOOL_NAMES = [
  'list_files', 'read_file', 'search_repository', 'inspect_tests',
  'create_branch', 'generate_test', 'generate_mock', 'generate_fixture',
  'commit', 'run_cloud_build', 'run_tests',
] as const;

/** Tools that change implementation source. A3 must hold none of them. */
export const SOURCE_MUTATING_TOOL_NAMES = ['apply_patch', 'revert_patch'] as const;

export const mutatesSource = (name: string): boolean =>
  (SOURCE_MUTATING_TOOL_NAMES as readonly string[]).includes(name);

/**
 * One externally observable behaviour, captured before anything moves.
 *
 * `disposition` is absent for the same reason `FindingNarrativeInput` has no
 * disposition field: `EXEC-INV-003` sets it per kind, and a field the model
 * fills is a field the model decides. It may only *propose* a departure from
 * the default, and only with a reason — which is recorded and constrained.
 */
export const InvariantInput = z.object({
  kind: z.enum([
    'API_BEHAVIOR', 'CRYPTO_OUTCOME', 'FAILURE_MODE', 'MESSAGE_FORMAT', 'FUNCTIONAL_OUTCOME',
  ]),
  description: z.string().min(1), // "Malformed peer key → 400"
  /** Executable — `EXEC-INV-004` rejects prose, because verification re-runs this. */
  assertion: z.string().min(8),
  capturedFrom: z.enum(['EXISTING_TEST', 'GENERATED_PROBE', 'RUNTIME_OBSERVATION']),
  proposedDisposition: z.enum(['MUST_PRESERVE', 'EXPECTED_TO_CHANGE']).optional(),
  /** Required for the proposal to be considered at all. */
  overrideReason: z.string().optional(),
});
export type InvariantInput = z.infer<typeof InvariantInput>;

/**
 * A test or mock the agent proposes to write.
 *
 * Nothing here is written on the model's say-so: every artifact passes through
 * `guardTestArtifact` first, and an acceptance test is additionally run against
 * the base commit before it is kept (`EXEC-TEST-002`).
 */
export const GeneratedTestInput = z.object({
  path: z.string().min(1),
  changeType: z.enum(['TEST', 'MOCK', 'FIXTURE']),
  testKind: z.enum(['CHARACTERIZATION', 'MIGRATION_ACCEPTANCE_TEST', 'MOCK', 'FIXTURE']),
  content: z.string().min(1),
  summary: z.string().min(1),
  rationale: z.string().min(1),
  /** What a mock stands in for. Mocking the peer is permitted; the primitive is not. */
  mockTarget: z.string().optional(),
  findingIds: z.array(z.string()).default([]),
  planItemIds: z.array(z.string()).default([]),
  /** Spec §26 — classification comes before the edit, not after it. */
  testIntegrity: z
    .object({
      failureClassification: FailureClassification,
      reason: z.string().min(1),
      baselineRequirementChanged: z.boolean(),
      safeAutonomousModification: z.boolean(),
    })
    .optional(),
});
export type GeneratedTestInput = z.infer<typeof GeneratedTestInput>;

/** Which components the agent judges to be uncovered (`EXEC-TEST-001`). */
export const CoverageAssessmentInput = z.object({
  component: z.string().min(1),
  path: z.string().min(1),
  covered: z.boolean(),
  reasoning: z.string().min(1),
});
export type CoverageAssessmentInput = z.infer<typeof CoverageAssessmentInput>;

// ---------------------------------------------------------------------------
// A3 patching and A4 diagnosis (PRD-12)
// ---------------------------------------------------------------------------

/**
 * A4's table.
 *
 * Read-only on failure evidence, and it did not write the code it is judging.
 * That second half is the structural argument: spec §26 forbids weakening a test
 * to get a pass, and an agent that authored the failing patch is adjudicating
 * its own work while motivated to conclude the test is wrong. A separate agent
 * with no write tool has no such incentive — and the absence of the tool is what
 * makes that true regardless of what its prompt says.
 */
export const DIAGNOSTIC_TOOL_NAMES = [
  'get_failure_evidence', 'get_execution_log', 'get_baseline', 'get_change', 'read_file',
  'record_diagnosis',
] as const;

/** A3 in its patching role. Adds source modification, which A3-as-tester lacks. */
export const MIGRATION_TOOL_NAMES = [
  'list_files', 'read_file', 'search_repository',
  'apply_patch', 'revert_patch', 'commit', 'push', 'get_diff',
  'generate_test', 'generate_mock', 'generate_fixture',
  'run_cloud_build', 'run_tests',
] as const;

/**
 * One patch against one plan item.
 *
 * Whole file contents rather than a diff: a model-authored unified diff has to
 * apply against an exact context it cannot see, and a failed hunk is
 * indistinguishable from a refused change. Writing the file and letting git
 * compute the diff makes the patch either valid or a compile error, which the
 * classifiers can then act on.
 */
export const PatchInput = z.object({
  planItemId: z.string(),
  files: z
    .array(
      z.object({
        path: z.string().min(1),
        content: z.string(),
        operation: z.enum(['ADDED', 'MODIFIED']).default('MODIFIED'),
      }),
    )
    .min(1),
  summary: z.string().min(1), // "Migrated CryptoService to ML-KEM-768"
  rationale: z.string().min(1),
  changeType: ChangeType,
  findingIds: z.array(z.string()).default([]),
});
export type PatchInput = z.infer<typeof PatchInput>;

/**
 * A repair, authorised before it was asked for.
 *
 * `classification` is supplied to the agent, not chosen by it — the rules
 * classified the failure before A3 was invoked, and a field the patch author
 * could set is a classification the patch author could pick to suit the repair
 * it wanted to make.
 */
export const RepairInput = z.object({
  files: z
    .array(
      z.object({
        path: z.string().min(1),
        content: z.string(),
        operation: z.enum(['ADDED', 'MODIFIED']).default('MODIFIED'),
      }),
    )
    .min(1),
  summary: z.string().min(1),
  rationale: z.string().min(1),
  changeType: ChangeType,
  /** Required for TEST/MOCK/FIXTURE — spec §26, classification before the edit. */
  testIntegrity: z
    .object({
      failureClassification: FailureClassification,
      reason: z.string().min(1),
      baselineRequirementChanged: z.boolean(),
      safeAutonomousModification: z.boolean(),
    })
    .optional(),
});
export type RepairInput = z.infer<typeof RepairInput>;

/**
 * A4's answer.
 *
 * `withinAutonomousBoundary` and `baselineRequirementChanged` are asked of the
 * diagnostician rather than the author for the same reason the split exists at
 * all. `confidence` is load-bearing: EXEC-DIAG-008 turns a low-confidence
 * diagnosis into a gate rather than a guess.
 */
export const DiagnosisInput = z.object({
  classification: FailureClassification,
  rootCause: z.string().min(1),
  reasoning: z.string().min(1),
  withinAutonomousBoundary: z.boolean(),
  baselineRequirementChanged: z.boolean(),
  proposedAction: z.string().min(1),
  confidence: z.number().min(0).max(1),
});
export type DiagnosisInput = z.infer<typeof DiagnosisInput>;
