import { z } from 'zod';

/**
 * Every enum in the product vocabulary, defined once.
 *
 * Mirrors the spec (§4, §8, §10, §12, §15, §18, §22, §29, §41; Architecture §23)
 * and the UX design canvas v1.1 where the two differ on shape. Genkit tool
 * schemas and the Mongo layer both consume these, so Gemini can only ever emit a
 * value the database accepts.
 */

// ---------------------------------------------------------------------------
// Project lifecycle (spec §4)
// ---------------------------------------------------------------------------

export const ProjectStage = z.enum([
  'CREATED',
  'ANALYZING',
  'ASSESSMENT_READY',
  'AWAITING_APPROVAL',
  'MIGRATING',
  'VERIFYING',
  'SANDBOX_READY',
  'COMPLETED',
  'NEEDS_HUMAN_ACTION',
  'FAILED',
]);
export type ProjectStage = z.infer<typeof ProjectStage>;

/**
 * The eight ordered stages behind each project tile's progress rail. The two
 * exceptional stages colour the rail rather than advancing it, so they are
 * excluded here.
 */
export const STAGE_RAIL = [
  'CREATED',
  'ANALYZING',
  'ASSESSMENT_READY',
  'AWAITING_APPROVAL',
  'MIGRATING',
  'VERIFYING',
  'SANDBOX_READY',
  'COMPLETED',
] as const satisfies readonly ProjectStage[];

/** Filled segments on the rail, 0..8. Exceptional stages hold their position. */
export function railProgress(stage: ProjectStage): number {
  const i = (STAGE_RAIL as readonly string[]).indexOf(stage);
  return i < 0 ? 0 : i + 1;
}

export const DiscoveryStage = z.enum([
  'QUEUED',
  'CLONING',
  'INSPECTING_STRUCTURE',
  'SCANNING_CRYPTO',
  'ANALYZING_DEPENDENCIES',
  'ANALYZING_DOCUMENTS',
  'CORRELATING',
  'BUILDING_GRAPH',
  'GENERATING_ASSESSMENT',
  'COMPLETED',
  'FAILED',
]);
export type DiscoveryStage = z.infer<typeof DiscoveryStage>;

/** Spec §22 — milestones shown as the migration stage rail. */
export const MigrationStage = z.enum([
  'PREPARING_MIGRATION',
  'CREATING_BRANCH',
  'CAPTURING_BASELINE',
  'ASSESSING_TEST_COVERAGE',
  'CREATING_TESTS',
  'PREPARING_MOCKS',
  'VALIDATING_BASELINE_TESTS',
  'APPLYING_MIGRATION_CHANGES',
  'BUILDING',
  'RUNNING_TESTS',
  'ANALYZING_FAILURE',
  'REPAIRING',
  'REBUILDING',
  'RETESTING',
  'CRYPTO_VERIFYING',
  'SANDBOX_DEPLOYING',
  'END_TO_END_VERIFYING',
  'COMPLETED',
]);
export type MigrationStage = z.infer<typeof MigrationStage>;

/** Either phase's fine-grained stage, as stamped onto an event. */
export const Stage = z.union([DiscoveryStage, MigrationStage]);
export type Stage = z.infer<typeof Stage>;

// ---------------------------------------------------------------------------
// Evidence (spec §11, §16)
// ---------------------------------------------------------------------------

export const EvidenceType = z.enum([
  'SOURCE_CODE',
  'CONFIGURATION',
  'DEPENDENCY',
  'TEST',
  'DOCUMENT',
  'EXISTING_FINDING',
  'BUILD_OUTPUT',
  'TEST_OUTPUT',
  'RUNTIME_OBSERVATION',
  'USER_INSTRUCTION',
  'MODEL_REASONING',
]);
export type EvidenceType = z.infer<typeof EvidenceType>;

export const EvidenceClass = z.enum(['OBSERVED', 'INFERRED']);
export type EvidenceClass = z.infer<typeof EvidenceClass>;

export const EvidenceActor = z.enum(['TOOL', 'MODEL', 'USER']);
export type EvidenceActor = z.infer<typeof EvidenceActor>;

// ---------------------------------------------------------------------------
// Dependency graph (spec §10, §12)
// ---------------------------------------------------------------------------

export const NodeType = z.enum([
  'APPLICATION',
  'SERVICE',
  'SOURCE_COMPONENT',
  'CRYPTO_IMPLEMENTATION',
  'CRYPTO_LIBRARY',
  'ALGORITHM',
  'CERTIFICATE',
  'KEY',
  'PROTOCOL',
  'API',
  'DATABASE',
  'EXTERNAL_SERVICE',
  'HSM',
  'SECURE_ELEMENT',
  'OT_DEVICE',
  'IOT_DEVICE',
  'SECURITY_APPLIANCE',
  'VENDOR_DEPENDENCY',
  'TEST_MOCK',
]);
export type NodeType = z.infer<typeof NodeType>;

