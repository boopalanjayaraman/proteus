import {
  ACTIVITY_CATEGORY, NAVIGATION_WINDOW_SECONDS, navigationKey,
  type ActivityAction, type ActivityCategory, type ActivityOutcome,
  type Screen, type UserActivity,
} from '@proteus/schema';
import type { Repositories } from '../repositories';

/**
 * Recording and reading user activity (PRD-15).
 *
 * Two rules shape everything here.
 *
 *   NEVER FAILS THE ACTION.  A write that throws is swallowed. An audit log that
 *                            can break an approval is worse than a missing row,
 *                            and every caller is `void recorder.record(...)`.
 *   NEVER TRUSTS THE CLIENT. Every entry is written from a request the backend
 *                            authenticated. The only field the browser supplies
 *                            is `screen`, bounded to a closed enum, and entries
 *                            carrying it are marked DECLARED.
 */

export interface ActivityContext {
  userId: string;
  userEmail: string;
  requestId?: string;
  ip?: string;
  userAgent?: string;
  screen?: Screen;
}

export interface RecordInput {
  action: ActivityAction;
  summary: string;
  target?: string;
  projectId?: string;
  outcome?: ActivityOutcome;
  detail?: Record<string, string | number | boolean>;
}

export interface ActivityQuery {
  /** Whose activity. Resolved server-side; never taken from a query parameter. */
  userId?: string;
  category?: ActivityCategory;
  projectId?: string;
  outcome?: ActivityOutcome;
  from?: Date;
  to?: Date;
  q?: string;
  includeNavigation?: boolean;
  cursor?: string;
  limit?: number;
}

export interface ActivityPage {
  entries: UserActivity[];
  nextCursor?: string;
}

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

export interface ActivityOptions {
  /** Addresses that hold PLATFORM_ADMIN. Compared case-insensitively. */
  adminEmails?: string[];
  /** A `GET /me` after this much idle time starts a new session. */
  sessionGapMinutes?: number;
  navigationWindowSeconds?: number;
}

export class ActivityRecorder {
  private readonly adminEmails: Set<string>;
  private readonly sessionGapMs: number;
  private readonly navigationWindow: number;

  /**
   * Navigation keys already written, as a fast path.
   *
   * The unique index is what makes dedupe correct across instances; this only
   * saves the round-trip for the common case where a page's several calls land
   * on the same container. Bounded, because a per-user map in a long-lived
   * process is a leak.
   */
  private readonly seen = new Map<string, number>();
  private static readonly SEEN_MAX = 5_000;

  constructor(
    private readonly repos: Repositories,
    options: ActivityOptions = {},
  ) {
    this.adminEmails = new Set(
      (options.adminEmails ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean),
    );
    this.sessionGapMs = (options.sessionGapMinutes ?? 30) * 60_000;
    this.navigationWindow = options.navigationWindowSeconds ?? NAVIGATION_WINDOW_SECONDS;
  }

  /** Whether this address is seeded as a platform admin. */
  isAdminEmail(email: string | undefined): boolean {
    return Boolean(email) && this.adminEmails.has(email!.trim().toLowerCase());
  }

  get adminCount(): number {
    return this.adminEmails.size;
  }

