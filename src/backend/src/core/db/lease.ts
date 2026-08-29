import type { Collection, Db, Filter } from 'mongodb';

/**
 * Single-writer leases for long-running work.
 *
 * A migration outlives the request that approved it and the browser that watched
 * it start. Cloud Run can evict the worker mid-run, and a double-clicked Approve
 * or a scale-out can produce a second one. The lease is what stops two workers
 * driving the same run: acquiring requires the lease to be absent or expired,
 * and it is a single atomic update, so exactly one contender wins.
 */

export interface LeaseOptions {
  /** How long a lease survives without a refresh. */
  ttlMs?: number;
}

const DEFAULT_TTL_MS = 60_000;

export class LeaseHeldError extends Error {
  constructor(id: string, holder: string) {
    super(`lease on ${id} is held by ${holder}`);
    this.name = 'LeaseHeldError';
  }
}

export class LeaseManager {
  constructor(
    private readonly database: Db,
    private readonly collectionName: string,
    private readonly idField: string,
  ) {}

  private get collection(): Collection {
    return this.database.collection(this.collectionName);
  }

  /**
   * Takes the lease if it is free or expired.
   *
   * @returns true when acquired. False means someone else holds it and is alive.
   */
  async acquire(id: string, holder: string, opts: LeaseOptions = {}): Promise<boolean> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + (opts.ttlMs ?? DEFAULT_TTL_MS));

    const filter = {
      [this.idField]: id,
      $or: [
        { lease: { $exists: false } },
        { lease: null },
        { 'lease.expiresAt': { $lte: now } },
        { 'lease.holder': holder }, // re-entrant for the current holder
      ],
    } as unknown as Filter<Document>;

    const r = await this.collection.updateOne(filter, {
      $set: { lease: { holder, expiresAt } },
    });
    return r.matchedCount > 0;
  }

  /** Extends a lease this holder owns. False means it was lost. */
  async refresh(id: string, holder: string, opts: LeaseOptions = {}): Promise<boolean> {
    const expiresAt = new Date(Date.now() + (opts.ttlMs ?? DEFAULT_TTL_MS));
    const r = await this.collection.updateOne(
      { [this.idField]: id, 'lease.holder': holder } as unknown as Filter<Document>,
      { $set: { 'lease.expiresAt': expiresAt } },
    );
    return r.matchedCount > 0;
  }

  async release(id: string, holder: string): Promise<void> {
    await this.collection.updateOne(
      { [this.idField]: id, 'lease.holder': holder } as unknown as Filter<Document>,
      { $unset: { lease: '' } },
    );
  }

  async currentHolder(id: string): Promise<string | null> {
    const doc = (await this.collection.findOne({
      [this.idField]: id,
    } as unknown as Filter<Document>)) as { lease?: { holder: string; expiresAt: Date } } | null;
    if (!doc?.lease) return null;
    return doc.lease.expiresAt > new Date() ? doc.lease.holder : null;
  }

  /** Runs whose holder died mid-flight — the reaper's query. */
  async expired(limit = 20): Promise<string[]> {
    const docs = await this.collection
      .find({ 'lease.expiresAt': { $lte: new Date() } } as unknown as Filter<Document>)
      .limit(limit)
      .toArray();
    return docs.map((d) => String((d as Record<string, unknown>)[this.idField]));
  }
}

type Document = Record<string, unknown>;
