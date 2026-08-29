import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CREDENTIAL_ROTATION_DAYS, REQUIRED_GITHUB_SCOPES } from '@proteus/schema';
import { aProject, clearAll, startTestDb, type TestDb } from './helpers/mongo';
import { authFor, startTestServer, type TestServer } from './helpers/server';

/** PRD-05 acceptance criteria. */

let t: TestDb;
let s: TestServer;
const OWNER = 'firebase-uid-1';
const OTHER = 'firebase-uid-2';
const TOKEN = 'github_pat_11ABCDEFGH0123456789_abcdefghijklmnopqrstuvwxyz012345';

beforeAll(async () => {
  t = await startTestDb();
  s = await startTestServer(t.repos);
});
afterAll(async () => { await s?.stop(); await t?.stop(); });
beforeEach(async () => {
  await clearAll(t.repos);
  // The fakes outlive the database, so clear them too — otherwise the project id
  // counter restarts, secret names repeat, and versions accumulate across tests.
  s.vault.clear();
  s.blobs.clear();
});

const createBody = (over: Record<string, unknown> = {}) => ({
  name: 'Payment API PQC Migration',
  repositoryUrl: 'https://github.com/northwind-pay/payments-api',
  githubToken: TOKEN,
  ...over,
});

async function create(body = createBody(), uid = OWNER) {
  const r = await fetch(`${s.url}/projects`, {
    method: 'POST',
    headers: { ...authFor(uid), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}

describe('AC-1 · the token never enters the database', () => {
  it('appears in no document in any collection', async () => {
    const { body } = await create();
    const names = await t.repos.db.listCollections().toArray();

    for (const c of names) {
      const docs = await t.repos.db.collection(c.name).find({}).toArray();
      expect(JSON.stringify(docs), `token found in ${c.name}`).not.toContain(TOKEN);
    }
    expect(body.projectId).toMatch(/^PQC-\d{4,}$/);
  });

  it('does reach the vault — the credential is stored, not discarded', async () => {
    const { body } = await create();
    expect(s.vault.names).toContain(`proteus-${body.projectId}-github-pat`);
    // And can be read back by the one permitted path.
    expect(await s.projects.credentialFor(body.projectId)).toBe(TOKEN);
  });
});

describe('AC-2 · no response contains the token', () => {
  it('returns a prefix and a status, and nothing usable', async () => {
    const { status, body } = await create();
    expect(status).toBe(201);

    const cred = body.repository.credential;
    expect(cred.displayPrefix).toBe(TOKEN.slice(0, 12));
    expect(cred.displayPrefix.length).toBeLessThanOrEqual(12);
    expect(cred.status).toBe('STORED');
    expect(cred.declaredScopes).toEqual([...REQUIRED_GITHUB_SCOPES]);
    // Neither the token nor the vault coordinates leave the server.
    expect(JSON.stringify(body)).not.toContain(TOKEN);
    expect(cred.secretName).toBeUndefined();
    expect(cred.secretVersion).toBeUndefined();
  });

  it('holds on GET and on the list', async () => {
    const { body } = await create();
    const one = await (await fetch(`${s.url}/projects/${body.projectId}`, { headers: authFor(OWNER) })).json();
    const list = await (await fetch(`${s.url}/projects`, { headers: authFor(OWNER) })).json();
    expect(JSON.stringify(one)).not.toContain(TOKEN);
    expect(JSON.stringify(list)).not.toContain(TOKEN);
  });

  it('does not echo the token when it fails validation', async () => {
    const r = await fetch(`${s.url}/projects`, {
      method: 'POST',
      headers: { ...authFor(OWNER), 'content-type': 'application/json' },
      body: JSON.stringify(createBody({ githubToken: 'not-a-github-token-but-long' })),
    });
    expect(r.status).toBe(400);
    expect(JSON.stringify(await r.json())).not.toContain('not-a-github-token-but-long');
  });
});

describe('AC-3 · the version is pinned', () => {
  it('records a concrete version, never latest', async () => {
    const { body } = await create();
    const stored = await t.repos.projects.byId(body.projectId);
    expect(stored!.repository.credential!.secretVersion).toBe('1');
    expect(stored!.repository.credential!.secretVersion).not.toBe('latest');
  });

  it('sets a rotation date 90 days out', async () => {
    const { body } = await create();
    const cred = (await t.repos.projects.byId(body.projectId))!.repository.credential!;
    const days = (cred.rotationDueAt.getTime() - cred.storedAt.getTime()) / 86_400_000;
    expect(Math.round(days)).toBe(CREDENTIAL_ROTATION_DAYS);
  });
});

describe('AC-4 · a vault failure leaves nothing behind', () => {
  it('creates no project when the secret cannot be written', async () => {
    const original = s.vault.store.bind(s.vault);
    s.vault.store = async () => { throw new Error('secret manager unavailable'); };

    const r = await fetch(`${s.url}/projects`, {
      method: 'POST',
      headers: { ...authFor(OWNER), 'content-type': 'application/json' },
      body: JSON.stringify(createBody()),
    });
    expect(r.status).toBe(500);
    expect(await t.repos.projects.count()).toBe(0);

    s.vault.store = original;
  });
});

/**
 * AC-5, as PRD-17 rewrote it.
 *
 * PRD-05 gave the owner a hard delete. That is superseded (D-022): delete is a
 * platform admin's soft delete, and the owner's action is now archive. The
 * half of AC-5 that survives unchanged is the one that mattered — the
 * credential is destroyed, not hidden.
 *
 * The full behaviour is covered in `lifecycle.test.ts`; this asserts the
 * boundary PRD-05 owned, which is that an owner can no longer delete.
 */
describe('AC-5 · the owner can no longer delete (superseded by PRD-17)', () => {
  it('refuses an owner without the platform admin role', async () => {
    const { body } = await create({ ...createBody(), files: [
      { kind: 'HSM_SPEC', originalName: 'spec.pdf', mimeType: 'application/pdf',
        contentBase64: Buffer.from('hsm specification').toString('base64') },
    ] } as never);

    expect(s.vault.names).toHaveLength(1);

    const r = await fetch(`${s.url}/projects/${body.projectId}`, {
      method: 'DELETE',
      headers: { ...authFor(OWNER), 'content-type': 'application/json' },
      body: JSON.stringify({ confirm: body.projectId }),
    });
    // 404 rather than 403: a 403 would confirm the action exists and is worth
    // probing for.
    expect(r.status).toBe(404);
    // Nothing happened. The credential and the blobs are untouched.
    expect(s.vault.names).toHaveLength(1);
    expect(s.blobs.paths.length).toBeGreaterThan(0);
    expect(await t.repos.projects.byId(body.projectId)).not.toBeNull();
  });
});

describe('AC-6 · repository and token alone are enough', () => {
  it('creates without documents or instructions', async () => {
    const { status, body } = await create();
    expect(status).toBe(201);
    expect(body.stage).toBe('CREATED');
  });

  it('accepts optional uploads and stores the bytes outside Mongo', async () => {
    const { body } = await create({ ...createBody(), files: [
      { kind: 'HSM_SPEC', originalName: 'Thales-spec.pdf', mimeType: 'application/pdf',
        contentBase64: Buffer.from('§4.2 supported algorithms').toString('base64') },
      { kind: 'CBOM', originalName: 'cbom.json', mimeType: 'application/json',
        contentBase64: Buffer.from('{}').toString('base64') },
    ] } as never);

    const files = await t.repos.projectFiles.find({ projectId: body.projectId } as never);
    expect(files).toHaveLength(2);
    // Metadata in Mongo, bytes in the blob store.
    expect(files[0]!.gcsUri).toMatch(/^gs:\/\//);
    expect(files[0]!.sha256).toHaveLength(64);
    expect(JSON.stringify(files)).not.toContain('supported algorithms');
    expect(s.blobs.paths.every((p) => p.startsWith(`projects/${body.projectId}/files/`))).toBe(true);
  });

  it('rejects an unknown file kind', async () => {
    const r = await fetch(`${s.url}/projects`, {
      method: 'POST',
      headers: { ...authFor(OWNER), 'content-type': 'application/json' },
      body: JSON.stringify({ ...createBody(), files: [
        { kind: 'NONSENSE', originalName: 'x', mimeType: 'text/plain', contentBase64: 'eA==' },
      ] }),
    });
    expect(r.status).toBe(400);
  });
});

describe('AC-7 · the landing list', () => {
  it('returns tiles with a derived rail and header counts', async () => {
    await create();
    const { body: second } = await create();
    await t.repos.projects.transition(second.projectId, 'CREATED', 'AWAITING_APPROVAL');

    const list = await (await fetch(`${s.url}/projects`, { headers: authFor(OWNER) })).json();
    expect(list.count).toBe(2);
    expect(list.awaitingApproval).toBe(1);
    // CREATED is rail 1 of 8; AWAITING_APPROVAL is 4.
    const rails = list.projects.map((p: { rail: number }) => p.rail).sort();
    expect(rails).toEqual([1, 4]);
  });

  it("shows only the caller's own projects", async () => {
    await create(createBody(), OWNER);
    await create(createBody(), OTHER);
    const mine = await (await fetch(`${s.url}/projects`, { headers: authFor(OWNER) })).json();
    expect(mine.count).toBe(1);
  });
});

describe('AC-8 · events record the reference, never the token', () => {
  it('emits PROJECT_CREATED and CREDENTIAL_STORED with nothing sensitive', async () => {
    const { body } = await create();
    const events = await t.repos.events.since(body.projectId, 0);
    const types = events.map((e) => e.type);
    expect(types).toContain('PROJECT_CREATED');
    expect(types).toContain('CREDENTIAL_STORED');
    expect(JSON.stringify(events)).not.toContain(TOKEN);
    // CREDENTIAL_STORED is DETAIL — it belongs in the audit drawer, not the feed.
    expect(events.find((e) => e.type === 'CREDENTIAL_STORED')!.level).toBe('DETAIL');
  });
});

describe('AC-9 · required scopes are served to the create screen', () => {
  it('lists exactly what UX v1.2 asks the user to grant', async () => {
    const r = await (await fetch(`${s.url}/projects/required-scopes`, { headers: authFor(OWNER) })).json();
    expect(r.scopes).toEqual([
      'contents: read & write', 'pull_requests: write', 'metadata: read',
    ]);
  });
});

describe('FR-11 · project ids', () => {
  it('allocates sequentially and never reuses', async () => {
    const a = await create();
    const b = await create();
    expect(a.body.projectId).not.toBe(b.body.projectId);
    await fetch(`${s.url}/projects/${a.body.projectId}`, { method: 'DELETE', headers: authFor(OWNER) });
    const c = await create();
    expect(c.body.projectId).not.toBe(a.body.projectId);
  });
});

describe('a job that dies leaves a project that says so', () => {
  it('marks a project failed from whatever stage it was passing through', async () => {
    // The guarded `transition` only moved ANALYZING -> FAILED, so a clone that
    // failed while the project was still CREATED silently did nothing and left
    // it looking like it was still working.
    const created = await t.repos.projects.create(aProject({
      ownerId: OWNER, stage: 'CREATED',
    }) as never);

    await t.repos.projects.markFailed(created.projectId, 'could not clone: bad credentials');

    const after = await t.repos.projects.byId(created.projectId);
    expect(after?.stage).toBe('FAILED');
    expect(after?.failureReason).toBe('could not clone: bad credentials');
    // The reason has to reach the tile, which reads the summary line.
    expect(after?.summary.lastActivityText).toContain('could not clone');
  });

  it('clears actionRequired — a dead project is not waiting on anybody', async () => {
    const created = await t.repos.projects.create(aProject({
      ownerId: OWNER, stage: 'ANALYZING', actionRequired: true,
    }) as never);
    await t.repos.projects.markFailed(created.projectId, 'boom');
    expect((await t.repos.projects.byId(created.projectId))?.actionRequired).toBe(false);
  });

  it('truncates a reason rather than rejecting the write', async () => {
    // A stack trace from a crashed job is the common case, and losing the
    // failure entirely because the message was long is the wrong trade.
    const created = await t.repos.projects.create(aProject({ ownerId: OWNER }) as never);
    await t.repos.projects.markFailed(created.projectId, 'x'.repeat(5000));
    const after = await t.repos.projects.byId(created.projectId);
    expect(after?.stage).toBe('FAILED');
    expect(after?.failureReason?.length).toBe(2000);
  });
});

describe('editing an existing project', () => {
  const patch = (projectId: string, body: unknown) =>
    fetch(`${s.url}/projects/${projectId}`, {
      method: 'PATCH',
      headers: { ...authFor(OWNER), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('changes what it was asked to and reports which fields moved', async () => {
    const { body } = await create();
    const res = await patch(body.projectId, {
      name: 'Renamed', instructions: 'Prefer ML-KEM-768.',
    });
    expect(res.status).toBe(200);

    const after = await t.repos.projects.byId(body.projectId);
    expect(after?.name).toBe('Renamed');
    expect(after?.instructions).toBe('Prefer ML-KEM-768.');
    // The event names the fields — "the project was updated" is worth much less.
    const events = await t.repos.events.find({ projectId: body.projectId } as never);
    const updated = events.find((e) => e.type === 'PROJECT_UPDATED');
    expect(updated?.title).toContain('name');
    expect(updated?.title).toContain('instructions');
  });

  it('cannot change the repository, because every finding points into it', async () => {
    const { body } = await create();
    await patch(body.projectId, { repositoryUrl: 'https://github.com/someone/else' });
    const after = await t.repos.projects.byId(body.projectId);
    // Ignored rather than rejected: the field is simply not in the input schema,
    // so there is no way to express the request at all.
    expect(after?.repository.url).toBe(body.repository.url);
  });

  it('leaves the stored credential alone when no token is sent', async () => {
    const { body } = await create();
    const before = (await t.repos.projects.byId(body.projectId))!.repository.credential;
    await patch(body.projectId, { name: 'Just a rename' });
    const after = (await t.repos.projects.byId(body.projectId))!.repository.credential;
    expect(after?.secretVersion).toBe(before?.secretVersion);
  });

  it('stores a replacement token as a new version, and never returns it', async () => {
    const { body } = await create();
    const before = (await t.repos.projects.byId(body.projectId))!.repository.credential;

    const replacement = `github_pat_${'b'.repeat(30)}`;
    const res = await patch(body.projectId, { githubToken: replacement });
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain(replacement);

    const after = (await t.repos.projects.byId(body.projectId))!.repository.credential;
    expect(after?.secretVersion).not.toBe(before?.secretVersion);
    expect(after?.displayPrefix).toBe(replacement.slice(0, 12));

    // The rule that holds everywhere: no document anywhere carries the value.
    for (const c of await t.repos.db.listCollections().toArray()) {
      const docs = await t.repos.db.collection(c.name).find({}).toArray();
      expect(JSON.stringify(docs), c.name).not.toContain(replacement);
    }
  });

  it('refuses a token that is not a GitHub token, naming the field only', async () => {
    const { body } = await create();
    const res = await patch(body.projectId, { githubToken: 'not-a-token-but-long-enough-x' });
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain('not-a-token');
  });
});

describe('re-running discovery', () => {
  const rediscover = (projectId: string) =>
    fetch(`${s.url}/projects/${projectId}/rediscover`, {
      method: 'POST',
      headers: { ...authFor(OWNER), 'content-type': 'application/json' },
      body: '{}',
    });

  it('restarts analysis from a finished assessment', async () => {
    const { body } = await create();
    await t.repos.projects.collection.updateOne(
      { projectId: body.projectId } as never,
      { $set: { stage: 'ASSESSMENT_READY', 'summary.discoveryComplete': true } as never },
    );

    expect((await rediscover(body.projectId)).status).toBe(202);
    // The job is actually handed the project, not merely acknowledged.
    expect(s.discoveryStarts).toContain(body.projectId);
    const after = await t.repos.projects.byId(body.projectId);
    expect(after?.stage).toBe('ANALYZING');
    // The flag drives the nav and the hand-off banner; leaving it true would
    // show "discovery complete" over a run that had just restarted.
    expect(after?.summary.discoveryComplete).toBe(false);
  });

  it('refuses while a migration is under way', async () => {
    const { body } = await create();
    await t.repos.projects.collection.updateOne(
      { projectId: body.projectId } as never, { $set: { stage: 'MIGRATING' } as never },
    );
    const res = await rediscover(body.projectId);
    // The baseline was captured against the findings that exist now.
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('baseline');
  });
});