  /**
   * Writes one entry. Never throws.
   *
   * The category comes from the action rather than the caller, so an action
   * cannot be filed under the wrong filter.
   */
  async record(ctx: ActivityContext, input: RecordInput): Promise<UserActivity | null> {
    try {
      const now = new Date();
      const doc: UserActivity = {
        _schemaVersion: 1,
        createdAt: now,
        updatedAt: now,
        activityId: `act_${now.getTime().toString(36)}_${rand()}`,
        userId: ctx.userId,
        userEmail: ctx.userEmail,
        category: ACTIVITY_CATEGORY[input.action],
        action: input.action,
        summary: input.summary.slice(0, 400),
        ...(input.target ? { target: input.target.slice(0, 200) } : {}),
        ...(input.projectId ? { projectId: input.projectId } : {}),
        ...(ctx.screen ? { screen: ctx.screen } : {}),
        outcome: input.outcome ?? 'SUCCESS',
        // The screen is a label on an observed action, not the observation
        // itself — only a page view is what the client said it was.
        provenance: input.action === 'PAGE_VIEWED' ? 'DECLARED' : 'OBSERVED',
        ...(input.detail ? { detail: input.detail } : {}),
        ...(ctx.requestId ? { requestId: ctx.requestId } : {}),
        ...(ctx.ip ? { ip: ctx.ip } : {}),
        ...(ctx.userAgent ? { userAgent: ctx.userAgent.slice(0, 300) } : {}),
        at: now,
      };
      // The base repository validates and redacts on the way in, so a token that
      // reached a summary or a detail never lands in the collection.
      return await this.repos.userActivity.insert(doc);
    } catch {
      // Deliberately silent. FR-5: recording never fails the action it records.
      return null;
    }
  }

  /**
   * Records a page visit, collapsing a screen load's fan-out into one entry.
   *
   * Returns whether an entry was written, which is what the tests assert on —
   * "seven calls produced one row" is only checkable if the collapse is visible.
   */
  async recordNavigation(
    ctx: ActivityContext & { screen: Screen },
    projectId?: string,
  ): Promise<boolean> {
    const at = new Date();
    const key = navigationKey({
      userId: ctx.userId, screen: ctx.screen, at,
      windowSeconds: this.navigationWindow,
      ...(projectId ? { projectId } : {}),
    });

    if (this.seen.has(key)) return false;
    this.remember(key, at.getTime());

    try {
      await this.repos.userActivity.insert({
        _schemaVersion: 1,
        createdAt: at,
        updatedAt: at,
        activityId: `act_${at.getTime().toString(36)}_${rand()}`,
        userId: ctx.userId,
        userEmail: ctx.userEmail,
        category: 'NAVIGATION',
        action: 'PAGE_VIEWED',
        summary: `Opened ${ctx.screen.toLowerCase().replace(/_/g, ' ')}`,
        target: ctx.screen,
        ...(projectId ? { projectId } : {}),
        screen: ctx.screen,
        outcome: 'SUCCESS',
        provenance: 'DECLARED',
        ...(ctx.requestId ? { requestId: ctx.requestId } : {}),
        ...(ctx.ip ? { ip: ctx.ip } : {}),
        ...(ctx.userAgent ? { userAgent: ctx.userAgent.slice(0, 300) } : {}),
        dedupeKey: key,
        at,
      } as UserActivity);
      return true;
    } catch {
      // Almost always the unique index doing its job on a second container.
      return false;
    }
  }

