import { z } from 'zod';
import { FirebaseUid, Id, ProjectId, Timestamp, baseDocFields } from './common';

/**
 * User activity — who did what, and when.
 *
 * Distinct from `events`, which records what the *agent* did to a project and is
 * streamed to the live screens. This records what a *person* did to the product.
 * The event log says a migration was approved; this says who approved it, and it
 * is the only collection in the model whose access boundary is a user rather
 * than a project (PRD-15).
 *
 * Append-only. Nothing here is ever updated, and the repository exposes no path
 * that could.
 */

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------

/**
 * The six screens the router declares, and nothing else.
 *
 * A closed enum rather than a path: the screen is the one field the browser
 * asserts, so the worst available lie is which of six screens someone was on. A
 * path would also carry project ids into a field that gets regex-searched.
 */
export const Screen = z.enum([
  'PROJECTS', 'PROJECT_CREATE', 'DISCOVERY', 'ASSESSMENT', 'MIGRATION', 'SANDBOX', 'ACTIVITY',
]);
export type Screen = z.infer<typeof Screen>;

export const SCREEN_LABEL: Record<Screen, string> = {
  PROJECTS: 'Projects',
  PROJECT_CREATE: 'Create project',
  DISCOVERY: 'Live discovery',
  ASSESSMENT: 'Assessment',
  MIGRATION: 'Live migration',
  SANDBOX: 'Sandbox & report',
  ACTIVITY: 'Activity',
};

// ---------------------------------------------------------------------------
// What gets recorded
// ---------------------------------------------------------------------------

export const ActivityCategory = z.enum([
  'AUTH', 'PROJECT', 'CREDENTIAL', 'ANALYSIS', 'MIGRATION',
  'SANDBOX', 'ARTIFACT', 'ACCESS', 'ADMIN', 'NAVIGATION',
]);
export type ActivityCategory = z.infer<typeof ActivityCategory>;

export const ActivityAction = z.enum([
  // AUTH — what the backend can actually see. Sign-in and sign-out are not here:
  // Firebase Auth is client-side and the backend observes neither (PRD-15 §10).
  'ACCOUNT_CREATED', 'SESSION_STARTED',

  'PROJECT_CREATED', 'PROJECT_UPDATED', 'PROJECT_DELETED', 'FILES_UPLOADED',

  'TOKEN_STORED', 'TOKEN_REPLACED', 'ROTATION_REMINDER_SEEN',

  'DISCOVERY_STARTED', 'ASSESSMENT_GENERATED', 'ASSESSMENT_REGENERATED',

  'MIGRATION_APPROVED', 'MIGRATION_DECLINED', 'MIGRATION_RERUN', 'GATE_RESOLVED',

  'SANDBOX_OPENED', 'SANDBOX_EXTENDED', 'SANDBOX_TORN_DOWN',

  'REPORT_DOWNLOADED', 'DIFF_DOWNLOADED', 'EVIDENCE_DOWNLOADED',

  'ACCESS_DENIED', 'CAPACITY_REACHED',

  'ACTIVITY_VIEWED', 'ROLE_APPLIED', 'ROLE_REVOKED',

  'PAGE_VIEWED',
]);
export type ActivityAction = z.infer<typeof ActivityAction>;

/**
 * Every action's category, decided once.
 *
 * A recorder that took both would eventually file a download under NAVIGATION
 * and quietly break the category filter, so it takes only the action.
 */
export const ACTIVITY_CATEGORY: Record<ActivityAction, ActivityCategory> = {
  ACCOUNT_CREATED: 'AUTH',
  SESSION_STARTED: 'AUTH',

  PROJECT_CREATED: 'PROJECT',
  PROJECT_UPDATED: 'PROJECT',
  PROJECT_DELETED: 'PROJECT',
  FILES_UPLOADED: 'PROJECT',

  TOKEN_STORED: 'CREDENTIAL',
  TOKEN_REPLACED: 'CREDENTIAL',
  ROTATION_REMINDER_SEEN: 'CREDENTIAL',

  DISCOVERY_STARTED: 'ANALYSIS',
  ASSESSMENT_GENERATED: 'ANALYSIS',
  ASSESSMENT_REGENERATED: 'ANALYSIS',

  MIGRATION_APPROVED: 'MIGRATION',
  MIGRATION_DECLINED: 'MIGRATION',
  MIGRATION_RERUN: 'MIGRATION',
  GATE_RESOLVED: 'MIGRATION',

  SANDBOX_OPENED: 'SANDBOX',
  SANDBOX_EXTENDED: 'SANDBOX',
  SANDBOX_TORN_DOWN: 'SANDBOX',

  REPORT_DOWNLOADED: 'ARTIFACT',
  DIFF_DOWNLOADED: 'ARTIFACT',
  EVIDENCE_DOWNLOADED: 'ARTIFACT',

  ACCESS_DENIED: 'ACCESS',
  CAPACITY_REACHED: 'ACCESS',

  ACTIVITY_VIEWED: 'ADMIN',
  ROLE_APPLIED: 'ADMIN',
  ROLE_REVOKED: 'ADMIN',

  PAGE_VIEWED: 'NAVIGATION',
};

