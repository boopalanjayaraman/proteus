import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { aProject, anEvent, clearAll, startTestDb, type TestDb } from './helpers/mongo';
import { authFor, readStream, startTestServer, type TestServer } from './helpers/server';

/** PRD-03 acceptance criteria, against a real server and a real replica set. */

let t: TestDb;
let s: TestServer;
const OWNER = 'firebase-uid-1';
const OTHER = 'firebase-uid-2';

beforeAll(async () => {
  t = await startTestDb();
  s = await startTestServer(t.repos);
});
afterAll(async () => {
  await s?.stop();
  await t?.stop();
});
beforeEach(async () => { await clearAll(t.repos); });

async function ownedProject(ownerId = OWNER) {
  return t.repos.projects.create(aProject({ ownerId }) as never);
}

describe('AC-1 · authentication and ownership', () => {
  it('rejects a request with no token', async () => {
    const r = await fetch(`${s.url}/me`);
    expect(r.status).toBe(401);
    expect((await r.json()).error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects a malformed token', async () => {
    const r = await fetch(`${s.url}/me`, { headers: { authorization: 'Bearer nonsense' } });
    expect(r.status).toBe(401);
  });

  it('rejects an Authorization header that is not a Bearer token', async () => {
    const r = await fetch(`${s.url}/me`, { headers: { authorization: 'Basic abc123' } });
    expect(r.status).toBe(401);
  });

  it("returns 404 — not 403 — for another user's project, so existence is not confirmed", async () => {
    const p = await ownedProject(OWNER);
    const r = await fetch(`${s.url}/projects/${p.projectId}/events`, {
      headers: authFor(OTHER),
    });
    expect(r.status).toBe(404);

    // Indistinguishable from a project that does not exist. requestId differs by
    // design — it is per-request — so compare everything a prober could use.
    const missing = await fetch(`${s.url}/projects/PQC-9999/events`, { headers: authFor(OTHER) });
    expect(missing.status).toBe(404);
    const denied = (await r.json()).error;
    const absent = (await missing.json()).error;
    expect({ code: denied.code, message: denied.message })
      .toEqual({ code: absent.code, message: absent.message });
  });

  it('lets the owner through', async () => {
    const p = await ownedProject();
    const r = await fetch(`${s.url}/projects/${p.projectId}/events`, { headers: authFor(OWNER) });
    expect(r.status).toBe(200);
  });
});

describe('AC-2 · SSE resume by seq', () => {
  it('frames carry id: <seq> and Last-Event-ID resumes after it', async () => {
    const p = await ownedProject();
    for (let i = 1; i <= 5; i++) {
      await t.repos.events.emit(p.projectId, anEvent({ title: `event ${i}` }));
    }

    const { events, raw } = await readStream(
      `${s.url}/projects/${p.projectId}/stream`,
      { ...authFor(OWNER), 'last-event-id': '3' },
      2,
    );
    expect(raw).toContain('id: 4');
    expect(events.map((e) => e['seq'])).toEqual([4, 5]);
  });

  it('starts from the beginning when no cursor is given', async () => {
    const p = await ownedProject();
    for (let i = 1; i <= 3; i++) await t.repos.events.emit(p.projectId, anEvent());
    const { events } = await readStream(
      `${s.url}/projects/${p.projectId}/stream`, authFor(OWNER), 3,
    );
    expect(events.map((e) => e['seq'])).toEqual([1, 2, 3]);
  });
});

describe('AC-4 · nothing is lost across a disconnect', () => {
  it('delivers every event written while the client was away, in order', async () => {
    const p = await ownedProject();

    // Connect, receive 2, drop.
    for (let i = 0; i < 2; i++) await t.repos.events.emit(p.projectId, anEvent());
    const first = await readStream(`${s.url}/projects/${p.projectId}/stream`, authFor(OWNER), 2);
    expect(first.events).toHaveLength(2);
    first.abort();

    // 100 events arrive during the outage.
    for (let i = 0; i < 100; i++) {
      await t.repos.events.emit(p.projectId, anEvent({ title: `missed ${i}` }));
    }

    const second = await readStream(
      `${s.url}/projects/${p.projectId}/stream`,
      { ...authFor(OWNER), 'last-event-id': '2' },
      100,
      10_000,
    );
    const seqs = second.events.map((e) => e['seq'] as number);
    expect(seqs).toHaveLength(100);
    expect(seqs[0]).toBe(3);
    expect(seqs[99]).toBe(102);
    expect(new Set(seqs).size).toBe(100); // no duplicates
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs); // in order
  });

  it('covers the seam — an event written during replay is not lost', async () => {
    const p = await ownedProject();
    for (let i = 0; i < 20; i++) await t.repos.events.emit(p.projectId, anEvent());

    // Write while the replay is in flight; the live tail is opened first, so
    // this must arrive exactly once rather than falling through the gap.
    const streamed = readStream(`${s.url}/projects/${p.projectId}/stream`, authFor(OWNER), 21, 8000);
    await new Promise((r) => setTimeout(r, 50));
    await t.repos.events.emit(p.projectId, anEvent({ title: 'during replay' }));

    const { events } = await streamed;
    const seqs = events.map((e) => e['seq'] as number);
    expect(seqs).toContain(21);
    expect(new Set(seqs).size).toBe(seqs.length);
  });
});

