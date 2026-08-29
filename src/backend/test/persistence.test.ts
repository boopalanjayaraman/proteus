import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ValidationError } from '../src/core/repositories';
import { nextProjectId } from '../src/core/db/counters';
import { StaleProjectError } from '../src/core/repositories/projects';
import { aProject, anEvent, clearAll, startTestDb, type TestDb } from './helpers/mongo';

/** PRD-02 acceptance criteria, against a real replica set. */

let t: TestDb;
beforeAll(async () => { t = await startTestDb(); });
afterAll(async () => { await t?.stop(); });
beforeEach(async () => { await clearAll(t.repos); });

describe('AC-1 · event sequence is gapless under concurrency', () => {
  it('1,000 concurrent writes produce seq 1..1000 exactly once each', async () => {
    const { events } = t.repos;
    await Promise.all(
      Array.from({ length: 1000 }, (_, i) =>
        events.emit('PQC-0001', anEvent({ title: `finding ${i}` })),
      ),
    );
    const all = await events.since('PQC-0001', 0, 2000);
    const seqs = all.map((e) => e.seq).sort((a, b) => a - b);
    expect(seqs).toHaveLength(1000);
    expect(new Set(seqs).size).toBe(1000);
    expect(seqs[0]).toBe(1);
    expect(seqs[999]).toBe(1000);
  });

  it('keeps sequences separate per project', async () => {
    const { events } = t.repos;
    await events.emit('PQC-0001', anEvent());
    await events.emit('PQC-0002', anEvent());
    await events.emit('PQC-0001', anEvent());
    expect((await events.since('PQC-0001', 0)).map((e) => e.seq)).toEqual([1, 2]);
    expect((await events.since('PQC-0002', 0)).map((e) => e.seq)).toEqual([1]);
  });
});

describe('AC-2 · idempotency', () => {
  it('the same key written twice yields one document', async () => {
    const { events } = t.repos;
    const a = await events.emit('PQC-0001', anEvent({ idempotencyKey: 'clone-done' }));
    const b = await events.emit('PQC-0001', anEvent({ idempotencyKey: 'clone-done' }));
    expect(b.eventId).toBe(a.eventId);
    expect(await events.count({ projectId: 'PQC-0001' } as never)).toBe(1);
  });

  it('survives a concurrent race on the same key', async () => {
    const { events } = t.repos;
    await Promise.all(
      Array.from({ length: 10 }, () =>
        events.emit('PQC-0001', anEvent({ idempotencyKey: 'branch-created' })),
      ),
    );
    expect(await events.count({ projectId: 'PQC-0001' } as never)).toBe(1);
  });
});

