import { ChangeType, CryptoUsage, PlanItemMode } from '@proteus/schema';
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