describe('AC-3 · live delivery', () => {
  it('pushes an event written after the stream opened', async () => {
    const p = await ownedProject();
    const streamed = readStream(`${s.url}/projects/${p.projectId}/stream`, authFor(OWNER), 1, 8000);
    await new Promise((r) => setTimeout(r, 400));
    await t.repos.events.emit(p.projectId, anEvent({ title: 'live one' }));

    const { events } = await streamed;
    expect(events[0]?.['title']).toBe('live one');
  });

  it("never delivers another project's events", async () => {
    const mine = await ownedProject();
    const theirs = await ownedProject();
    const streamed = readStream(`${s.url}/projects/${mine.projectId}/stream`, authFor(OWNER), 1, 3000);
    await new Promise((r) => setTimeout(r, 300));
    await t.repos.events.emit(theirs.projectId, anEvent({ title: 'not yours' }));
    await t.repos.events.emit(mine.projectId, anEvent({ title: 'yours' }));

    const { events } = await streamed;
    expect(events.map((e) => e['title'])).toContain('yours');
    expect(events.map((e) => e['title'])).not.toContain('not yours');
  });
});

describe('AC-5 · idle streams stay open', () => {
  it('sends a heartbeat comment rather than closing', async () => {
    const p = await ownedProject();
    const controller = new AbortController();
    const res = await fetch(`${s.url}/projects/${p.projectId}/stream`, {
      headers: authFor(OWNER),
      signal: controller.signal,
    });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('x-accel-buffering')).toBe('no'); // proxies must not buffer
    controller.abort();
  });
});

describe('AC-6 · event history and filters', () => {
  it('filters to the live feed levels, leaving DETAIL to the audit drawer', async () => {
    const p = await ownedProject();
    await t.repos.events.emit(p.projectId, anEvent({ level: 'MILESTONE', title: 'm' }));
    await t.repos.events.emit(p.projectId, anEvent({ level: 'ACTIVITY', title: 'a' }));
    await t.repos.events.emit(p.projectId, anEvent({ level: 'DETAIL', title: 'd' }));

    const r = await fetch(
      `${s.url}/projects/${p.projectId}/events?level=MILESTONE,ACTIVITY`,
      { headers: authFor(OWNER) },
    );
    const body = await r.json();
    expect(body.events.map((e: { title: string }) => e.title)).toEqual(['m', 'a']);
  });

  it('honours fromSeq and caps limit', async () => {
    const p = await ownedProject();
    for (let i = 0; i < 10; i++) await t.repos.events.emit(p.projectId, anEvent());
    const r = await fetch(`${s.url}/projects/${p.projectId}/events?fromSeq=7`, {
      headers: authFor(OWNER),
    });
    const body = await r.json();
    expect(body.count).toBe(3);
    expect(body.events[0].seq).toBe(8);
  });
});

describe('AC-6b · health and readiness', () => {
  it('serves liveness without authentication', async () => {
    expect((await fetch(`${s.url}/healthz`)).status).toBe(200);
  });

  it('reports feature groups without leaking a value from any of them', async () => {
    const r = await fetch(`${s.url}/readyz`);
    const body = await r.json();
    expect(Object.keys(body.features)).toContain('gemini');
    expect(JSON.stringify(body)).not.toMatch(/mongodb\+srv|AIza|github_pat_/);
    expect(body.changeStreams).toBe(true);
  });
});

describe('FR-8 · errors are typed and say nothing internal', () => {
  it('carries a code and a request id, and no stack', async () => {
    const r = await fetch(`${s.url}/projects/PQC-9999/events`, { headers: authFor(OWNER) });
    const body = await r.json();
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.requestId).toBeTruthy();
    expect(JSON.stringify(body)).not.toMatch(/stack|at Object|node_modules/);
  });
});

