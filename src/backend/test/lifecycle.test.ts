import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { COLLECTIONS, type SandboxDeployment } from '@proteus/schema';
import { findOrphans } from '../src/core/services/lifecycle';
import { sweepRotations } from '../src/core/services/rotation';
import { aProject, clearAll, startTestDb, type TestDb } from './helpers/mongo';
import { authFor, startTestServer, type TestServer } from './helpers/server';

/** PRD-17 acceptance criteria — ending a project's life without orphaning it. */

let t: TestDb;
let s: TestServer;
const OWNER = 'uid-owner';
const ADMIN = 'uid-admin';

beforeAll(async () => {
  t = await startTestDb();
  s = await startTestServer(t.repos);
}, 120_000);
afterAll(async () => { await s?.stop(); await t?.stop(); });

beforeEach(async () => {
  await clearAll(t.repos);
  const now = new Date();
  // The admin's role comes from the user document, exactly as PRD-15 grants it.
  await t.repos.users.insert({
    _schemaVersion: 1, createdAt: now, updatedAt: now,
    userId: ADMIN, email: 'admin@example.test', displayName: 'Admin', initials: 'A',
    role: 'PLATFORM_ADMIN',
    preferences: { theme: 'dark', graphStyle: 'force', discoveryLayout: 'graph' },
    lastSeenAt: now,
  } as never);
  await t.repos.users.insert({
    _schemaVersion: 1, createdAt: now, updatedAt: now,
    userId: OWNER, email: 'owner@example.test', displayName: 'Owner', initials: 'O',
    role: 'USER',
    preferences: { theme: 'dark', graphStyle: 'force', discoveryLayout: 'graph' },
    lastSeenAt: now,
  } as never);
});

const call = (path: string, uid: string, init: RequestInit = {}) =>
  fetch(`${s.url}${path}`, {
    ...init,
    headers: { ...authFor(uid), 'content-type': 'application/json', ...init.headers },
  });

/** A project with rows scattered across the collections a real one touches. */
async function aFullProject(over: Record<string, unknown> = {}) {
  const project = await t.repos.projects.create(aProject({
    ownerId: OWNER, stage: 'COMPLETED', lifecycle: 'ACTIVE', ...over,
  }) as never);
  const now = new Date();
  const base = { _schemaVersion: 1, createdAt: now, updatedAt: now, projectId: project.projectId };

  await t.repos.db.collection(COLLECTIONS.findings).insertOne({ ...base, findingId: 'f1' });
  await t.repos.db.collection(COLLECTIONS.graphNodes).insertOne({ ...base, nodeId: 'n1' });
  await t.repos.db.collection(COLLECTIONS.artifacts).insertOne({ ...base, artifactId: 'a1' });
  await t.repos.db.collection(COLLECTIONS.migrationRuns)
    .insertOne({ ...base, migrationRunId: 'm1' });
  return project;
}

async function aSandboxFor(projectId: string) {
  const now = new Date();
  await t.repos.sandboxDeployments.insert({
    _schemaVersion: 1, createdAt: now, updatedAt: now,
    sandboxDeploymentId: `sbx_${projectId}`, projectId, migrationRunId: 'm1',
    imageUri: 'scripted/img:abc', commitSha: 'a'.repeat(40),
    service: { name: `pqc-sandbox-${projectId.toLowerCase()}`, region: 'test',
               url: 'https://sandbox.test' },
    placement: 'CLOUD_RUN', status: 'READY', isProduction: false,
    scenarios: [], startupProbe: { ok: true, attempts: 1 },
    expiresAt: new Date(Date.now() + 86_400_000),
  } as never);
}

// ---------------------------------------------------------------------------

describe('lifecycle is not a stage (AC-1, AC-2)', () => {
  it('keeps the stage a deleted project reached', async () => {
    const p = await aFullProject({ stage: 'COMPLETED' });
    await call(`/projects/${p.projectId}`, ADMIN, {
      method: 'DELETE', body: JSON.stringify({ confirm: p.projectId }),
    });
    const raw = await t.repos.projects.byIdIncludingDeleted(p.projectId);
    // Stage says how far the migration got and keeps saying it; lifecycle says
    // whether anyone may touch it. Conflating them would lose the outcome.
    expect(raw?.stage).toBe('COMPLETED');
    expect(raw?.lifecycle).toBe('DELETED');
  });

  it('refuses to move backwards, and has no route that reactivates', async () => {
    const p = await aFullProject();
    await call(`/projects/${p.projectId}/archive`, OWNER, {
      method: 'POST', body: JSON.stringify({ confirm: p.projectId }),
    });
    const again = await call(`/projects/${p.projectId}/archive`, OWNER, {
      method: 'POST', body: JSON.stringify({ confirm: p.projectId }),
    });
    expect(again.status).toBe(409);

    const routes = s.app.printRoutes();
    expect(routes).not.toMatch(/unarchive|restore|undelete/i);
  });
});

