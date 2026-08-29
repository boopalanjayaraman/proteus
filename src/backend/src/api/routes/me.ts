import { COLLECTIONS, User } from '@proteus/schema';
import { initialsOf } from '@proteus/schema';
import type { FastifyInstance } from 'fastify';
import { sweepRotations } from '../../core/services/rotation';
import type { Repositories } from '../../core/repositories';
import { currentUser } from '../middleware/auth';

/**
 * The signed-in user, and their preferences.
 *
 * Preferences live here rather than in localStorage because the graph style and
 * discovery layout change what the user sees on the demo's centrepiece screen,
 * and should survive a device change (data model §3.1).
 */
export function registerMeRoutes(app: FastifyInstance, repos: Repositories): void {
  app.get('/me', async (req) => {
    const u = currentUser(req);
    const existing = await repos.users.findOne({ userId: u.uid } as never);
    if (existing) {
      await repos.users.patch({ userId: u.uid } as never, { lastSeenAt: new Date() } as never);
      return existing;
    }

    // First sign-in. Mirror what the header renders; nothing more.
    const now = new Date();
    const created = await repos.users.insert({
      _schemaVersion: 1,
      createdAt: now,
      updatedAt: now,
      userId: u.uid,
      email: u.email ?? `${u.uid}@unknown.invalid`,
      displayName: u.displayName ?? 'Unknown',
      photoUrl: u.photoUrl,
      initials: initialsOf(u.displayName ?? 'Unknown'),
      preferences: { theme: 'dark', graphStyle: 'force', discoveryLayout: 'graph' },
      lastSeenAt: now,
    } as User);
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