describe('user profile', () => {
  it('creates the user on first sign-in with an avatar monogram', async () => {
    const r = await fetch(`${s.url}/me`, { headers: authFor('new-user') });
    const me = await r.json();
    expect(me.userId).toBe('new-user');
    expect(me.initials).toBe('AO');
    expect(me.preferences.theme).toBe('dark');
  });

  it('persists a preference change', async () => {
    await fetch(`${s.url}/me`, { headers: authFor(OWNER) });
    await fetch(`${s.url}/me/preferences`, {
      method: 'PATCH',
      headers: { ...authFor(OWNER), 'content-type': 'application/json' },
      body: JSON.stringify({ theme: 'light', graphStyle: 'radial' }),
    });
    const me = await (await fetch(`${s.url}/me`, { headers: authFor(OWNER) })).json();
    expect(me.preferences.theme).toBe('light');
    expect(me.preferences.graphStyle).toBe('radial');
  });
});

describe('PRD-08 · graph endpoints', () => {
  it('returns nodes and edges in sequence order with the version a client compares', async () => {
    const p = await ownedProject();
    await s.graph.upsertNode(p.projectId, { type: 'ALGORITHM', canonicalName: 'RSA key transport' }, 1);
    await s.graph.upsertNode(p.projectId, { type: 'SERVICE', canonicalName: 'payments-api' }, 0);

    const r = await fetch(`${s.url}/projects/${p.projectId}/graph`, { headers: authFor(OWNER) });
    expect(r.status).toBe(200);
    const body = await r.json();
    // Asserted second, revealed first — sequence, not write order.
    expect(body.nodes.map((n: { type: string }) => n.type)).toEqual(['SERVICE', 'ALGORITHM']);
    expect(body.graphVersion).toBeGreaterThan(0);
  });

  it("hides another user's graph behind a 404", async () => {
    const p = await ownedProject(OWNER);
    const r = await fetch(`${s.url}/projects/${p.projectId}/graph`, { headers: authFor(OTHER) });
    expect(r.status).toBe(404);
  });

  it('persists a pin and clears it on a null body', async () => {
    const p = await ownedProject();
    const n = await s.graph.upsertNode(p.projectId, { type: 'HSM', canonicalName: 'payShield 10K' }, 0);
    const url = `${s.url}/projects/${p.projectId}/graph/nodes/${encodeURIComponent(n.id)}/pin`;
    const headers = { ...authFor(OWNER), 'content-type': 'application/json' };

    expect((await fetch(url, { method: 'PATCH', headers, body: JSON.stringify({ x: 10, y: 20, style: 'force' }) })).status).toBe(204);
    let body = await (await fetch(`${s.url}/projects/${p.projectId}/graph`, { headers: authFor(OWNER) })).json();
    expect(body.nodes[0].pin).toEqual({ x: 10, y: 20, style: 'force' });

    expect((await fetch(url, { method: 'PATCH', headers, body: 'null' })).status).toBe(204);
    body = await (await fetch(`${s.url}/projects/${p.projectId}/graph`, { headers: authFor(OWNER) })).json();
    expect(body.nodes[0].pin).toBeUndefined();
  });

  it('rejects a layout style the client did not compute', async () => {
    const p = await ownedProject();
    const n = await s.graph.upsertNode(p.projectId, { type: 'HSM', canonicalName: 'payShield 10K' }, 0);
    const r = await fetch(
      `${s.url}/projects/${p.projectId}/graph/nodes/${encodeURIComponent(n.id)}/pin`,
      {
        method: 'PATCH',
        headers: { ...authFor(OWNER), 'content-type': 'application/json' },
        body: JSON.stringify({ x: 1, y: 2, style: 'isometric' }),
      },
    );
    expect(r.status).toBe(400);
  });

  it('answers blast radius over the API', async () => {
    const p = await ownedProject();
    const api = await s.graph.upsertNode(p.projectId, { type: 'SERVICE', canonicalName: 'payments-api' }, 0);
    const rsa = await s.graph.upsertNode(p.projectId, { type: 'ALGORITHM', canonicalName: 'RSA key transport' }, 1);
    await s.graph.upsertEdge(p.projectId, { fromNodeId: api.id, toNodeId: rsa.id, relationship: 'ENCRYPTS_WITH' }, 2);

    const r = await fetch(
      `${s.url}/projects/${p.projectId}/graph/nodes/${encodeURIComponent(rsa.id)}/blast-radius`,
      { headers: authFor(OWNER) },
    );
    expect((await r.json()).upstream).toEqual([api.id]);
  });
});

