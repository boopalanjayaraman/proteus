import {
  gcsPath,
  type MigrationAttempt, type MigrationChange, type MigrationRun, type TestIntegrityRecord,
} from '@proteus/schema';
import type { BlobStore } from '../../integrations/storage/blobs';
import type { GitWriter } from '../../integrations/github/writer';
import type { Repositories } from '../repositories';

/**
 * Recording what the agent changed.
 *
 * A change is written once the commit exists, not when the patch is proposed:
 * the record names a commit sha, and a record without one is a claim about work
 * that may not have happened. The full diff goes to blob storage; Mongo keeps
 * the shape, the reasoning and the integrity record — which is what makes "why
 * was it safe to edit this test?" answerable months later from data rather than
 * from a transcript.
 */

export interface RecordChangeInput {
  run: MigrationRun;
  attempt: MigrationAttempt;
  changeType: MigrationChange['changeType'];
  intent: MigrationChange['intent'];
  summary: string;
  rationale: string;
  paths: string[];
  commitMessage: string;
  findingIds?: string[];
  planItemIds?: string[];
  testIntegrity?: TestIntegrityRecord;
}

export class ChangeRecorder {
  constructor(
    private readonly repos: Repositories,
    private readonly blobs: BlobStore,
    private readonly git: GitWriter,
  ) {}

  /** The next `Modification #N` for this run. */
  private async nextSequence(migrationRunId: string): Promise<number> {
    return (await this.repos.migrationChanges.count({ migrationRunId } as never)) + 1;
  }

  /**
   * Commits the staged paths and records the change.
   *
   * The commit happens first. If it fails — nothing staged, wrong branch — no
   * record is written, because a change document describing a commit that does
   * not exist is worse than no document at all.
   */
  async commit(input: RecordChangeInput): Promise<MigrationChange> {
    const { run, attempt } = input;
    const commit = await this.git.commit(input.commitMessage, input.paths);

    const sequence = await this.nextSequence(run.migrationRunId);
    const changeId = `chg_${run.migrationRunId}_${sequence}`;
    const now = new Date();

    const diff = await this.git.diffOf(commit.commitSha);
    const stored = diff
      ? await this.blobs.put(
          gcsPath.changeDiff(run.projectId, changeId),
          Buffer.from(diff, 'utf8'),
          'text/x-diff; charset=utf-8',
        )
      : undefined;

    const change: MigrationChange = {
      _schemaVersion: 1, createdAt: now, updatedAt: now,
      changeId, projectId: run.projectId, migrationRunId: run.migrationRunId,
      attemptId: attempt.attemptId,
      sequence,
      changeType: input.changeType,
      intent: input.intent,
      summary: input.summary,
      rationale: input.rationale,
      findingIds: input.findingIds ?? [],
      planItemIds: input.planItemIds ?? [],
      files: input.paths.map((path) => ({
        path,
        operation: 'ADDED' as const,
        linesAdded: 0,
        linesRemoved: 0,
      })),
      commitSha: commit.commitSha,
      ...(stored ? { diffGcsUri: stored.gcsUri } : {}),
      // The schema refuses a TEST/MOCK/FIXTURE change without this, so an
      // omission fails at the boundary rather than three reads later.
      ...(input.testIntegrity ? { testIntegrity: input.testIntegrity } : {}),
      verificationOutcome: 'PENDING',
      appliedAt: now,
    };

    await this.repos.migrationChanges.insert(change);
    await this.repos.migrationAttempts.collection.updateOne(
      { attemptId: attempt.attemptId } as never,
      { $addToSet: { changeIds: changeId } as never, $set: { updatedAt: now } as never },
    );

    const commitCount = await this.git.commitCount(run.branch.baseCommitSha);
    await this.repos.migrationRuns.collection.updateOne(
      { migrationRunId: run.migrationRunId } as never,
      {
        $set: {
          'branch.headCommitSha': commit.commitSha,
          'branch.commitCount': commitCount,
          updatedAt: now,
        } as never,
      },
    );
    await this.repos.projects.collection.updateOne({ projectId: run.projectId } as never, {
      $inc: { 'summary.counts.migrationChanges': 1 } as never,
    });

    return change;
  }
}

/** One engineering cycle. Test engineering is a single attempt; PRD-12 adds more. */
export async function openAttempt(
  repos: Repositories,
  run: MigrationRun,
  intent: string,
): Promise<MigrationAttempt> {
  const attemptNumber = (await repos.migrationAttempts.count({
    migrationRunId: run.migrationRunId,
  } as never)) + 1;

  const now = new Date();
  const attempt: MigrationAttempt = {
    _schemaVersion: 1, createdAt: now, updatedAt: now,
    attemptId: `att_${run.migrationRunId}_${attemptNumber}`,
    projectId: run.projectId,
    migrationRunId: run.migrationRunId,
    attemptNumber,
    intent,
    planItemIds: run.approval.approvedPlanItemIds,
    changeIds: [],
    executionRunIds: [],
    result: 'PENDING',
    startedAt: now,
  };
  await repos.migrationAttempts.insert(attempt);
  await repos.migrationRuns.collection.updateOne(
    { migrationRunId: run.migrationRunId } as never,
    {
      $set: { currentAttemptId: attempt.attemptId, updatedAt: now } as never,
      $inc: { attemptCount: 1 } as never,
    },
  );
  return attempt;
}

export async function closeAttempt(
  repos: Repositories,
  attempt: MigrationAttempt,
  result: MigrationAttempt['result'],
): Promise<void> {
  await repos.migrationAttempts.collection.updateOne({ attemptId: attempt.attemptId } as never, {
    $set: { result, endedAt: new Date(), updatedAt: new Date() } as never,
  });
}
