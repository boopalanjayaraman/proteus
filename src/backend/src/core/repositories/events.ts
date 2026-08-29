import {
  COLLECTIONS,
  ProjectEvent,
  redactTokens,
  type EmitEventInput,
} from '@proteus/schema';
import type { Db } from 'mongodb';
import { nextEventSeq } from '../db/counters';
import { Repository } from './base';

/**
 * The append-only event log.
 *
 * `seq` is what makes the stream resumable: every SSE frame carries it as its
 * `id`, and a reconnecting browser's `Last-Event-ID` is all the server needs to
 * replay exactly what was missed. That only works if the sequence is gapless,
 * which is why it comes from an atomic counter rather than a document count.
 */
export class EventRepository extends Repository<typeof ProjectEvent> {
  constructor(database: Db) {
    super(database, COLLECTIONS.events, ProjectEvent);
  }

  /**
   * Allocates a sequence number and appends.
   *
   * An `idempotencyKey` makes the write safe to retry: a duplicate is swallowed
   * and the existing event returned, so an agent that retries a tool call does
   * not emit the same milestone twice.
   */
  async emit(projectId: string, input: EmitEventInput): Promise<ProjectEvent> {
    if (input.idempotencyKey) {
      const existing = await this.findOne({
        idempotencyKey: input.idempotencyKey,
      } as never);
      if (existing) return existing;
    }

    const seq = await nextEventSeq(this.database, projectId);
    const event: ProjectEvent = {
      _schemaVersion: 1,
      eventId: `ev_${projectId}_${seq}`,
      projectId,
      seq,
      ts: new Date(),
      ...redactTokens(input),
    };

    try {
      return await this.insert(event);
    } catch (e) {
      // A concurrent emitter won the unique index on idempotencyKey. Its event
      // is the canonical one; the sequence number this call burned is dropped,
      // which leaves a gap of one and is preferable to a duplicate milestone.
      if (isDuplicateKey(e) && input.idempotencyKey) {
        const winner = await this.findOne({
          idempotencyKey: input.idempotencyKey,
        } as never);
        if (winner) return winner;
      }
      throw e;
    }
  }

  /** Replay after a reconnect: everything the client has not seen, in order. */
  async since(projectId: string, fromSeq: number, limit = 500): Promise<ProjectEvent[]> {
    return (await this.collection
      .find({ projectId, seq: { $gt: fromSeq } } as never)
      .sort({ seq: 1 })
      .limit(limit)
      .toArray()) as unknown as ProjectEvent[];
  }

  /** The live activity feed. `DETAIL` belongs to the audit drawer (spec §38). */
  async feed(projectId: string, limit = 100): Promise<ProjectEvent[]> {
    return (await this.collection
      .find({ projectId, level: { $in: ['MILESTONE', 'ACTIVITY'] } } as never)
      .sort({ seq: -1 })
      .limit(limit)
      .toArray()) as unknown as ProjectEvent[];
  }

  async latestSeq(projectId: string): Promise<number> {
    const last = await this.collection
      .find({ projectId } as never)
      .sort({ seq: -1 })
      .limit(1)
      .toArray();
    return (last[0] as { seq?: number } | undefined)?.seq ?? 0;
  }

  /**
   * Tails one project's events.
   *
   * The instance writing an event and the instance holding a subscriber's SSE
   * connection are, under any scale-out, different containers — an in-process
   * emitter would silently deliver nothing. This is what makes the fan-out
   * correct without adding Redis or Pub/Sub.
   */
  watch(projectId: string, onEvent: (e: ProjectEvent) => void): Subscription {
    const stream = this.collection.watch(
      [{ $match: { operationType: 'insert', 'fullDocument.projectId': projectId } }],
      { fullDocument: 'updateLookup' },
    );
    stream.on('change', (change) => {
      const doc = (change as { fullDocument?: ProjectEvent }).fullDocument;
      if (doc) onEvent(doc);
    });
    return { close: () => stream.close() };
  }
}

/**
 * An opaque subscription handle.
 *
 * The repository layer owns the driver; callers get something they can close and
 * nothing they can query. Without this the API layer has to name `mongodb` just
 * to type a variable, which quietly breaks the rule that only `core/` touches the
 * database — the architecture test catches exactly that.
 */
export interface Subscription {
  close: () => Promise<void>;
}

function isDuplicateKey(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: number }).code === 11000;
}