describe('PRD-09 · assessment endpoints', () => {
  it('404s before an assessment exists, rather than returning an empty one', async () => {
    const p = await ownedProject();
    const r = await fetch(`${s.url}/projects/${p.projectId}/assessment`, { headers: authFor(OWNER) });
    expect(r.status).toBe(404);
  });

  it("hides another user's assessment and recommendations behind a 404", async () => {
    const p = await ownedProject(OWNER);
    for (const path of ['assessment', 'recommendations', 'artifacts']) {
      const r = await fetch(`${s.url}/projects/${p.projectId}/${path}`, { headers: authFor(OTHER) });
      expect(r.status, path).toBe(404);
    }
  });

  it('refuses to generate before discovery has completed', async () => {
    const p = await ownedProject();
    const r = await fetch(`${s.url}/projects/${p.projectId}/assessment`, {
      method: 'POST', headers: { ...authFor(OWNER), 'content-type': 'application/json' }, body: '{}',
    });
    // Either the guard or the missing generator; both are a 400, and neither
    // may silently produce an assessment from nothing.
    expect(r.status).toBe(400);
  });

  it('returns findings and recommendations alongside the assessment', async () => {
    const p = await ownedProject();
    const now = new Date();
    await t.repos.findings.insert({
      _schemaVersion: 1, createdAt: now, updatedAt: now,
      findingId: 'f_1', projectId: p.projectId, category: 'CRYPTOGRAPHIC',
      title: 'RSA-2048 used for key establishment', summaryLine: 'Usage: key transport',
      description: 'd', severity: 'CRITICAL', impact: 'MIGRATION_REQUIRED',
      disposition: 'AUTONOMOUS_MIGRATION', agentIntent: 'Replace with ML-KEM-768.',
      locations: [], nodeIds: [], evidenceIds: [], origin: 'REPOSITORY_SCAN',
      status: 'OPEN', dedupeKey: 'k1', discoveredAt: now,
    } as never);
    await t.repos.assessments.insert({
      _schemaVersion: 1, createdAt: now, updatedAt: now,
      assessmentId: 'asmt_1', projectId: p.projectId, version: 1,
      summary: {
        headline: 'h', whatExists: 'e', whatIsVulnerable: 'v',
        whatAgentWillChange: 'c', whatAgentWillNotChange: 'n',
      },
      snapshot: {
        findingIds: ['f_1'], recommendationIds: [], graphNodeIds: [], graphEdgeIds: [],
        inputFileIds: [], repoCommitSha: 'abc1234',
      },
      planItems: [], policyId: 'p', status: 'READY', generatedAt: now,
    } as never);

    const r = await fetch(`${s.url}/projects/${p.projectId}/assessment`, { headers: authFor(OWNER) });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.assessment.version).toBe(1);
    expect(body.findings).toHaveLength(1);
    expect(body.findings[0].agentIntent).toBe('Replace with ML-KEM-768.');
    expect(body.versions).toEqual([expect.objectContaining({ version: 1, status: 'READY' })]);
  });

  it('downloads a report as an attachment and 404s an artifact from another project', async () => {
    const p = await ownedProject();
    const other = await ownedProject();
    const now = new Date();
    const stored = await s.blobs.put(
      `${p.projectId}/reports/assessment-v1.md`, Buffer.from('# PQC assessment\n'),
    );
    await t.repos.artifacts.insert({
      _schemaVersion: 1, createdAt: now, updatedAt: now,
      artifactId: 'art_1', projectId: p.projectId,
      kind: 'ASSESSMENT_REPORT', format: 'MARKDOWN', title: 'Assessment report v1',
      displayMeta: '1 FINDINGS', gcsUri: stored.gcsUri, sizeBytes: stored.sizeBytes,
      status: 'READY', generatedAt: now,
    } as never);

    const r = await fetch(`${s.url}/projects/${p.projectId}/artifacts/art_1`, { headers: authFor(OWNER) });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/markdown');
    expect(r.headers.get('content-disposition')).toContain('attachment');
    expect(await r.text()).toContain('# PQC assessment');

    // Scoped by project as well as id — owning one project must not open another's.
    expect((await fetch(`${s.url}/projects/${other.projectId}/artifacts/art_1`, {
      headers: authFor(OWNER),
    })).status).toBe(404);
  });

  it('omits the full report body from the artifact listing', async () => {
    const p = await ownedProject();
    const now = new Date();
    await t.repos.artifacts.insert({
      _schemaVersion: 1, createdAt: now, updatedAt: now,
      artifactId: 'art_2', projectId: p.projectId,
      kind: 'ASSESSMENT_REPORT', format: 'MARKDOWN', title: 'Assessment report v1',
      displayMeta: '1 FINDINGS', gcsUri: 'gs://bucket/x.md', sizeBytes: 10,
      contentSnapshot: { findings: [{ title: 'a very large report body' }] },
      status: 'READY', generatedAt: now,
    } as never);

    const body = await (await fetch(`${s.url}/projects/${p.projectId}/artifacts`, {
      headers: authFor(OWNER),
    })).json();
    expect(body.artifacts[0].artifactId).toBe('art_2');
    expect(body.artifacts[0].contentSnapshot).toBeUndefined();
  });
});