describe('archive makes a project read-only (AC-3, AC-4)', () => {
  const archive = async (projectId: string) =>
    call(`/projects/${projectId}/archive`, OWNER, {
      method: 'POST', body: JSON.stringify({ confirm: projectId }),
    });

  it('refuses every mutating endpoint with 409', async () => {
    const p = await aFullProject();
    expect((await archive(p.projectId)).status).toBe(200);

    // Enumerated rather than hand-picked: the guard is inferred from the HTTP
    // method, so this is the list it must cover.
    const mutations: Array<[string, string]> = [
      ['POST', `/projects/${p.projectId}/assessment`],
      ['POST', `/projects/${p.projectId}/migration/approve`],
      ['POST', `/projects/${p.projectId}/report`],
      ['POST', `/projects/${p.projectId}/sandbox/extend`],
      ['POST', `/projects/${p.projectId}/files`],
      ['DELETE', `/projects/${p.projectId}/sandbox`],
    ];
    for (const [method, path] of mutations) {
      const res = await call(path, OWNER, { method, body: '{}' });
      expect(res.status, `${method} ${path}`).toBe(409);
    }
  });

  it('leaves every read working, including artifact downloads', async () => {
    const p = await aFullProject();
    await archive(p.projectId);
    for (const path of [
      `/projects/${p.projectId}`,
      `/projects/${p.projectId}/graph`,
      `/projects/${p.projectId}/artifacts`,
      `/projects/${p.projectId}/events`,
    ]) {
      expect((await call(path, OWNER)).status, path).toBe(200);
    }
  });

  it('releases the sandbox, and the slot comes back', async () => {
    const p = await aFullProject();
    await aSandboxFor(p.projectId);
    await archive(p.projectId);

    const rows = await t.repos.sandboxDeployments.find({ projectId: p.projectId } as never);
    expect((rows[0] as SandboxDeployment).status).toBe('TORN_DOWN');
    // An archived project offers no link to a sandbox, so retaining one would
    // hold a public URL and a platform slot for nothing.
    expect(s.deployer.tornDown.length).toBeGreaterThan(0);
  });

  it('refuses while a migration is running (AC-7)', async () => {
    const p = await aFullProject({ stage: 'MIGRATING' });
    const res = await archive(p.projectId);
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('CONFLICT');
  });

  it('requires the project id typed to confirm', async () => {
    const p = await aFullProject();
    const res = await call(`/projects/${p.projectId}/archive`, OWNER, {
      method: 'POST', body: JSON.stringify({ confirm: 'PQC-9999' }),
    });
    expect(res.status).toBe(400);
    expect((await t.repos.projects.byId(p.projectId))?.lifecycle).toBe('ACTIVE');
  });
});