describe('AC-3 · guarded stage transitions', () => {
  it('one of two concurrent writers wins and the other is told', async () => {
    const { projects } = t.repos;
    const p = await projects.create(aProject() as never);

    const results = await Promise.allSettled([
      projects.transition(p.projectId, 'CREATED', 'ANALYZING'),
      projects.transition(p.projectId, 'CREATED', 'FAILED'),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');

    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect((failed[0] as PromiseRejectedResult).reason).toBeInstanceOf(StaleProjectError);
  });

  it('increments version and refuses a transition from the wrong stage', async () => {
    const { projects } = t.repos;
    const p = await projects.create(aProject() as never);
    const moved = await projects.transition(p.projectId, 'CREATED', 'ANALYZING');
    expect(moved.version).toBe(1);
    await expect(projects.transition(p.projectId, 'CREATED', 'MIGRATING')).rejects.toThrow(
      StaleProjectError,
    );
  });
});

describe('AC-4 · leases', () => {
  it('refuses a second acquirer while the lease is live, and allows it after expiry', async () => {
    const { migrationRuns, migrationLease } = t.repos;
    await migrationRuns.collection.insertOne({ migrationRunId: 'run-1' } as never);

    expect(await migrationLease.acquire('run-1', 'worker-a', { ttlMs: 250 })).toBe(true);
    expect(await migrationLease.acquire('run-1', 'worker-b', { ttlMs: 250 })).toBe(false);
    expect(await migrationLease.currentHolder('run-1')).toBe('worker-a');

    await new Promise((r) => setTimeout(r, 350));
    expect(await migrationLease.acquire('run-1', 'worker-b', { ttlMs: 250 })).toBe(true);
  });

  it('lets the holder refresh, and refuses a refresh from anyone else', async () => {
    const { migrationRuns, migrationLease } = t.repos;
    await migrationRuns.collection.insertOne({ migrationRunId: 'run-2' } as never);
    await migrationLease.acquire('run-2', 'worker-a');
    expect(await migrationLease.refresh('run-2', 'worker-a')).toBe(true);
    expect(await migrationLease.refresh('run-2', 'worker-b')).toBe(false);
  });

  it('reports leases whose holder died, for the reaper', async () => {
    const { migrationRuns, migrationLease } = t.repos;
    await migrationRuns.collection.insertOne({ migrationRunId: 'run-3' } as never);
    await migrationLease.acquire('run-3', 'worker-a', { ttlMs: 1 });
    await new Promise((r) => setTimeout(r, 50));
    expect(await migrationLease.expired()).toContain('run-3');
  });
});

describe('AC-5 · change stream fan-out', () => {
  it('delivers a projects own events and nothing else', async () => {
    const { events } = t.repos;
    const seen: string[] = [];
    const stream = events.watch('PQC-0001', (e) => seen.push(e.title));
    await new Promise((r) => setTimeout(r, 300)); // let the stream establish

    await events.emit('PQC-0001', anEvent({ title: 'mine' }));
    await events.emit('PQC-0002', anEvent({ title: 'someone elses' }));
    await new Promise((r) => setTimeout(r, 800));
    await stream.close();

    expect(seen).toContain('mine');
    expect(seen).not.toContain('someone elses');
  });
});

describe('AC-6 · redaction at the write boundary', () => {
  it('strips a token from an event before it is stored', async () => {
    const { events } = t.repos;
    const token = 'github_pat_11ABCDEFGH0123456789_abcdefghijklmnopqrstuvwxyz012345';
    await events.emit('PQC-0001', anEvent({
      title: 'cloning repository',
      message: `git clone https://${token}@github.com/a/b`,
    }));
    const [stored] = await events.since('PQC-0001', 0);
    expect(stored!.message).not.toContain(token);
    expect(stored!.message).toContain('[REDACTED]');
  });
});

describe('AC-7 · indexes are idempotent', () => {
  it('a second startup does not fail', async () => {
    const { ensureIndexes } = await import('../src/core/db/indexes');
    const first = await ensureIndexes(t.repos.db);
    const second = await ensureIndexes(t.repos.db);
    expect(second.created).toBe(first.created);
  });

  it('enforces the unique constraints the model declares', async () => {
    const { events } = t.repos;
    await events.emit('PQC-0001', anEvent());
    // projectId+seq is unique: a hand-written duplicate must be refused.
    await expect(
      events.collection.insertOne({ projectId: 'PQC-0001', seq: 1 } as never),
    ).rejects.toThrow();
  });
});

describe('FR-1 · writes are validated', () => {
  it('refuses a document that does not satisfy its schema', async () => {
    const { projects } = t.repos;
    await expect(
      projects.insert(aProject({ stage: 'NOT_A_STAGE' }) as never),
    ).rejects.toThrow(ValidationError);
  });
});

describe('FR-9 · project ids', () => {
  it('allocates PQC-#### and never reuses one', async () => {
    const ids = await Promise.all(
      Array.from({ length: 20 }, () => nextProjectId(t.repos.db)),
    );
    expect(new Set(ids).size).toBe(20);
    expect(ids.every((id) => /^PQC-\d{4,}$/.test(id))).toBe(true);
  });
});

describe('FR-10 · state survives a restart with no replay', () => {
  it('rehydrates stage, summary and phase pointers from one read', async () => {
    const { projects, events } = t.repos;
    const p = await projects.create(aProject() as never);
    await projects.transition(p.projectId, 'CREATED', 'ANALYZING', {
      current: { discoveryRunId: 'disc-1' },
    } as never);
    await events.emit(p.projectId, anEvent({ level: 'MILESTONE' }));
    await projects.touchActivity(p.projectId, 'Analyzing CryptoService');
    await projects.setLastEventSeq(p.projectId, 1);

    // A cold read is all a reopening client needs.
    const reloaded = await projects.byId(p.projectId);
    expect(reloaded!.stage).toBe('ANALYZING');
    expect(reloaded!.current.discoveryRunId).toBe('disc-1');
    expect(reloaded!.summary.lastActivityText).toBe('Analyzing CryptoService');
    expect(reloaded!.lastEventSeq).toBe(1);
  });

  it('never moves the resume cursor backwards', async () => {
    const { projects } = t.repos;
    const p = await projects.create(aProject() as never);
    await projects.setLastEventSeq(p.projectId, 40);
    await projects.setLastEventSeq(p.projectId, 12); // a slow emitter arriving late
    expect((await projects.byId(p.projectId))!.lastEventSeq).toBe(40);
  });
});