/**
 * SECURES is not in spec §10, but the UX uses it on the TLS → API edge and USES
 * would lose the direction of protection.
 */
export const RelationshipType = z.enum([
  'USES',
  'SECURES',
  'DEPENDS_ON',
  'AUTHENTICATES_WITH',
  'ENCRYPTS_WITH',
  'SIGNS_WITH',
  'STORES_KEY_IN',
  'CONNECTS_TO',
  'TESTED_BY',
  'SIMULATED_BY',
  'CONTROLLED_BY',
  'REQUIRES_MIGRATION_WITH',
]);
export type RelationshipType = z.infer<typeof RelationshipType>;

/**
 * Applies to nodes and edges alike (spec §12). The graph legend collapses
 * VENDOR_CONTROLLED and HARDWARE_CONTROLLED into one swatch; that is a display
 * grouping, and they stay distinct here because the disposition and the
 * recommendation owner differ between them.
 */
export const MigrationImpact = z.enum([
  'MIGRATION_REQUIRED',
  'MIGRATION_LIKELY',
  'NO_PQC_CHANGE_REQUIRED',
  'DEPENDENCY_REQUIRES_INVESTIGATION',
  'VENDOR_CONTROLLED',
  'HARDWARE_CONTROLLED',
  'BLOCKED',
  'UNKNOWN',
]);
export type MigrationImpact = z.infer<typeof MigrationImpact>;

// ---------------------------------------------------------------------------
// Findings (spec §8, §15, §18)
// ---------------------------------------------------------------------------

export const FindingCategory = z.enum([
  'CRYPTOGRAPHIC',
  'APPLICATION',
  'HARDWARE_INFRASTRUCTURE',
  'MIGRATION_DEVIATION',
]);
export type FindingCategory = z.infer<typeof FindingCategory>;

/**
 * Spec §8: the primitive alone is not the finding. RSA-2048 for key transport and
 * RSA-2048 for signing are different findings with different targets, and the
 * migration policy keys off this field.
 */
export const CryptoUsage = z.enum([
  'KEY_ESTABLISHMENT',
  'KEY_TRANSPORT',
  'DIGITAL_SIGNATURE',
  'CERTIFICATE_VALIDATION',
  'AUTHENTICATION',
  'SYMMETRIC_ENCRYPTION',
  'HASHING',
  'MAC',
  'RANDOMNESS',
  'KEY_STORAGE',
  'UNKNOWN',
]);
export type CryptoUsage = z.infer<typeof CryptoUsage>;

/** What kind of problem a finding is. */
export const Disposition = z.enum([
  'AUTONOMOUS_MIGRATION',
  'ASSISTED_MIGRATION',
  'NO_CHANGE_REQUIRED',
  'VENDOR_DEPENDENCY',
  'HARDWARE_REPLACEMENT',
  'HUMAN_DECISION_REQUIRED',
  'NEEDS_FURTHER_INVESTIGATION',
]);
export type Disposition = z.infer<typeof Disposition>;

/**
 * What the agent will *do*. A separate vocabulary from Disposition on purpose:
 * one AUTONOMOUS_MIGRATION finding can produce an AUTONOMOUS_GENERATION plan item.
 */
export const PlanItemMode = z.enum([
  'AUTONOMOUS_MIGRATION',
  'AUTONOMOUS_UPDATE',
  'AUTONOMOUS_GENERATION',
  'TEST_ENVIRONMENT_ADAPTATION',
  'ASSISTED_MIGRATION',
  'NO_AUTONOMOUS_CHANGE',
]);
export type PlanItemMode = z.infer<typeof PlanItemMode>;

/** Plan modes the agent may execute without further human input. */
export const AUTONOMOUS_PLAN_MODES = [
  'AUTONOMOUS_MIGRATION',
  'AUTONOMOUS_UPDATE',
  'AUTONOMOUS_GENERATION',
  'TEST_ENVIRONMENT_ADAPTATION',
] as const satisfies readonly PlanItemMode[];

/** What the agent will not do, and who should (UX v1.1). */
export const RecommendationDisposition = z.enum([
  'HUMAN_DECISION',
  'HARDWARE_REPLACEMENT',
  'VENDOR_DECISION',
  'FOLLOW_ON_WORKSTREAM',
]);
export type RecommendationDisposition = z.infer<typeof RecommendationDisposition>;

export const Severity = z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO']);
export type Severity = z.infer<typeof Severity>;