describe('delete is soft, and admin only (AC-8 … AC-13)', () => {
  const del = (projectId: string, uid: string, confirm = projectId) =>
    call(`/projects/${projectId}`, uid, {
      method: 'DELETE', body: JSON.stringify({ confirm }),
    });

  it('gives a non-admin 404 and records the attempt', async () => {
    const p = await aFullProject();
    expect((await del(p.projectId, OWNER)).status).toBe(404);
    await new Promise((r) => setTimeout(r, 150));

    const denied = await t.repos.userActivity.find({ action: 'ACCESS_DENIED' } as never);
    expect(denied.length).toBeGreaterThan(0);
    expect((await t.repos.projects.byId(p.projectId))?.lifecycle).toBe('ACTIVE');
  });

  it('changes nothing when the confirmation does not match', async () => {
    const p = await aFullProject();
    expect((await del(p.projectId, ADMIN, 'wrong')).status).toBe(400);
    expect((await t.repos.projects.byId(p.projectId))?.lifecycle).toBe('ACTIVE');
  });

  it('leaves every row in place — nothing is orphaned (AC-10)', async () => {
    const p = await aFullProject();
    const before = new Map<string, number>();
    for (const name of Object.values(COLLECTIONS)) {
      before.set(name, await t.repos.db.collection(name)
        .countDocuments({ projectId: p.projectId }));
    }

    expect((await del(p.projectId, ADMIN)).status).toBe(204);

    // Asserted by iterating COLLECTIONS, so a collection added later is covered
    // without anyone remembering to add it here.
    for (const name of Object.values(COLLECTIONS)) {
      const after = await t.repos.db.collection(name)
        .countDocuments({ projectId: p.projectId });
      expect(after, `${name} lost rows`).toBeGreaterThanOrEqual(before.get(name)!);
    }
  });

  it('makes the project invisible everywhere (AC-11)', async () => {
    const p = await aFullProject();
    await del(p.projectId, ADMIN);

    expect(await t.repos.projects.byId(p.projectId)).toBeNull();
    // The row is still there — invisibility is a filter, not a removal.
    expect(await t.repos.projects.byIdIncludingDeleted(p.projectId)).not.toBeNull();

    const list = await (await call('/projects', OWNER)).json() as { projects: unknown[] };
    expect(list.projects).toHaveLength(0);

    // Every project-scoped route inherits this from `byId` without its own check.
    for (const path of [
      `/projects/${p.projectId}`,
      `/projects/${p.projectId}/graph`,
      `/projects/${p.projectId}/artifacts`,
    ]) {
      expect((await call(path, ADMIN)).status, path).toBe(404);
    }
  });

  it('destroys the credential rather than hiding it (AC-13)', async () => {
    const p = await t.repos.projects.create(aProject({
      ownerId: OWNER, stage: 'COMPLETED', lifecycle: 'ACTIVE',
      repository: {
        url: 'https://github.com/x/y', provider: 'GITHUB', defaultBranch: 'main',
        visibility: 'PREAUTHORIZED',
        credential: {
          secretName: 'proteus-x-github-pat', secretVersion: '1',
          displayPrefix: 'github_pat_', declaredScopes: [], status: 'STORED',
          storedAt: new Date(), rotationDueAt: new Date(),
        },
      },
    }) as never);
    await s.vault.store('proteus-x-github-pat', 'ghp_secret');

    await del(p.projectId, ADMIN);

    // A hidden project holding a live token is a credential nobody is watching
    // on a project nobody can see.
    await expect(
      s.vault.read({ name: 'proteus-x-github-pat', version: '1' }),
    ).rejects.toThrow();
    const raw = await t.repos.projects.byIdIncludingDeleted(p.projectId);
    expect(raw?.repository.credential?.status).toBe('REVOKED');
  });

  it('releases the sandbox (AC-12)', async () => {
    const p = await aFullProject();
    await aSandboxFor(p.projectId);
    await del(p.projectId, ADMIN);
    const rows = await t.repos.sandboxDeployments.find({ projectId: p.projectId } as never);
    expect((rows[0] as SandboxDeployment).status).toBe('TORN_DOWN');
  });

  it('refuses while a migration is running', async () => {
    const p = await aFullProject({ stage: 'VERIFYING' });
    expect((await del(p.projectId, ADMIN)).status).toBe(409);
  });

  it('keeps the activity entry that records the deletion (AC-15)', async () => {
    const p = await aFullProject();
    await del(p.projectId, ADMIN);
    await new Promise((r) => setTimeout(r, 200));

    // The entry outlives what it describes: it is the only remaining record of
    // who removed the project, so deleting it would destroy that evidence.
    const rows = await t.repos.userActivity.find({
      action: 'PROJECT_DELETED', projectId: p.projectId,
    } as never);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe(ADMIN);
  });

  it('can delete an archived project', async () => {
    const p = await aFullProject();
    await call(`/projects/${p.projectId}/archive`, OWNER, {
      method: 'POST', body: JSON.stringify({ confirm: p.projectId }),
    });
    expect((await del(p.projectId, ADMIN)).status).toBe(204);
  });
});

describe('the dry run (AC-16)', () => {
  it('reports what would go and changes nothing', async () => {
    const p = await aFullProject();
    await aSandboxFor(p.projectId);

    const body = await (await call(`/projects/${p.projectId}/deletion-preview`, ADMIN))
      .json() as { totalRows: number; rows: Array<{ collection: string }>;
                   sandbox: { present: boolean }; credential: { present: boolean } };

    expect(body.totalRows).toBeGreaterThan(0);
    expect(body.rows.map((r) => r.collection)).toContain(COLLECTIONS.findings);
    expect(body.sandbox.present).toBe(true);
    // The whole point of a dry run.
    expect((await t.repos.projects.byId(p.projectId))?.lifecycle).toBe('ACTIVE');
  });

  it('is refused for a non-admin', async () => {
    const p = await aFullProject();
    expect((await call(`/projects/${p.projectId}/deletion-preview`, OWNER)).status).toBe(404);
  });
});

