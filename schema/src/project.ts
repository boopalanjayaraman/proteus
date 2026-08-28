import { z } from 'zod';
import {
  CommitSha,
  FirebaseUid,
  GcsUri,
  Id,
  Percent,
  ProjectId,
  Timestamp,
  baseDocFields,
} from './common';
import { DiscoveryStage, FileKind, MigrationStage, ProjectStage } from './enums';

/**
 * Identity, the resumable project state root, and uploaded context.
 */

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

/**
 * Firebase Auth answers *who* the user is on every request; this is the local
 * mirror of what the header renders, plus anything they set. Preferences live
 * server-side rather than in localStorage because graph style and discovery
 * layout change what the user sees on the demo's centrepiece screen and should
 * survive a device change.
 */
export const User = z.object({
  ...baseDocFields,
  userId: FirebaseUid,
  email: z.string().email(),
  displayName: z.string().min(1),
  photoUrl: z.string().url().optional(),
  initials: z.string().min(1).max(3),

  preferences: z.object({
    theme: z.enum(['dark', 'light']).default('dark'),
    graphStyle: z.enum(['force', 'radial', 'blueprint']).default('force'),
    discoveryLayout: z.enum(['graph', 'split']).default('graph'),
  }),

  lastSeenAt: Timestamp,
});
export type User = z.infer<typeof User>;

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

/**
 * Detected at clone, before discovery finishes. Renders as the
 * "PUBLIC · JAVA 17 · MAVEN" chip and feeds the discovery feed's opening lines.
 */
export const RepositoryProfile = z.object({
  language: z.string(),
  languageVersion: z.string().optional(),
  buildSystem: z.string().optional(),
  framework: z.string().optional(),
  testFrameworks: z.array(z.string()).default([]),
  fileCount: z.number().int().nonnegative().optional(),
  detectedAt: Timestamp,
});
export type RepositoryProfile = z.infer<typeof RepositoryProfile>;

export const ProjectRepository = z.object({
  url: z.string().url(),
  provider: z.literal('GITHUB'),
  defaultBranch: z.string().default('main'),
  /** Resolved at clone. The anchor for every baseline and every code permalink. */
  baseCommitSha: CommitSha.optional(),
  visibility: z.enum(['PUBLIC', 'PREAUTHORIZED']),
  /** ".../blob/{sha}/{path}#L{line}" — how evidence becomes a clickable link. */
  webUrlTemplate: z.string().optional(),
  profile: RepositoryProfile.optional(),
});
export type ProjectRepository = z.infer<typeof ProjectRepository>;

/**
 * Spec §53's North-Star metric. The UX renders it in the persistent header on
 * every screen and again as an outcome tile, so it is denormalized rather than
 * recomputed per view. `humanEngineeringActions` deliberately excludes the one
 * approval — that is counted separately, because the whole claim is "one
 * approval, zero engineering interventions".
 */
export const AutonomyMetrics = z.object({
  eligibleItems: z.number().int().nonnegative().default(0),
  completedAutonomously: z.number().int().nonnegative().default(0),
  /** null before migration starts — the header renders "—". */
  completionPct: Percent.nullable().default(null),
  humanEngineeringActions: z.number().int().nonnegative().default(0),
  approvals: z.number().int().nonnegative().default(0),
});
export type AutonomyMetrics = z.infer<typeof AutonomyMetrics>;

/**
 * Denormalized landing-tile projection so the projects list is a single query and
 * a returning user sees the true state before any stream connects.
 */
export const ProjectSummary = z.object({
  lastActivityAt: Timestamp,
  lastActivityText: z.string(),
  discoveryComplete: z.boolean().default(false),
  assessmentComplete: z.boolean().default(false),
  migrationApproved: z.boolean().default(false),
  migrationComplete: z.boolean().default(false),
  verificationComplete: z.boolean().default(false),
  sandboxDeployed: z.boolean().default(false),
  counts: z.object({
    findings: z.number().int().nonnegative().default(0),
    recommendations: z.number().int().nonnegative().default(0),
    graphNodes: z.number().int().nonnegative().default(0),
    graphEdges: z.number().int().nonnegative().default(0),
    openGates: z.number().int().nonnegative().default(0),
    migrationChanges: z.number().int().nonnegative().default(0),
  }),
  autonomy: AutonomyMetrics,
  latestArtifactId: Id.optional(),
  sandboxUrl: z.string().url().optional(),
});
export type ProjectSummary = z.infer<typeof ProjectSummary>;

export const Project = z.object({
  ...baseDocFields,
  projectId: ProjectId,
  ownerId: FirebaseUid,
  name: z.string().min(1).max(200),

  repository: ProjectRepository,
  instructions: z.string().max(20_000).optional(),

  stage: ProjectStage,
  stageDetail: z.union([DiscoveryStage, MigrationStage]).optional(),
  stageEnteredAt: Timestamp,
  /** Derived from open blocking gates — drives the "action required" tile badge. */
  actionRequired: z.boolean().default(false),
  failureReason: z.string().optional(),

  summary: ProjectSummary,

  /** Heads of each phase, so any screen rehydrates without scanning collections. */
  current: z.object({
    discoveryRunId: Id.optional(),
    assessmentId: Id.optional(),
    approvedAssessmentId: Id.optional(),
    migrationRunId: Id.optional(),
    baselineId: Id.optional(),
    verificationResultId: Id.optional(),
    sandboxDeploymentId: Id.optional(),
  }),

  /** SSE resume cursor. The client reads state, then tails from here. */
  lastEventSeq: z.number().int().nonnegative().default(0),
  /** Bumped on any graph write; lets a client detect divergence and refetch. */
  graphVersion: z.number().int().nonnegative().default(0),

  /** Optimistic concurrency — stage transitions are guarded, never blind writes. */
  version: z.number().int().nonnegative().default(0),
});
export type Project = z.infer<typeof Project>;

export const CreateProjectInput = z.object({
  name: z.string().min(1).max(200),
  repositoryUrl: z.string().url(),
  defaultBranch: z.string().optional(),
  instructions: z.string().max(20_000).optional(),
});
export type CreateProjectInput = z.infer<typeof CreateProjectInput>;

// ---------------------------------------------------------------------------
// Uploaded context (spec §5)
// ---------------------------------------------------------------------------

export const ProjectFile = z.object({
  ...baseDocFields,
  fileId: Id,
  projectId: ProjectId,

  kind: FileKind,
  originalName: z.string().min(1),
  mimeType: z.string(),
  /** Rendered as the "4.2 MB" meta line beside the filename. */
  sizeBytes: z.number().int().nonnegative(),
  gcsUri: GcsUri,
  sha256: z.string().length(64),

  extraction: z.object({
    status: z.enum(['PENDING', 'EXTRACTED', 'PARTIAL', 'FAILED']),
    /** Extracted text lives in GCS. Mongo keeps the map, not the megabytes. */
    textGcsUri: GcsUri.optional(),
    pageCount: z.number().int().positive().optional(),
    /**
     * Page and section offsets, so a finding can cite "page 17" or "§8.4" — both
     * citation forms appear in the UX — and the viewer can jump straight there.
     */
    sections: z
      .array(
        z.object({
          page: z.number().int().positive().optional(),
          heading: z.string().optional(),
          charStart: z.number().int().nonnegative(),
          charEnd: z.number().int().nonnegative(),
        }),
      )
      .default([]),
    error: z.string().optional(),
  }),

  uploadedBy: FirebaseUid,
});
export type ProjectFile = z.infer<typeof ProjectFile>;
