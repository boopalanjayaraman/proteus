import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { isoUtc, navigationKey, ACTIVITY_CATEGORY, ActivityAction } from '@proteus/schema';
import pino from 'pino';
import { buildServer } from '../src/api/server';
import { ActivityRecorder, decodeCursor, encodeCursor } from '../src/core/services/activity';
import { ApprovalService } from '../src/core/services/approval';
import { AssessmentService } from '../src/core/services/assessment';
import { GraphService } from '../src/core/services/graph';
import { ProjectService } from '../src/core/services/projects';
import { InMemorySecretVault } from '../src/integrations/secrets/vault';
import { InMemoryBlobStore } from '../src/integrations/storage/blobs';
import { StubVerifier, authFor } from './helpers/server';
import { aProject, clearAll, startTestDb, type TestDb } from './helpers/mongo';
import type { FastifyInstance } from 'fastify';

/** PRD-15 acceptance criteria — who did what, and who is allowed to read it. */

let t: TestDb;
let app: FastifyInstance;
let url: string;
let recorder: ActivityRecorder;

const OWNER = 'uid-owner';
const OTHER = 'uid-other';
const ADMIN = 'uid-admin';
/** The StubVerifier derives the address from the uid, so this is admin@example.test. */
const ADMIN_EMAIL = `${ADMIN}@example.test`;

beforeAll(async () => {
  t = await startTestDb();
  recorder = new ActivityRecorder(t.repos, {
    adminEmails: [ADMIN_EMAIL],
    sessionGapMinutes: 30,
    navigationWindowSeconds: 30,
  });

  const vault = new InMemorySecretVault();
  const blobs = new InMemoryBlobStore();
  app = await buildServer({
    repos: t.repos,
    projects: new ProjectService(t.repos, vault, blobs),
    graph: new GraphService(t.repos),
    assessments: new AssessmentService(t.repos),
    approvals: new ApprovalService(t.repos),
    blobs,
    verifier: new StubVerifier(),
    logger: pino({ level: 'silent' }),
    activity: recorder,
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
}, 120_000);

afterAll(async () => {
  await app?.close();
  await t?.stop();
});

beforeEach(async () => {
  await clearAll(t.repos);
  // The dedupe cache is keyed by a wall-clock bucket, and several tests run
  // inside one — without this the second test's page view is suppressed by a
  // key the first one wrote.
  recorder.forgetNavigationCache();
});

const ctxFor = (uid: string) => ({
  userId: uid, userEmail: `${uid}@example.test`, requestId: 'req-1',
});

/** Establishes the user document, which is where the role is decided. */
const signIn = (uid: string, screen?: string) =>
  fetch(`${url}/me`, {
    headers: { ...authFor(uid), ...(screen ? { 'x-proteus-screen': screen } : {}) },
  });

const get = (path: string, uid: string, screen?: string) =>
  fetch(`${url}${path}`, {
    headers: { ...authFor(uid), ...(screen ? { 'x-proteus-screen': screen } : {}) },
  });

const activityFor = async (uid: string, query = ''): Promise<{
  scope: string; isAdmin: boolean; count: number;
  entries: Array<Record<string, unknown>>; nextCursor?: string;
}> => (await get(`/activity${query}`, uid)).json() as never;

const actionsOf = (entries: Array<Record<string, unknown>>) =>
  entries.map((e) => e['action'] as string);

// ---------------------------------------------------------------------------

describe('the role, and how it is granted (AC-3)', () => {
  it('grants PLATFORM_ADMIN from configuration at sign-in', async () => {
    await signIn(ADMIN);
    const user = await t.repos.users.findOne({ userId: ADMIN } as never);
    expect(user?.role).toBe('PLATFORM_ADMIN');
  });

  it('leaves everyone else a plain user', async () => {
    await signIn(OWNER);
    const user = await t.repos.users.findOne({ userId: OWNER } as never);
    expect(user?.role).toBe('USER');
  });

  it('revokes the role when the address leaves the configured list', async () => {
    await signIn(ADMIN);
    expect((await t.repos.users.findOne({ userId: ADMIN } as never))?.role)
      .toBe('PLATFORM_ADMIN');

    // A grant that survived the configuration change would mean the variable
    // describes who *was* an admin.
    const narrowed = new ActivityRecorder(t.repos, { adminEmails: [] });
    const stripped = await buildServer({
      repos: t.repos,
      projects: new ProjectService(t.repos, new InMemorySecretVault(), new InMemoryBlobStore()),
      graph: new GraphService(t.repos),
      assessments: new AssessmentService(t.repos),
      approvals: new ApprovalService(t.repos),
      blobs: new InMemoryBlobStore(),
      verifier: new StubVerifier(),
      logger: pino({ level: 'silent' }),
      activity: narrowed,
    });
    await stripped.listen({ port: 0, host: '127.0.0.1' });
    const a = stripped.server.address();
    await fetch(`http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}/me`, {
      headers: authFor(ADMIN),
    });
    await stripped.close();

    expect((await t.repos.users.findOne({ userId: ADMIN } as never))?.role).toBe('USER');
  });

  it('has no endpoint that grants the role', async () => {
    await signIn(OWNER);
    const attempts = await Promise.all([
      fetch(`${url}/me`, {
        method: 'PATCH', headers: { ...authFor(OWNER), 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'PLATFORM_ADMIN' }),
      }),
      fetch(`${url}/me/preferences`, {
        method: 'PATCH', headers: { ...authFor(OWNER), 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'PLATFORM_ADMIN' }),
      }),
    ]);
    expect(attempts.every((r) => r.ok === false || r.status === 200)).toBe(true);
    expect((await t.repos.users.findOne({ userId: OWNER } as never))?.role).toBe('USER');
  });
});

