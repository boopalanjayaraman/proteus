import { PROJECT_COUNTER_ID, eventCounterId, formatProjectId } from '@proteus/schema';
import type { Db } from 'mongodb';
import { COLLECTIONS } from '@proteus/schema';

/**
 * Monotonic sequence allocation.
 *
 * `findOneAndUpdate` with `$inc` is atomic in Mongo, so concurrent callers each
 * receive a distinct value with no gaps — which is what makes the event `seq`
 * usable as an SSE resume cursor. A gap would look to a reconnecting client like
 * an event it had already seen.
 */
export async function nextSequence(database: Db, counterId: string): Promise<number> {
  const result = await database.collection<{ _id: string; seq: number }>(COLLECTIONS.counters)
    .findOneAndUpdate(
      { _id: counterId },
      { $inc: { seq: 1 } },
      { upsert: true, returnDocument: 'after' },
    );
  if (!result) throw new Error(`counter ${counterId} did not return a value`);
  return result.seq;
}

/** `PQC-0184`. Allocated once; ids are never reused. */
export async function nextProjectId(database: Db): Promise<string> {
  return formatProjectId(await nextSequence(database, PROJECT_COUNTER_ID));
}

/** Per-project event sequence. */
export async function nextEventSeq(database: Db, projectId: string): Promise<number> {
  return nextSequence(database, eventCounterId(projectId));
}
