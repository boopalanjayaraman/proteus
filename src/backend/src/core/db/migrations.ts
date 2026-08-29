import { COLLECTIONS } from '@proteus/schema';
import type { Db } from 'mongodb';

/**
 * Backfills for fields added to documents that already exist.
 *
 * The hazard these exist for: `Repository.findOne` returns the raw Mongo
 * document and does **not** run it through Zod, so a `.default()` on a new field
 * applies to writes and never to reads. Every document written before the field
 * existed comes back with it `undefined`, and any code that compares against a
 * literal — `lifecycle === 'ACTIVE'` — silently takes the wrong branch.
 *
 * Adding a defaulted field to an existing schema therefore needs a backfill
 * here as well as the default. Tests never catch it, because a test fixture is
 * always written through `insert`, which does parse.
 */

export interface BackfillResult {
  lifecycle: number;
}

export async function runBackfills(database: Db): Promise<BackfillResult> {
  // PRD-17. Without this, every project created before the field existed reads
  // as `lifecycle: undefined`, which `assertMutable` treats as not-ACTIVE — so
  // the whole product goes read-only for exactly the projects that predate it.
  const lifecycle = await database.collection(COLLECTIONS.projects).updateMany(
    { lifecycle: { $exists: false } },
    { $set: { lifecycle: 'ACTIVE' } },
  );

  return { lifecycle: lifecycle.modifiedCount };
}