export const BlockerKind = z.enum([
  'UNSUPPORTED_DEPENDENCY',
  'EXTERNAL_PROTOCOL',
  'VENDOR_DEPENDENCY',
  'NO_PQC_SUPPORT',
  'TEST_DEFICIENCY',
  'ARCHITECTURE_CONSTRAINT',
]);
export type BlockerKind = z.infer<typeof BlockerKind>;

export const FindingStatus = z.enum([
  'OPEN',
  'PLANNED',
  'IN_MIGRATION',
  'MIGRATED',
  'VERIFIED',
  'EXCLUDED',
  'BLOCKED',
]);
export type FindingStatus = z.infer<typeof FindingStatus>;

// ---------------------------------------------------------------------------
// Execution and failure (spec §29, §33)
// ---------------------------------------------------------------------------

export const FailureClassification = z.enum([
  'BUILD_DEFECT',
  'IMPLEMENTATION_DEFECT',
  'DEPENDENCY_INCOMPATIBILITY',
  'CONFIGURATION_DEFECT',
  'TEST_COVERAGE_GAP',
  'TEST_FIXTURE_OUTDATED',
  'MOCK_INCOMPATIBILITY',
  'ENVIRONMENT_FAILURE',
  'EXPECTED_BEHAVIOR_CHANGE',
  'EXTERNAL_DEPENDENCY_BLOCKER',
  'UNKNOWN',
]);
export type FailureClassification = z.infer<typeof FailureClassification>;

export const ExecutionKind = z.enum([
  'BASELINE_BUILD',
  'BASELINE_TEST',
  'BUILD',
  'UNIT_TEST',
  'INTEGRATION_TEST',
  'CRYPTO_VERIFY',
  'IMAGE_BUILD',
  'DEPLOY',
  'E2E_TEST',
]);
export type ExecutionKind = z.infer<typeof ExecutionKind>;

export const ExecutionPhase = z.enum([
  'BUILD',
  'UNIT_TEST',
  'INTEGRATION_TEST',
  'CRYPTO_VERIFY',
  'DEPLOY',
  'E2E',
]);
export type ExecutionPhase = z.infer<typeof ExecutionPhase>;

export const ChangeType = z.enum([
  'SOURCE',
  'DEPENDENCY',
  'CONFIGURATION',
  'TEST',
  'MOCK',
  'FIXTURE',
  'BUILD_CONFIG',
  'REVERT',
]);
export type ChangeType = z.infer<typeof ChangeType>;

/** Change types that require a `testIntegrity` record (spec §26). */
export const TEST_ENGINEERING_CHANGE_TYPES = ['TEST', 'MOCK', 'FIXTURE'] as const;

// ---------------------------------------------------------------------------
// Human gates (Architecture §23; spec §20, §30, §31)
// ---------------------------------------------------------------------------

export const HumanGateType = z.enum([
  'MIGRATION_APPROVAL',
  'BUSINESS_BEHAVIOR_CHANGE',
  'BASELINE_CONTRACT_CHANGE',
  'EXTERNAL_PROTOCOL_CHANGE',
  'SECURITY_DEGRADATION',
  'MATERIAL_PERFORMANCE_TRADEOFF',
  'UNAUTHORIZED_SYSTEM_ACCESS',
  'HARDWARE_REPLACEMENT',
  'VENDOR_DECISION',
  'MATERIAL_ARCHITECTURE_DECISION',
  'RETRY_BUDGET_EXHAUSTED',
]);
export type HumanGateType = z.infer<typeof HumanGateType>;

// ---------------------------------------------------------------------------
// Events (spec §38, §41; Architecture §27)
// ---------------------------------------------------------------------------