describe('scope (AC-1, AC-2)', () => {
  beforeEach(async () => {
    await signIn(OWNER);
    await signIn(OTHER);
    await signIn(ADMIN);
    await recorder.record(ctxFor(OWNER), { action: 'PROJECT_CREATED', summary: 'owner did a thing' });
    await recorder.record(ctxFor(OTHER), { action: 'PROJECT_CREATED', summary: 'other did a thing' });
  });

  it('shows a user only their own activity', async () => {
    const body = await activityFor(OWNER);
    expect(body.scope).toBe('SELF');
    expect(body.entries.every((e) => e['userId'] === OWNER)).toBe(true);
    expect(body.entries.some((e) => e['summary'] === 'other did a thing')).toBe(false);
  });

  it('ignores a non-admin asking for someone else rather than refusing (AC-1)', async () => {
    const res = await get(`/activity?userId=${OTHER}`, OWNER);
    // Not a 403: refusing would confirm the filter is meaningful, which is how
    // an authenticated user learns other users exist.
    expect(res.status).toBe(200);
    const body = await res.json() as { entries: Array<Record<string, unknown>> };
    expect(body.entries.every((e) => e['userId'] === OWNER)).toBe(true);
  });

  it('shows an admin everyone, and lets them filter to one (AC-2)', async () => {
    const all = await activityFor(ADMIN);
    expect(all.isAdmin).toBe(true);
    expect(all.scope).toBe('ALL');
    const users = new Set(all.entries.map((e) => e['userId']));
    expect(users.has(OWNER) && users.has(OTHER)).toBe(true);

    const one = await activityFor(ADMIN, `?userId=${OTHER}`);
    expect(one.scope).toBe('USER');
    expect(one.entries.every((e) => e['userId'] === OTHER)).toBe(true);
  });

  it('records an admin reading someone else, and not reading their own (AC-11)', async () => {
    await activityFor(ADMIN, `?userId=${OWNER}`);
    await activityFor(ADMIN);
    // The write is deliberately not awaited by the route, so give it a tick.
    await new Promise((r) => setTimeout(r, 150));

    const rows = await t.repos.userActivity.find({
      userId: ADMIN, action: 'ACTIVITY_VIEWED',
    } as never);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.target).toBe(OWNER);
  });

  it('offers a non-admin exactly one user to filter by — themselves', async () => {
    const body = await (await get('/activity/users', OWNER)).json() as
      { users: Array<{ userId: string }> };
    expect(body.users.map((u) => u.userId)).toEqual([OWNER]);
  });
});