  /**
   * Reads a page, newest first.
   *
   * `userId` is whatever the route resolved — a caller's own uid, or an admin's
   * chosen filter. It is never read from the query string here, because a
   * scoping decision made in a service that also serves admins is a scoping
   * decision that eventually gets it wrong.
   */
  async query(q: ActivityQuery): Promise<ActivityPage> {
    const limit = Math.min(Math.max(q.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    const filter: Record<string, unknown> = {};

    if (q.userId) filter['userId'] = q.userId;
    if (q.category) filter['category'] = q.category;
    if (q.projectId) filter['projectId'] = q.projectId;
    if (q.outcome) filter['outcome'] = q.outcome;

    // Navigation is most of the volume and least of the value, so it is present
    // and hidden rather than absent — unless it is what you asked for.
    if (!q.includeNavigation && q.category !== 'NAVIGATION') {
      filter['category'] = q.category ?? { $ne: 'NAVIGATION' };
    }

    if (q.from || q.to) {
      filter['at'] = {
        ...(q.from ? { $gte: q.from } : {}),
        ...(q.to ? { $lte: q.to } : {}),
      };
    }

    if (q.q?.trim()) {
      const rx = { $regex: escapeRegex(q.q.trim()), $options: 'i' };
      filter['$or'] = [{ summary: rx }, { target: rx }, { projectId: rx }];
    }

    // Keyset paging on (at, activityId).
    //
    // Offset paging would be simpler and wrong: this collection grows while it
    // is being read, so `skip` past a page whose contents shifted repeats rows
    // and drops others. The tiebreak matters too — entries written in the same
    // millisecond are common, and `at` alone is not a total order.
    const after = decodeCursor(q.cursor);
    if (after) {
      const keyset = [
        { at: { $lt: after.at } },
        { at: after.at, activityId: { $lt: after.activityId } },
      ];
      filter['$and'] = [...((filter['$and'] as unknown[]) ?? []), { $or: keyset }];
    }

    const rows = (await this.repos.userActivity.collection
      .find(filter as never)
      .sort({ at: -1, activityId: -1 })
      // One extra, to know whether there is a next page without a second query.
      .limit(limit + 1)
      .toArray()) as unknown as UserActivity[];

    const entries = rows.slice(0, limit);
    const last = entries.at(-1);
    return {
      entries,
      ...(rows.length > limit && last
        ? { nextCursor: encodeCursor({ at: last.at, activityId: last.activityId }) }
        : {}),
    };
  }

  /** Distinct users with activity, for the admin view's filter. */
  async users(): Promise<Array<{ userId: string; userEmail: string; lastAt: Date }>> {
    const rows = await this.repos.userActivity.collection
      .aggregate([
        { $sort: { at: -1 } },
        {
          $group: {
            _id: '$userId',
            userEmail: { $first: '$userEmail' },
            lastAt: { $first: '$at' },
          },
        },
        { $sort: { lastAt: -1 } },
        { $limit: 500 },
      ])
      .toArray();
    return rows.map((r) => ({
      userId: String(r['_id']),
      userEmail: String(r['userEmail'] ?? ''),
      lastAt: r['lastAt'] as Date,
    }));
  }

  /**
   * Whether this `GET /me` begins a new session.
   *
   * Not a login, and deliberately not named one: it is an observation about how
   * long it has been since this user's last request. Calling it a login would
   * assert something the backend cannot see, because Firebase Auth signs people
   * in without ever telling this process.
   */
  startsSession(lastSeenAt: Date | undefined, now = new Date()): boolean {
    if (!lastSeenAt) return false;
    return now.getTime() - new Date(lastSeenAt).getTime() >= this.sessionGapMs;
  }

  /**
   * Drops the fast-path cache.
   *
   * Exists for tests, which reset the database between cases and would otherwise
   * see a page view suppressed by a key written by the previous test — the cache
   * is keyed by a wall-clock bucket, and two tests run inside one. Safe in
   * production too: forgetting only costs a duplicate-key round trip, because
   * the unique index is what actually enforces the collapse.
   */
  forgetNavigationCache(): void {
    this.seen.clear();
  }

  private remember(key: string, at: number): void {
    if (this.seen.size >= ActivityRecorder.SEEN_MAX) {
      // Cheap eviction: drop the oldest tenth rather than tracking an LRU for a
      // cache whose only job is saving a round-trip.
      const drop = [...this.seen.entries()]
        .sort((a, b) => a[1] - b[1])
        .slice(0, Math.floor(ActivityRecorder.SEEN_MAX / 10));
      for (const [k] of drop) this.seen.delete(k);
    }
    this.seen.set(key, at);
  }
}

const rand = () => Math.random().toString(36).slice(2, 10);

/** Escaped so a search for `a.b` matches that, not any character between a and b. */
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(0, 120);

export function encodeCursor(c: { at: Date; activityId: string }): string {
  return Buffer.from(`${c.at.toISOString()}|${c.activityId}`, 'utf8').toString('base64url');
}

export function decodeCursor(
  cursor: string | undefined,
): { at: Date; activityId: string } | null {
  if (!cursor) return null;
  try {
    const [iso, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    const at = new Date(iso ?? '');
    // A malformed cursor returns the first page rather than an error: it is a
    // client bug or a truncated URL, and neither is worth a 400 the user sees.
    return id && !Number.isNaN(at.getTime()) ? { at, activityId: id } : null;
  } catch {
    return null;
  }
}