describe('the rotation sweep skips what it cannot help (AC-14)', () => {
  it('leaves archived and deleted projects alone', async () => {
    const due = new Date(Date.now() - 86_400_000);
    for (const [id, lifecycle] of [['ACTIVE', 'ACTIVE'], ['ARCH', 'ARCHIVED'], ['DEL', 'DELETED']]) {
      await t.repos.projects.create(aProject({
        ownerId: OWNER, name: id, lifecycle,
        repository: {
          url: 'https://github.com/x/y', provider: 'GITHUB', defaultBranch: 'main',
          visibility: 'PREAUTHORIZED',
          credential: {
            secretName: `s-${id}`, secretVersion: '1', displayPrefix: 'github_pat_',
            declaredScopes: [], status: 'STORED', storedAt: due, rotationDueAt: due,
          },
        },
      }) as never);
    }
    // Called directly rather than over HTTP: the error handler turns any throw
    // into an opaque 500, and this assertion is about which rows it selected.
    const res = await sweepRotations(t.repos);
    // Reminding an archived project is noise nobody can clear, and a deleted
    // one has had its secret destroyed.
    expect(res.scanned).toBe(1);
  });
});

describe('the orphan sweep reports the old hard delete’s damage (AC-17)', () => {
  it('finds rows whose project no longer exists, and does not remove them', async () => {
    const p = await aFullProject();
    await aSandboxFor(p.projectId);
    // Exactly what the previous `delete()` did: removed the project document
    // and left eighteen collections pointing at it.
    await t.repos.projects.collection.deleteOne({ projectId: p.projectId } as never);

    const found = await findOrphans(t.repos);
    expect(found.projectIds).toContain(p.projectId);
    expect(found.rows.map((r) => r.collection)).toContain(COLLECTIONS.findings);
    // The half that costs capacity rather than storage.
    expect(found.strandedSandboxes.map((x) => x.projectId)).toContain(p.projectId);

    // Reports, never removes: destroying data stays a deliberate act.
    expect(await t.repos.db.collection(COLLECTIONS.findings)
      .countDocuments({ projectId: p.projectId })).toBe(1);
  });
});

describe('projects that predate the lifecycle field', () => {
  /**
   * The bug this class of test exists for.
   *
   * `Repository.findOne` returns the raw Mongo document without parsing, so
   * Zod's `.default('ACTIVE')` applies on write and never on read. Every project
   * created before PRD-17 came back with `lifecycle: undefined`, which
   * `assertMutable` read as "not ACTIVE" — turning the entire product read-only
   * for exactly the projects that predate it — and which crashed
   * `canTransitionLifecycle` on a delete.
   *
   * Every fixture elsewhere goes through `insert`, which parses. Only a raw
   * write reproduces it.
   */
  const anUnmigratedProject = async () => {
    const p = await t.repos.projects.create(aProject({
      ownerId: OWNER, stage: 'COMPLETED',
    }) as never);
    await t.repos.projects.collection.updateOne(
      { projectId: p.projectId } as never,
      { $unset: { lifecycle: '' } as never },
    );
    return p;
  };

  it('reads back as ACTIVE rather than undefined', async () => {
    const p = await anUnmigratedProject();
    expect((await t.repos.projects.byId(p.projectId))?.lifecycle).toBe('ACTIVE');
  });

  it('is not treated as archived — every mutation still works', async () => {
    const p = await anUnmigratedProject();
    // The regression that mattered more than the crash.
    const res = await call(`/projects/${p.projectId}/report`, OWNER, {
      method: 'POST', body: '{}',
    });
    expect(res.status).not.toBe(409);
  });

  it('can be archived without crashing on the missing value', async () => {
    const p = await anUnmigratedProject();
    const res = await call(`/projects/${p.projectId}/archive`, OWNER, {
      method: 'POST', body: JSON.stringify({ confirm: p.projectId }),
    });
    expect(res.status).toBe(200);
  });

  it('can be deleted — the crash in the report', async () => {
    const p = await anUnmigratedProject();
    const res = await call(`/projects/${p.projectId}`, ADMIN, {
      method: 'DELETE', body: JSON.stringify({ confirm: p.projectId }),
    });
    expect(res.status).toBe(204);
  });

  it('is backfilled at startup', async () => {
    const p = await anUnmigratedProject();
    const { runBackfills } = await import('../src/core/db/migrations');
    const result = await runBackfills(t.repos.db);

    expect(result.lifecycle).toBeGreaterThanOrEqual(1);
    const raw = await t.repos.projects.collection
      .findOne({ projectId: p.projectId } as never) as unknown as { lifecycle?: string };
    // Fixed in the data, not only compensated for on read.
    expect(raw.lifecycle).toBe('ACTIVE');
  });

  it('appears in the owner list like any other project', async () => {
    await anUnmigratedProject();
    const list = await (await call('/projects', OWNER)).json() as { projects: unknown[] };
    expect(list.projects).toHaveLength(1);
  });
});