describe('what gets recorded (AC-4)', () => {
  beforeEach(async () => { await signIn(OWNER); });

  it('records a denied access to another user’s project (AC-4)', async () => {
    await t.repos.projects.create(aProject({ ownerId: OTHER }) as never);
    const project = (await t.repos.projects.listForOwner(OTHER))[0]!;

    const res = await get(`/projects/${project.projectId}`, OWNER, 'PROJECTS');
    // The caller learns nothing; the log records everything.
    expect(res.status).toBe(404);
    await new Promise((r) => setTimeout(r, 150));

    const rows = await t.repos.userActivity.find({ userId: OWNER, action: 'ACCESS_DENIED' } as never);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe('DENIED');
    expect(rows[0]?.target).toBe(project.projectId);
  });

  it('records account creation once, on the first GET /me (AC-4c)', async () => {
    await signIn(OWNER);
    await signIn(OWNER);
    await new Promise((r) => setTimeout(r, 150));
    const rows = await t.repos.userActivity.find({ action: 'ACCOUNT_CREATED' } as never);
    expect(rows).toHaveLength(1);
  });

  it('records a new session only after the idle gap (AC-4c)', async () => {
    const long = new Date(Date.now() - 90 * 60_000);
    await t.repos.users.patch({ userId: OWNER } as never, { lastSeenAt: long } as never);
    await signIn(OWNER);
    await new Promise((r) => setTimeout(r, 150));

    expect(await t.repos.userActivity.count({ action: 'SESSION_STARTED' } as never)).toBe(1);

    // A request inside the gap is the same session, not a new one.
    await signIn(OWNER);
    await new Promise((r) => setTimeout(r, 150));
    expect(await t.repos.userActivity.count({ action: 'SESSION_STARTED' } as never)).toBe(1);
  });

  it('files every action under exactly one category, decided by the action', () => {
    for (const action of ActivityAction.options) {
      expect(ACTIVITY_CATEGORY[action], `${action} has no category`).toBeTruthy();
    }
  });

  it('never fails the action it records (AC-6)', async () => {
    const broken = new ActivityRecorder({
      userActivity: { insert: () => { throw new Error('mongo is down'); } },
    } as never);
    await expect(
      broken.record(ctxFor(OWNER), { action: 'PROJECT_CREATED', summary: 'still fine' }),
    ).resolves.toBeNull();
  });
});

describe('credentials never reach the log (AC-5)', () => {
  it('redacts a token that reaches a summary or a detail', async () => {
    await signIn(OWNER);
    const token = `ghp_${'a'.repeat(36)}`;
    await recorder.record(ctxFor(OWNER), {
      action: 'TOKEN_REPLACED',
      summary: `Replaced the token with ${token}`,
      detail: { pasted: token },
    });

    const row = await t.repos.userActivity.findOne({ action: 'TOKEN_REPLACED' } as never);
    // The base repository redacts on the way in, so there is no call site that
    // can forget — which is the only way this holds across thirty of them.
    expect(row?.summary).not.toContain(token);
    expect(row?.summary).toContain('[REDACTED]');
    expect(JSON.stringify(row)).not.toContain(token);
  });
});

