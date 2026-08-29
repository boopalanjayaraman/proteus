import { z } from 'zod';
import { CommitSha, GcsUri, Id, ProjectId, Timestamp, baseDocFields } from './common';
import { ArtifactKind, ChangeType, CryptoUsage, PlanItemMode, RecommendationDisposition, } from './enums';
/**
 * The assessment is immutable and versioned (spec §13, §17, §19).
 *
 * Regenerating produces version N+1 rather than mutating in place, so the
 * migration is always auditable against exactly the scope the human approved and
 * the downloaded report never drifts from what was on screen.
 */
export const PlanItem = z.object({
    planItemId: Id,
    targetName: z.string().min(1), // "CryptoService", "Partner simulator"
    targetNodeIds: z.array(z.string()).default([]),
    findingIds: z.array(Id).default([]),
    /** What the agent will DO — a separate vocabulary from a finding's disposition. */
    mode: PlanItemMode,
    /** The one-line "what" on the plan card. */
    action: z.string().min(1),
    rationale: z.string(),
    /**
     * The autonomy contract: what the agent claims it will touch. Verification
     * compares actual `migration_changes` against this, which is how "the user
     * approves this scope, not a generic start button" becomes checkable.
     */
    expectedChanges: z
        .array(z.object({
        changeType: ChangeType,
        paths: z.array(z.string()).default([]),
        description: z.string(),
    }))
        .default([]),
    /** "Updated only if failure classification proves the mock is obsolete." */
    conditions: z.array(z.string()).default([]),
    risk: z.enum(['LOW', 'MEDIUM', 'HIGH']),
    order: z.number().int().nonnegative(),
    approved: z.boolean().optional(),
});
export const Assessment = z.object({
    ...baseDocFields,
    assessmentId: Id,
    projectId: ProjectId,
    version: z.number().int().positive(),
    /** The four questions Screen 3 must answer (spec §14). */
    summary: z.object({
        headline: z.string(),
        whatExists: z.string(),
        whatIsVulnerable: z.string(),
        whatAgentWillChange: z.string(),
        whatAgentWillNotChange: z.string(),
    }),
    /** Frozen membership — the report renders identically forever. */
    snapshot: z.object({
        findingIds: z.array(Id),
        recommendationIds: z.array(Id),
        graphNodeIds: z.array(z.string()),
        graphEdgeIds: z.array(z.string()),
        inputFileIds: z.array(Id),
        repoCommitSha: CommitSha,
    }),
    planItems: z.array(PlanItem),
    policyId: Id,
    /** The downloadable assessment report. */
    artifactId: Id.optional(),
    status: z.enum(['DRAFT', 'READY', 'APPROVED', 'SUPERSEDED']),
    generatedAt: Timestamp,
});
/** Body of `POST /projects/{id}/migration/approve`. */
export const ApproveMigrationInput = z.object({
    assessmentId: Id,
    assessmentVersion: z.number().int().positive(),
    /** Omit to approve every autonomous plan item; present for partial scope. */
    approvedPlanItemIds: z.array(Id).optional(),
    acknowledgedActions: z.array(z.string()),
});
// ---------------------------------------------------------------------------
// Recommendations (UX v1.1)
// ---------------------------------------------------------------------------
/**
 * What the agent will not do, and who should.
 *
 * Replaces two half-overlapping lists in the earlier design — "excluded from
 * scope" on the assessment and "unresolved external items" on the final report.
 * They were the same thing seen twice, and neither said who was supposed to act.
 * A recommendation is raised during assessment, survives approval untouched, and
 * reappears in the migration report carried forward.
 *
 * A collection rather than an embedded array precisely because it outlives the
 * assessment that raised it: the same items render on four surfaces across two
 * phases, and embedding would mean copying them into each.
 */
export const Recommendation = z.object({
    ...baseDocFields,
    recommendationId: Id,
    projectId: ProjectId,
    name: z.string().min(1), // "Gateway-X200 · firmware 4.2.1"
    disposition: RecommendationDisposition,
    /** The recommended action, in prose. An item with no action is a complaint. */
    action: z.string().min(1),
    /**
     * Who should act. A team or role, not a person: the prototype has no directory,
     * and assigning to an individual would imply one exists.
     */
    owner: z.string().min(1), // "OT engineering · procurement"
    findingIds: z.array(Id).default([]),
    nodeIds: z.array(z.string()).default([]),
    evidenceIds: z.array(Id).default([]),
    sourceCitation: z.string(), // "Gateway-X200 Technical Specification §8.4"
    status: z.enum(['OPEN', 'ACKNOWLEDGED', 'CLOSED']).default('OPEN'),
    raisedAt: Timestamp,
});
// ---------------------------------------------------------------------------
// Migration policy — what "migrated" means, as data
// ---------------------------------------------------------------------------
/**
 * Deterministic verification needs a machine-readable definition of success.
 * Keeping this in a collection rather than a prompt is what lets
 * PROHIBITED_CRYPTO_ABSENT be a grep with a rule id attached — re-runnable,
 * diffable, citable — instead of a model opinion.
 */
export const MigrationPolicyRule = z.object({
    ruleId: Id,
    when: z.object({
        /** Regex over the detected algorithm, e.g. "^RSA-\\d+$". */
        algorithmPattern: z.string(),
        usage: CryptoUsage,
    }),
    target: z.string(),
    /** Regexes verification requires to be ABSENT from the migrated source. */
    prohibitedPatterns: z.array(z.string()).default([]),
    /** Regexes verification requires to be PRESENT. */
    requiredPatterns: z.array(z.string()).default([]),
    rationale: z.string(),
});
export const MigrationPolicy = z.object({
    ...baseDocFields,
    policyId: Id,
    name: z.string(),
    description: z.string().optional(),
    rules: z.array(MigrationPolicyRule),
});
// ---------------------------------------------------------------------------
// Artifacts — the downloadable evidence package
// ---------------------------------------------------------------------------
/**
 * Widened from a reports-only collection. The completion screen offers four
 * downloads and only two are reports; a git diff and a build-evidence bundle sit
 * alongside them with the same affordance, so they are the same kind of thing to
 * the user and should be the same kind of thing to the model.
 */
export const Artifact = z.object({
    ...baseDocFields,
    artifactId: Id,
    projectId: ProjectId,
    kind: ArtifactKind,
    format: z.enum(['PDF', 'MARKDOWN', 'JSON', 'DIFF']),
    title: z.string().min(1), // "Migration report"
    /** The card's meta line: "34 PAGES · FULL AUDIT TRAIL", "6 COMMITS · 4 FILES · +212 −68". */
    displayMeta: z.string(),
    /** The same facts structurally, for anything that reasons rather than prints. */
    stats: z
        .object({
        pages: z.number().int().nonnegative().optional(),
        commits: z.number().int().nonnegative().optional(),
        filesChanged: z.number().int().nonnegative().optional(),
        linesAdded: z.number().int().nonnegative().optional(),
        linesRemoved: z.number().int().nonnegative().optional(),
        buildAttempts: z.number().int().nonnegative().optional(),
    })
        .optional(),
    assessmentId: Id.optional(),
    migrationRunId: Id.optional(),
    gcsUri: GcsUri,
    sizeBytes: z.number().int().nonnegative().default(0),
    /** The structured source the renderer consumed — reproducible output. */
    contentSnapshot: z.record(z.string(), z.unknown()).optional(),
    status: z.enum(['GENERATING', 'READY', 'FAILED']),
    generatedAt: Timestamp,
});
