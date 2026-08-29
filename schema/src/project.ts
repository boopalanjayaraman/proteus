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

/**
 * Where the repository access token lives — NOT the token.
 *
 * The PAT collected at project creation (UX v1.2) goes straight to Secret Manager.
 * This document holds a reference and enough of a fingerprint to recognise it in the
 * UI. No field here can be used to authenticate, which is the point: a database dump,
 * a log line and an API response are all harmless.
 */
export const RepositoryCredential = z.object({
  /** proteus-{projectId}-github-pat */
  secretName: z.string().min(1),
  /**
   * Pinned, never "latest". A migration that begins under one token and finishes
   * under another cannot be audited — the evidence package could not say which
   * credential wrote the branch. Rotation adds a version; in-flight runs keep theirs.
   */
  secretVersion: z.string().min(1),
  /** First 12 characters, for "github_pat_11ABCD•••". Recognisable, not usable. */
  displayPrefix: z.string().max(12),
  /**
   * What the user was asked to grant (UX v1.2). Recorded, not trusted — only GitHub
   * can say what a token actually permits.
   */
  declaredScopes: z.array(z.string()).default([]),
  status: z.enum(['STORED', 'MISSING', 'INVALID', 'REVOKED']).default('STORED'),
  storedAt: Timestamp,
  lastVerifiedAt: Timestamp.optional(),
  /** storedAt + 90 days. Surfaces a reminder; does not expire the project. */
  rotationDueAt: Timestamp,
});
export type RepositoryCredential = z.infer<typeof RepositoryCredential>;

/** The scopes the create-project screen asks for (UX v1.2). */
export const REQUIRED_GITHUB_SCOPES = [
  'contents: read & write',
  'pull_requests: write',
  'metadata: read',
] as const;

export const CREDENTIAL_ROTATION_DAYS = 90;

/** Matches a GitHub token in any of its formats. Used to redact before writing. */
export const GITHUB_TOKEN_PATTERN =
  /\b(gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})\b/g;

/**
 * True only for `{}` literals — not Date, Buffer, ObjectId, or any class instance.
 *
 * The distinction is load-bearing. `Object.entries(new Date())` returns `[]`,
 * because a Date carries no enumerable own properties, so rebuilding one that
 * way silently yields `{}` and destroys the value. Since redaction runs on every
 * write, treating a Date as a plain object corrupts every timestamp in the
 * database — and nothing throws.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * Redacts anything token-shaped. Applied to every event message, agent action
 * payload and report body before persistence — design rule 8 is enforced at the
 * write boundary, not left to authors of log statements.
 *
 * Values that are not strings, arrays or plain objects pass through untouched.
 */
export function redactTokens<T>(value: T): T {
  if (typeof value === 'string') {
    return value.replace(GITHUB_TOKEN_PATTERN, '[REDACTED]') as unknown as T;
  }
  if (Array.isArray(value)) return value.map(redactTokens) as unknown as T;
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, redactTokens(v)]),
    ) as T;
  }
  return value;
}

export const ProjectRepository = z.object({
  url: z.string().url(),
  provider: z.literal('GITHUB'),
  defaultBranch: z.string().default('main'),
  /** Resolved at clone. The anchor for every baseline and every code permalink. */
  baseCommitSha: CommitSha.optional(),
  visibility: z.enum(['PUBLIC', 'PREAUTHORIZED']),
  /** ".../blob/{sha}/{path}#L{line}" — how evidence becomes a clickable link. */
  webUrlTemplate: z.string().optional(),
  credential: RepositoryCredential.optional(),
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

/**
 * The only place a token appears in this model, and it is write-only: accepted once
 * in the request body, forwarded to Secret Manager, and dropped. It is never assigned
 * to a Project, never returned by any endpoint, and never logged.
 */
export const CreateProjectInput = z.object({
  name: z.string().min(1).max(200),
  repositoryUrl: z.string().url(),
  defaultBranch: z.string().optional(),
  /** GitHub fine-grained PAT. See REQUIRED_GITHUB_SCOPES. */
  githubToken: z
    .string()
    .min(20)
    .refine((t) => /^(gh[pousr]_|github_pat_)/.test(t), {
      message: 'expected a GitHub token (ghp_… or github_pat_…)',
    }),
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
