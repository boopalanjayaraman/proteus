import { COLLECTIONS, User } from '@proteus/schema';
import { initialsOf } from '@proteus/schema';
import type { FastifyInstance } from 'fastify';
import { sweepRotations } from '../../core/services/rotation';
import type { Repositories } from '../../core/repositories';
import { currentUser } from '../middleware/auth';
import { activityContext } from '../middleware/activity';
import type { ActivityRecorder } from '../../core/services/activity';

/**
 * The signed-in user, and their preferences.
 *
 * Preferences live here rather than in localStorage because the graph style and
 * discovery layout change what the user sees on the demo's centrepiece screen,
 * and should survive a device change (data model §3.1).
 */
export function registerMeRoutes(
  app: FastifyInstance,
  repos: Repositories,
  /** Absent in tests that do not exercise the activity log. */
  activity?: ActivityRecorder,
): void {
  /**
   * The signed-in user — and the only place the platform admin role is decided.
   *
   * This endpoint is the app's first call on every load, which is what makes it
   * the right place for three things the backend can genuinely observe: that an
   * account was created, that a new session began, and whether this address is
   * still in `PLATFORM_ADMIN_EMAILS`. Sign-in itself is not among them; Firebase
   * Auth is client-side and this process never sees it (PRD-15 §10).
   */
  app.get('/me', async (req) => {
    const u = currentUser(req);
    const ctx = activityContext(req);
    const existing = await repos.users.findOne({ userId: u.uid } as never);

    if (existing) {
      const now = new Date();
      // Read before the patch overwrites it — afterwards the gap is always zero.
      const newSession = activity?.startsSession(existing.lastSeenAt, now) ?? false;
      const role = await reconcileRole(repos, activity, ctx, existing);

      await repos.users.patch({ userId: u.uid } as never, { lastSeenAt: now } as never);

      if (newSession && ctx && activity) {
        void activity.record(ctx, {
          action: 'SESSION_STARTED',
          summary: 'Started a new session',
          detail: { idleMinutes: Math.round(
            (now.getTime() - new Date(existing.lastSeenAt).getTime()) / 60_000,
          ) },
        });
      }
      return { ...existing, role, lastSeenAt: now };
    }

    // First sign-in. Mirror what the header renders; nothing more.
    const now = new Date();
    const email = u.email ?? `${u.uid}@unknown.invalid`;
    const created = await repos.users.insert({
      _schemaVersion: 1,
      createdAt: now,
      updatedAt: now,
      userId: u.uid,
      email,
      displayName: u.displayName ?? 'Unknown',
      photoUrl: u.photoUrl,
      initials: initialsOf(u.displayName ?? 'Unknown'),
      role: activity?.isAdminEmail(email) ? 'PLATFORM_ADMIN' : 'USER',
      preferences: { theme: 'dark', graphStyle: 'force', discoveryLayout: 'graph' },
      lastSeenAt: now,
    } as User);

    if (ctx && activity) {
      void activity.record(ctx, {
        action: 'ACCOUNT_CREATED',
        summary: `Account created for ${created.displayName}`,
        target: email,
        detail: { role: created.role },
      });
    }
    return created;
  });

  app.patch<{ Body: Partial<User['preferences']> }>('/me/preferences', async (req) => {
    const u = currentUser(req);
    const prefs = User.shape.preferences.partial().parse(req.body ?? {});
    const set = Object.fromEntries(
      Object.entries(prefs).map(([k, v]) => [`preferences.${k}`, v]),
    );
    await repos.db
      .collection(COLLECTIONS.users)
      .updateOne({ userId: u.uid }, { $set: { ...set, updatedAt: new Date() } });
    return repos.users.findOne({ userId: u.uid } as never);
  });
}

/**
 * Grants or revokes PLATFORM_ADMIN to match the configured list.
 *
 * Reconciled on every request rather than granted once, so removing an address
 * from `PLATFORM_ADMIN_EMAILS` actually revokes the role. A grant that persisted
 * after the configuration changed would mean the environment variable describes
 * who *was* an admin, which is not what anyone reading it would assume.
 */
async function reconcileRole(
  repos: Repositories,
  activity: ActivityRecorder | undefined,
  ctx: ReturnType<typeof activityContext>,
  user: User,
): Promise<User['role']> {
  if (!activity) return user.role;

  const shouldBeAdmin = activity.isAdminEmail(user.email);
  const isAdmin = user.role === 'PLATFORM_ADMIN';
  if (shouldBeAdmin === isAdmin) return user.role;

  const role: User['role'] = shouldBeAdmin ? 'PLATFORM_ADMIN' : 'USER';
  await repos.users.patch({ userId: user.userId } as never, { role } as never);

  if (ctx) {
    void activity.record(ctx, {
      action: shouldBeAdmin ? 'ROLE_APPLIED' : 'ROLE_REVOKED',
      summary: shouldBeAdmin
        ? 'Granted the platform admin role from PLATFORM_ADMIN_EMAILS'
        : 'Revoked the platform admin role — the address is no longer configured',
      target: user.email,
      detail: { role },
    });
  }
  return role;
}

/**
 * The rotation sweep, as an endpoint.
 *
 * Risk 4: reminders need a scheduler and this prototype has none. The smallest
 * thing that works is an endpoint Cloud Scheduler can call — no cron process, no
 * leader election, and the same code path a developer can hit by hand to see
 * what it would do.
 *
 * Authenticated like everything else in this scope. Emitting is idempotent per
 * credential version, so calling it repeatedly is harmless.
 */
export function registerMaintenanceRoutes(
  app: FastifyInstance,
  repos: Repositories,
  /** Sandbox reclaim. Absent where hosting is not configured. */
  sandboxSweep?: () => Promise<{ scanned: number; reclaimed: string[];
    failed: Array<{ projectId: string; reason: string }> }>,
): void {
  /**
   * Reclaims expired sandboxes — services and images both.
   *
   * The image is the half that matters: Cloud Run scales to zero, so a stopped
   * service was already free, and the Artifact Registry storage is what accrues.
   */
  app.post('/maintenance/sandbox-sweep', async () => {
    if (!sandboxSweep) return { configured: false, scanned: 0, reclaimed: 0 };
    const result = await sandboxSweep();
    return {
      configured: true,
      scanned: result.scanned,
      reclaimed: result.reclaimed.length,
      // Reported rather than thrown: one sandbox whose service was already
      // deleted by hand must not stop the sweep reclaiming the rest.
      failed: result.failed,
    };
  });

  app.post('/maintenance/rotation-sweep', async () => {
    const result = await sweepRotations(repos);
    return {
      scanned: result.scanned,
      reminded: result.reminded.length,
      // Already-reminded projects are reported but not re-emitted: a sweep that
      // ran hourly would otherwise fill the audit trail with the same warning.
      alreadyReminded: result.alreadyReminded.length,
    };
  });
}
