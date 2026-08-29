import { COLLECTIONS, INDEXES, type IndexSpec } from '@proteus/schema';
import type { Db } from 'mongodb';

/**
 * Creates every index in the data model, idempotently.
 *
 * Run at startup. `createIndex` is a no-op when an identical index exists, so
 * repeated starts are free; a *changed* definition under an existing name is an
 * error rather than a silent divergence, which is what we want to hear about.
 */
export async function ensureIndexes(database: Db): Promise<{ created: number; collections: number }> {
  let created = 0;
  let collections = 0;

  for (const [collection, specs] of Object.entries(INDEXES) as [string, IndexSpec[]][]) {
    if (specs.length === 0) continue;
    collections++;
    for (const spec of specs) {
      await database.collection(collection).createIndex(spec.key, {
        name: spec.name,
        ...(spec.unique ? { unique: true } : {}),
        ...(spec.sparse ? { sparse: true } : {}),
        ...(spec.expireAfterSeconds !== undefined
          ? { expireAfterSeconds: spec.expireAfterSeconds }
          : {}),
      });
      created++;
    }
  }
  return { created, collections };
}

/** Every collection the model defines, for a fresh-database bootstrap. */
export function allCollections(): string[] {
  return Object.values(COLLECTIONS);
}
