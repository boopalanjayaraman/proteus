import {
  makeProblemKey,
  type MigrationRun, type ProblemThread, type StructuredFailure,
} from '@proteus/schema';
import type { Repositories } from '../repositories';
import type { Classification } from './diagnosis';

/**
 * The retry budget (spec §31, `EXEC-ESC-001`).
 *
 * `MAX_MEANINGFUL_AUTONOMOUS_ATTEMPTS = 4`, counted per problem rather than per
 * run, and only against attempts that were meaningful. Two exclusions carry the
 * whole design: `EXEC-DIAG-007` exempts infrastructure flakes and
 * `EXEC-DIAG-012` exempts failures outside the boundary. Charging a Cloud Build
 * timeout to the budget would exhaust it without a single engineering attempt
 * having been made, which is the failure mode that makes a retry limit worse
 * than no limit.
 *
 * The counter lives in a document rather than in the loop's memory because the
 * loop can be evicted, and a budget that resets on eviction is not a budget.
 */

export const MAX_MEANINGFUL_AUTONOMOUS_ATTEMPTS = 4;

export interface ThreadUpdate {
  thread: ProblemThread;
  /** True when this attempt was charged to the budget. */
  counted: boolean;
  exhausted: boolean;
  /** `1 / 4` — the retry counter the migration feed renders. */
  display: string;
}

/**
 * Records an attempt against the problem it was attacking.
 *
 * The key comes from `makeProblemKey`, which normalises away timestamps, shas,
 * paths and durations. Without that normalisation every retry carries a fresh
 * signature and looks like a brand new failure, so the fourth attempt at one
 * problem is never recognisable as such.
 */
export async function recordAttempt(
  repos: Repositories,
  run: MigrationRun,
  classification: Classification,
  failure: StructuredFailure,
  attemptId: string,
): Promise<ThreadUpdate> {
  const problemKey = makeProblemKey({
    classification: classification.classification,
    ...(failure.failedTests[0]?.name ? { failedTest: failure.failedTests[0].name } : {}),
    error: failure.error,
  });

  const now = new Date();
  const existing = await repos.problemThreads.findOne({
    problemKey, migrationRunId: run.migrationRunId,
  } as never);

  const counted = classification.countsTowardRetryBudget;

  if (!existing) {
    const thread: ProblemThread = {
      _schemaVersion: 1, createdAt: now, updatedAt: now,
      problemKey,
      projectId: run.projectId,
      migrationRunId: run.migrationRunId,
      classification: classification.classification,
      signature: failure.error.slice(0, 200),
      meaningfulAttempts: counted ? 1 : 0,
      attemptIds: [attemptId],
      status: 'ACTIVE',
      firstSeenAt: now,
    };
    await repos.problemThreads.insert(thread);
    return summarise(thread, counted);
  }

  const result = await repos.problemThreads.collection.findOneAndUpdate(
    { problemKey, migrationRunId: run.migrationRunId } as never,
    {
      $set: { updatedAt: now } as never,
      $addToSet: { attemptIds: attemptId } as never,
      ...(counted ? { $inc: { meaningfulAttempts: 1 } as never } : {}),
    },
    { returnDocument: 'after' },
  );
  return summarise(result as unknown as ProblemThread, counted);
}

function summarise(thread: ProblemThread, counted: boolean): ThreadUpdate {
  return {
    thread,
    counted,
    exhausted: thread.meaningfulAttempts >= MAX_MEANINGFUL_AUTONOMOUS_ATTEMPTS,
    display: `${thread.meaningfulAttempts} / ${MAX_MEANINGFUL_AUTONOMOUS_ATTEMPTS}`,
  };
}

export async function resolveThread(
  repos: Repositories,
  problemKey: string,
  migrationRunId: string,
  status: ProblemThread['status'] = 'RESOLVED',
): Promise<void> {
  await repos.problemThreads.collection.updateOne(
    { problemKey, migrationRunId } as never,
    { $set: { status, updatedAt: new Date() } as never },
  );
}

/** Threads still unresolved on this run — what the report carries forward. */
export async function activeThreads(
  repos: Repositories,
  migrationRunId: string,
): Promise<ProblemThread[]> {
  return repos.problemThreads.collection
    .find({ migrationRunId, status: 'ACTIVE' } as never)
    .sort({ firstSeenAt: 1 })
    .toArray() as unknown as Promise<ProblemThread[]>;
}
