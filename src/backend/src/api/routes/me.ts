import { COLLECTIONS, User } from '@proteus/schema';
import { initialsOf } from '@proteus/schema';
import type { FastifyInstance } from 'fastify';
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