export const ActivityOutcome = z.enum(['SUCCESS', 'DENIED', 'FAILED']);
export type ActivityOutcome = z.infer<typeof ActivityOutcome>;

/**
 * OBSERVED — the backend derived every field from the request it served.
 * DECLARED — the `screen` came from a request header; the rest is observed.
 *
 * Deliberately parallel to the evidence model's OBSERVED/INFERRED: the same
 * question ("did a tool see this, or did something assert it?") with the same
 * answer, so a reader who understands one understands the other.
 */
export const ActivityProvenance = z.enum(['OBSERVED', 'DECLARED']);
export type ActivityProvenance = z.infer<typeof ActivityProvenance>;

export const UserActivity = z.object({
  ...baseDocFields,
  activityId: Id,
  userId: FirebaseUid,
  /** Denormalised so the admin list names people without joining every row. */
  userEmail: z.string(),

  category: ActivityCategory,
  action: ActivityAction,
  /** What a person reads. Written by the recorder, never by the browser. */
  summary: z.string().min(1).max(400),
  /** What it happened to: a project id, an artifact title, a screen. */
  target: z.string().max(200).optional(),
  projectId: ProjectId.optional(),
  screen: Screen.optional(),

  outcome: ActivityOutcome.default('SUCCESS'),
  provenance: ActivityProvenance,

  /** Small and bounded. Never anything token-shaped — the repository redacts. */
  detail: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),

  requestId: z.string().max(120).optional(),
  ip: z.string().max(60).optional(),
  userAgent: z.string().max(300).optional(),

  /**
   * Collapses a burst of calls into one navigation entry. Present on
   * NAVIGATION only, and unique — see `navigationKey`.
   */
  dedupeKey: z.string().max(300).optional(),

  at: Timestamp,
});
export type UserActivity = z.infer<typeof UserActivity>;

// ---------------------------------------------------------------------------
// Navigation dedupe
// ---------------------------------------------------------------------------

export const NAVIGATION_WINDOW_SECONDS = 30;

/**
 * One navigation entry per user, screen and project per window.
 *
 * A screen load fans out into several API calls — the sandbox screen makes seven
 * — and each carries the same screen header. Deduping on a key with a unique
 * index rather than in memory is what makes that correct across instances: two
 * calls from one page load can land on two Cloud Run containers, and an
 * in-memory guard would let both through.
 *
 * The window is tumbling rather than sliding, which is the price of doing it
 * without a read: two visits either side of a boundary both record. That is the
 * right way to be wrong — a duplicate row is visible and harmless, where a
 * sliding window implemented with a read-then-write would be a race.
 */
export function navigationKey(input: {
  userId: string;
  screen: Screen;
  projectId?: string;
  at: Date;
  windowSeconds?: number;
}): string {
  const window = input.windowSeconds ?? NAVIGATION_WINDOW_SECONDS;
  const bucket = Math.floor(input.at.getTime() / 1000 / window);
  return `${input.userId}|${input.screen}|${input.projectId ?? '-'}|${bucket}`;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * `2026-08-29T14:32:11Z`
 *
 * ISO 8601 in UTC, which is what "ANSI format" resolves to here and what the
 * rest of the model stores. An audit log read across timezones has to be
 * unambiguous, and a local rendering of the same instant differs per reader.
 */
export function isoUtc(at: Date | string): string {
  const d = at instanceof Date ? at : new Date(at);
  return Number.isNaN(d.getTime()) ? '' : `${d.toISOString().slice(0, 19)}Z`;
}