export const EventType = z.enum([
  'PROJECT_CREATED',
  'PROJECT_UPDATED',
  'PROJECT_ARCHIVED',
  'PROJECT_DELETED',
  'REPOSITORY_CLONED',
  'SOURCE_ANALYSIS_STARTED',
  'FILE_ANALYZED',
  'DOCUMENT_ANALYZED',
  'DEPENDENCY_DISCOVERED',
  'CRYPTO_FINDING_DETECTED',
  'HARDWARE_DEPENDENCY_DISCOVERED',
  'MIGRATION_BLOCKER_IDENTIFIED',
  'RECOMMENDATION_RAISED',
  'CREDENTIAL_STORED',
  'CREDENTIAL_VERIFIED',
  'CREDENTIAL_INVALID',
  'CREDENTIAL_ROTATION_DUE',
  'GRAPH_NODE_ADDED',
  'GRAPH_NODE_UPDATED',
  'GRAPH_RELATIONSHIP_ADDED',
  'GRAPH_RELATIONSHIP_UPDATED',
  'DISCOVERY_FAILED',
  'ASSESSMENT_COMPLETED',
  'MIGRATION_APPROVED',
  'BRANCH_CREATED',
  'BASELINE_CAPTURE_STARTED',
  'BASELINE_CAPTURE_COMPLETED',
  'TEST_CREATED',
  'MOCK_CREATED',
  'PATCH_APPLIED',
  'BUILD_STARTED',
  'BUILD_PASSED',
  'BUILD_FAILED',
  'TEST_STARTED',
  'TEST_PASSED',
  'TEST_FAILED',
  'FAILURE_DIAGNOSED',
  'AUTONOMOUS_REPAIR_STARTED',
  'AUTONOMOUS_REPAIR_COMPLETED',
  'CRYPTO_VERIFICATION_STARTED',
  'CRYPTO_VERIFICATION_PASSED',
  'CRYPTO_VERIFICATION_FAILED',
  'SANDBOX_DEPLOYMENT_STARTED',
  'SANDBOX_DEPLOYMENT_READY',
  'E2E_TEST_PASSED',
  'E2E_TEST_FAILED',
  'MIGRATION_COMPLETED',
  'MIGRATION_FAILED',
  'HUMAN_GATE_REQUIRED',
  'HUMAN_GATE_RESOLVED',
  'STAGE_CHANGED',
]);
export type EventType = z.infer<typeof EventType>;

export const EventPhase = z.enum([
  'DISCOVERY',
  'ASSESSMENT',
  'MIGRATION',
  'VERIFICATION',
  'SANDBOX',
  'SYSTEM',
]);
export type EventPhase = z.infer<typeof EventPhase>;

/**
 * Spec §38 — the split between the Live Activity Stream and the Complete Audit
 * Trail is a data property, not a UI filter invented later. MILESTONE and
 * ACTIVITY render in the feed; DETAIL only in the audit drawer.
 */
export const EventLevel = z.enum(['MILESTONE', 'ACTIVITY', 'DETAIL']);
export type EventLevel = z.infer<typeof EventLevel>;

export const EventSeverity = z.enum(['INFO', 'WARN', 'ERROR', 'SUCCESS']);
export type EventSeverity = z.infer<typeof EventSeverity>;

export const EventActor = z.enum(['AGENT', 'TOOL', 'SYSTEM', 'USER']);
export type EventActor = z.infer<typeof EventActor>;

// ---------------------------------------------------------------------------
// Verification (spec §34, §35)
// ---------------------------------------------------------------------------

export const VerificationCheck = z.enum([
  'BASELINE_INVARIANTS_PRESERVED',
  'BUILD_SUCCESSFUL',
  'REQUIRED_TESTS_PASSED',
  'PROHIBITED_CRYPTO_ABSENT',
  'REQUIRED_PQC_PRESENT',
  'MIGRATION_POLICY_SATISFIED',
  'NO_CRITICAL_BLOCKER',
  'SANDBOX_DEPLOYMENT_SUCCESSFUL',
  'E2E_VERIFICATION_SUCCESSFUL',
]);
export type VerificationCheck = z.infer<typeof VerificationCheck>;

/**
 * Spec §35 — a migration is VERIFIED only when every one of these passes. The
 * verification service derives its verdict from this list in code; no model
 * output can shortcut it.
 */
export const REQUIRED_VERIFICATION_CHECKS: readonly VerificationCheck[] =
  VerificationCheck.options;

// ---------------------------------------------------------------------------
// Uploaded input classification (spec §5)
// ---------------------------------------------------------------------------

export const FileKind = z.enum([
  'HARDWARE_SPEC',
  'OT_SPEC',
  'IOT_SPEC',
  'HSM_SPEC',
  'FIRMWARE_DOC',
  'ARCHITECTURE_DOC',
  'SECURITY_ARCHITECTURE_DOC',
  'PROTOCOL_DOC',
  'CBOM',
  'SAST_FINDINGS',
  'VULN_REPORT',
  'PQC_READINESS_REPORT',
  'OTHER',
]);
export type FileKind = z.infer<typeof FileKind>;

export const ArtifactKind = z.enum([
  'ASSESSMENT_REPORT',
  'MIGRATION_REPORT',
  'GIT_DIFF',
  'BUILD_TEST_EVIDENCE',
]);
export type ArtifactKind = z.infer<typeof ArtifactKind>;

// ---------------------------------------------------------------------------
// Policy constants
// ---------------------------------------------------------------------------

/** Spec §31 — applies per unresolved problem, not per command. */
export const MAX_MEANINGFUL_AUTONOMOUS_ATTEMPTS = 4;
