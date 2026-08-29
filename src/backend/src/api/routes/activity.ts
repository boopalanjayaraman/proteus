import { ActivityCategory, ActivityOutcome, isoUtc } from '@proteus/schema';
import type { FastifyInstance } from 'fastify';
import type { ActivityQuery, ActivityRecorder } from '../../core/services/activity';
import { MAX_PAGE_SIZE } from '../../core/services/activity';
import type { Repositories } from '../../core/repositories';
import { currentUser } from '../middleware/auth';
import { activityContext } from '../middleware/activity';

/**
 * The activity log.
 *
 * Scope is decided here and nowhere else: a user sees their own, a platform
 * admin sees everyone's. The one thing this must never do is take the scope
 * from a query parameter, so `userId` is read, checked against the caller's
 * role, and then either honoured or ignored.
 */

interface Query {
  category?: string;
  projectId?: string;
  outcome?: string;
  userId?: string;
  from?: string;
  to?: string;
  q?: string;
  cursor?: string;
  limit?: string;
  includeNavigation?: string;
}

const asDate = (v: string | undefined): Date | undefined => {
  if (!v) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
};

export function registerActivityRoutes(
  app: FastifyInstance,
  repos: Repositories,
  recorder: ActivityRecorder,
): void {
  /**
   * A page of activity, newest first.
   *
   * Cursor-paged rather than offset-paged: the log grows while it is read, so
   * `skip` would repeat and drop rows on every page after the first.
   */
  app.get<{ Querystring: Query }>('/activity', async (req) => {
    const user = currentUser(req);
    const me = await repos.users.findOne({ userId: user.uid } as never);
    const isAdmin = me?.role === 'PLATFORM_ADMIN';

    // A non-admin asking for someone else gets their own, not a 403.
    //
    // There is nothing to refuse: they were never going to see another user's
    // rows, and a 403 would tell them the filter is meaningful — which is how
    // an authenticated user learns that other users exist and starts guessing
    // ids. Ignoring the parameter says nothing at all.
    const requested = req.query.userId?.trim();
    const scopedTo = isAdmin ? (requested || undefined) : user.uid;

    const category = ActivityCategory.safeParse(req.query.category);
    const outcome = ActivityOutcome.safeParse(req.query.outcome);
    const limit = Number(req.query.limit);

    const query: ActivityQuery = {
      ...(scopedTo ? { userId: scopedTo } : {}),
      ...(category.success ? { category: category.data } : {}),
      ...(outcome.success ? { outcome: outcome.data } : {}),
      ...(req.query.projectId ? { projectId: req.query.projectId } : {}),
      ...(asDate(req.query.from) ? { from: asDate(req.query.from)! } : {}),
      ...(asDate(req.query.to) ? { to: asDate(req.query.to)! } : {}),
      ...(req.query.q ? { q: req.query.q } : {}),
      ...(req.query.cursor ? { cursor: req.query.cursor } : {}),
      ...(Number.isFinite(limit) && limit > 0 ? { limit: Math.min(limit, MAX_PAGE_SIZE) } : {}),
      includeNavigation: req.query.includeNavigation === 'true',
    };

    const page = await recorder.query(query);

    // FR-12. Reading your own log is not an event; reading someone else's is.
    if (isAdmin && scopedTo && scopedTo !== user.uid) {
      const ctx = activityContext(req);
      if (ctx) {
        void recorder.record(ctx, {
          action: 'ACTIVITY_VIEWED',
          summary: `Viewed the activity log of ${scopedTo}`,
          target: scopedTo,
        });
      }
    }

    return {
      scope: isAdmin && !scopedTo ? 'ALL' : scopedTo === user.uid ? 'SELF' : 'USER',
      isAdmin,
      count: page.entries.length,
      // Rendered here as well as stored, so a client that formats dates
      // differently cannot make two readers disagree about when something
      // happened. ISO 8601, UTC (PRD-15 FR-14).
      entries: page.entries.map((e) => ({ ...e, atUtc: isoUtc(e.at) })),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  });

  /** Who has activity, for the admin view's user filter. Admin only. */
  app.get('/activity/users', async (req) => {
    const user = currentUser(req);
    const me = await repos.users.findOne({ userId: user.uid } as never);
    if (me?.role !== 'PLATFORM_ADMIN') {
      // Not a 403: a non-admin has exactly one user to filter by, themselves.
      return { users: [{ userId: user.uid, userEmail: me?.email ?? '', lastAt: null }] };
    }
    return { users: await recorder.users() };
  });
}