describe('page visits (AC-4a, AC-4b, AC-10a)', () => {
  beforeEach(async () => { await signIn(OWNER); });

  it('collapses one screen load’s several calls into a single entry (AC-4a)', async () => {
    const project = await t.repos.projects.create(aProject({ ownerId: OWNER }) as never);
    // What the completion screen actually does on mount.
    await Promise.all([
      get(`/projects/${project.projectId}`, OWNER, 'SANDBOX'),
      get(`/projects/${project.projectId}/artifacts`, OWNER, 'SANDBOX'),
      get(`/projects/${project.projectId}/recommendations`, OWNER, 'SANDBOX'),
      get(`/projects/${project.projectId}/gates`, OWNER, 'SANDBOX'),
      get(`/projects/${project.projectId}/changes`, OWNER, 'SANDBOX'),
      get(`/projects/${project.projectId}/migration`, OWNER, 'SANDBOX'),
      get(`/projects/${project.projectId}/sandbox`, OWNER, 'SANDBOX'),
    ]);
    await new Promise((r) => setTimeout(r, 250));

    const rows = await t.repos.userActivity.find({ action: 'PAGE_VIEWED' } as never);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.screen).toBe('SANDBOX');
    expect(rows[0]?.projectId).toBe(project.projectId);
  });

  it('rejects a screen that is not one of the declared ones (AC-4b)', async () => {
    await get('/projects', OWNER, 'ADMIN_PANEL');
    await get('/projects', OWNER, '<script>alert(1)</script>');
    await new Promise((r) => setTimeout(r, 200));
    // Dropped, not stored as free text — the alternative is a browser writing
    // arbitrary strings into a field this screen searches and renders.
    expect(await t.repos.userActivity.count({ action: 'PAGE_VIEWED' } as never)).toBe(0);
  });

  it('separates screens, and separates projects on the same screen', async () => {
    const a = await t.repos.projects.create(aProject({ ownerId: OWNER }) as never);
    const b = await t.repos.projects.create(aProject({ ownerId: OWNER }) as never);
    await get('/projects', OWNER, 'PROJECTS');
    await get(`/projects/${a.projectId}`, OWNER, 'ASSESSMENT');
    await get(`/projects/${b.projectId}`, OWNER, 'ASSESSMENT');
    await new Promise((r) => setTimeout(r, 250));

    expect(await t.repos.userActivity.count({ action: 'PAGE_VIEWED' } as never)).toBe(3);
  });

  it('marks only page views as DECLARED (AC-10a)', async () => {
    await get('/projects', OWNER, 'PROJECTS');
    await recorder.record(ctxFor(OWNER), { action: 'PROJECT_CREATED', summary: 'made one' });
    await new Promise((r) => setTimeout(r, 200));

    const declared = await t.repos.userActivity.find({ provenance: 'DECLARED' } as never);
    expect(declared.every((e) => e.category === 'NAVIGATION')).toBe(true);
    expect(declared.length).toBeGreaterThan(0);
  });

  it('hides page views by default and shows them on request (AC-10)', async () => {
    await get('/projects', OWNER, 'PROJECTS');
    await recorder.record(ctxFor(OWNER), { action: 'PROJECT_CREATED', summary: 'made one' });
    await new Promise((r) => setTimeout(r, 200));

    const hidden = await activityFor(OWNER);
    expect(actionsOf(hidden.entries)).not.toContain('PAGE_VIEWED');

    const shown = await activityFor(OWNER, '?includeNavigation=true');
    expect(actionsOf(shown.entries)).toContain('PAGE_VIEWED');

    // Asking for the category directly is asking for it, whatever the toggle says.
    const only = await activityFor(OWNER, '?category=NAVIGATION');
    expect(only.entries.every((e) => e['category'] === 'NAVIGATION')).toBe(true);
    expect(only.entries.length).toBeGreaterThan(0);
  });

  it('buckets the dedupe key by window, user, screen and project', () => {
    const at = new Date('2026-08-29T14:32:11Z');
    const same = new Date('2026-08-29T14:32:29Z');
    const key = (d: Date, over: Record<string, unknown> = {}) =>
      navigationKey({ userId: 'u', screen: 'SANDBOX', at: d, windowSeconds: 30, ...over });

    expect(key(at)).toBe(key(same));
    expect(key(at)).not.toBe(key(new Date('2026-08-29T14:33:11Z')));
    expect(key(at)).not.toBe(key(at, { screen: 'MIGRATION' }));
    expect(key(at)).not.toBe(key(at, { projectId: 'PQC-0001' }));
    expect(key(at)).not.toBe(key(at, { userId: 'v' }));
  });
});

describe('ordering, paging and filters (AC-7, AC-8, AC-9)', () => {
  beforeEach(async () => { await signIn(OWNER); });

  /** Written directly so the timestamps are controlled rather than observed. */
  const seed = async (n: number, at: (i: number) => Date) => {
    for (let i = 0; i < n; i += 1) {
      const when = at(i);
      await t.repos.userActivity.insert({
        _schemaVersion: 1, createdAt: when, updatedAt: when,
        activityId: `act_${String(i).padStart(4, '0')}`,
        userId: OWNER, userEmail: `${OWNER}@example.test`,
        category: 'PROJECT', action: 'PROJECT_CREATED',
        summary: `entry ${i}`, projectId: 'PQC-0001',
        outcome: 'SUCCESS', provenance: 'OBSERVED', at: when,
      } as never);
    }
  };

  it('returns the newest first (AC-8)', async () => {
    await seed(5, (i) => new Date(Date.now() - i * 60_000));
    // Scoped past the ACCOUNT_CREATED that signing in writes.
    const body = await activityFor(OWNER, '?category=PROJECT');
    const times = body.entries.map((e) => new Date(e['at'] as string).getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect(body.entries[0]?.['summary']).toBe('entry 0');
  });

  it('orders identical timestamps deterministically (AC-8)', async () => {
    // Entries written in the same millisecond are common; `at` alone is not a
    // total order, so paging without a tiebreak would repeat and drop rows.
    const same = new Date('2026-08-29T12:00:00.000Z');
    await seed(6, () => same);

    const first = await activityFor(OWNER, '?limit=3&category=PROJECT');
    const second = await activityFor(
      OWNER, `?limit=3&category=PROJECT&cursor=${first.nextCursor}`,
    );
    const ids = [...first.entries, ...second.entries].map((e) => e['activityId']);
    expect(new Set(ids).size).toBe(6);
  });

  it('returns every row exactly once while new rows arrive (AC-7)', async () => {
    await seed(10, (i) => new Date(Date.now() - i * 1000));

    const seenIds: string[] = [];
    let cursor: string | undefined;
    let guard = 0;
    do {
      const page = await activityFor(
        OWNER, `?limit=3&category=PROJECT${cursor ? `&cursor=${cursor}` : ''}`,
      );
      seenIds.push(...page.entries.map((e) => e['activityId'] as string));
      cursor = page.nextCursor;
      // A row written between pages. Offset paging would shift everything down
      // and repeat one; keyset paging is anchored to a value, so it cannot.
      await recorder.record(ctxFor(OWNER), {
        action: 'PROJECT_CREATED', summary: 'arrived late',
      });
      guard += 1;
    } while (cursor && guard < 20);

    expect(new Set(seenIds).size).toBe(seenIds.length);
    expect(seenIds.length).toBeGreaterThanOrEqual(10);
  });

  it('narrows by category, outcome, project and date, and composes them (AC-9)', async () => {
    await recorder.record(ctxFor(OWNER), {
      action: 'MIGRATION_APPROVED', summary: 'approved the migration', projectId: 'PQC-0001',
    });
    await recorder.record(ctxFor(OWNER), {
      action: 'ACCESS_DENIED', summary: 'tried another project',
      projectId: 'PQC-0002', outcome: 'DENIED',
    });
    await recorder.record(ctxFor(OWNER), {
      action: 'REPORT_DOWNLOADED', summary: 'took the report', projectId: 'PQC-0001',
    });

    expect(actionsOf((await activityFor(OWNER, '?category=MIGRATION')).entries))
      .toEqual(['MIGRATION_APPROVED']);
    expect(actionsOf((await activityFor(OWNER, '?outcome=DENIED')).entries))
      .toEqual(['ACCESS_DENIED']);
    expect((await activityFor(OWNER, '?projectId=PQC-0001')).count).toBe(2);

    const composed = await activityFor(OWNER, '?projectId=PQC-0001&category=ARTIFACT');
    expect(actionsOf(composed.entries)).toEqual(['REPORT_DOWNLOADED']);

    const future = await activityFor(OWNER, '?from=2099-01-01T00:00:00.000Z');
    expect(future.count).toBe(0);
  });

  it('searches summaries and targets, and treats the query as text (AC-9)', async () => {
    await recorder.record(ctxFor(OWNER), {
      action: 'MIGRATION_APPROVED', summary: 'Approved the migration of Payments API',
      target: 'pqc/payments-api',
    });
    await recorder.record(ctxFor(OWNER), {
      action: 'PROJECT_CREATED', summary: 'Created project Billing',
    });

    expect((await activityFor(OWNER, '?q=payments')).count).toBe(1);
    expect((await activityFor(OWNER, '?q=pqc%2Fpayments')).count).toBe(1);
    // `.` is a literal, not a wildcard — otherwise a search box is a query
    // language nobody documented.
    expect((await activityFor(OWNER, '?q=Billin.')).count).toBe(0);
  });

  it('survives a malformed cursor by returning the first page', async () => {
    await seed(3, (i) => new Date(Date.now() - i * 1000));
    expect(decodeCursor('not-a-cursor')).toBeNull();
    expect((await activityFor(OWNER, '?category=PROJECT&cursor=%F0%9F%92%A5')).count).toBe(3);
  });

  it('round-trips a cursor', () => {
    const at = new Date('2026-08-29T14:32:11.123Z');
    const back = decodeCursor(encodeCursor({ at, activityId: 'act_1' }));
    expect(back?.at.toISOString()).toBe(at.toISOString());
    expect(back?.activityId).toBe('act_1');
  });
});

describe('timestamps (AC-12)', () => {
  it('renders ISO 8601 in UTC, to the second', () => {
    expect(isoUtc(new Date('2026-08-29T14:32:11.482Z'))).toBe('2026-08-29T14:32:11Z');
    // A local-time rendering of the same instant differs per reader, which is
    // the one thing an audit log cannot afford.
    expect(isoUtc(new Date('2026-08-29T23:59:59.999+05:30'))).toBe('2026-08-29T18:29:59Z');
    expect(isoUtc('not a date')).toBe('');
  });

  it('sends the rendered timestamp alongside the stored one', async () => {
    await signIn(OWNER);
    await recorder.record(ctxFor(OWNER), { action: 'PROJECT_CREATED', summary: 'x' });
    const body = await activityFor(OWNER);
    expect(body.entries[0]?.['atUtc']).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });
});

describe('append-only (FR-2)', () => {
  it('exposes no update or delete path on the repository', () => {
    const repo = t.repos.userActivity as unknown as Record<string, unknown>;
    // `patch` exists on the base class and is the one thing that must never be
    // reachable for this collection through a route.
    expect(typeof repo['insert']).toBe('function');
    expect(repo['delete']).toBeUndefined();
    expect(repo['update']).toBeUndefined();
  });

  it('has no endpoint that writes an activity entry', async () => {
    await signIn(OWNER);
    const forged = await Promise.all([
      fetch(`${url}/activity`, {
        method: 'POST', headers: { ...authFor(OWNER), 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'MIGRATION_APPROVED', summary: 'I approved it' }),
      }),
      fetch(`${url}/activity/client`, {
        method: 'POST', headers: { ...authFor(OWNER), 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'PAGE_VIEWED' }),
      }),
    ]);
    // An endpoint that writes audit entries from a browser is a way to forge an
    // audit log rather than a way to fill one, so there isn't one.
    expect(forged.map((r) => r.status)).toEqual([404, 404]);
  });
});
