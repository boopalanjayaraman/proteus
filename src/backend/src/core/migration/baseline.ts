import {
  gcsPath,
  type Baseline, type BehavioralInvariant, type ExecutionKind, type ExecutionRun,
  type MigrationRun, type MigrationStage,
} from '@proteus/schema';
import type { BuildExecutor, ExecutionSpec } from '../../integrations/cloudbuild/executor';
import type { BlobStore } from '../../integrations/storage/blobs';
import type { Repositories } from '../repositories';
import { executionTests, parseReports, type TestInventory } from './testReports';

/**
 * The baseline behavioural contract (spec §24).
 *
 * Everything the migration later claims is measured against this, so the one
 * property that matters is *when* it runs: `EXEC-INV-001` makes the baseline
 * gating on the base commit before any modification, because a baseline
 * captured after the first change is not a baseline. The service therefore
 * refuses to capture once a change exists rather than trusting the caller to
 * sequence it correctly.
 *
 * A build that fails at baseline is recorded and reported, not thrown (Risk 4).
 * A broken base commit is a finding about the repository, and crashing on it
 * would tell the user nothing.
 */

export interface BuildCommands {
  build: string;
  test: string;
}

/** Read from the profile rather than assumed; an unknown build system says so. */
export function commandsFor(buildSystem: string | undefined): BuildCommands | null {
  switch (buildSystem) {
    case 'Maven':
      // `-B` for non-interactive output, and the build is compiled separately
      // from the test run so a compile failure is not reported as a test failure.
      return { build: 'mvn -B -q -DskipTests package', test: 'mvn -B verify' };
    case 'Gradle':
      return { build: './gradlew --no-daemon assemble', test: './gradlew --no-daemon test' };
    case 'npm':
      return { build: 'npm run build --if-present', test: 'npm test' };
    default:
      return null;
  }
}

export class BaselineNotCapturable extends Error {
  constructor(readonly ruleId: 'EXEC-INV-001', message: string) {
    super(message);
    this.name = 'BaselineNotCapturable';
  }
}

export interface CaptureInput {
  run: MigrationRun;
  workdir: string;
  commands: BuildCommands;
  /** Classified before persistence; the rules decide, not the model. */
  invariants: BehavioralInvariant[];
}

export interface CaptureResult {
  baseline: Baseline;
  inventory: TestInventory;
  buildPassed: boolean;
}

export class BaselineService {
  constructor(
    private readonly repos: Repositories,
    private readonly executor: BuildExecutor,
    private readonly blobs: BlobStore,
  ) {}

  /**
   * Records one execution and its evidence.
   *
   * The log goes to blob storage and a bounded excerpt to Mongo — a full Maven
   * log is megabytes and the reasoning that consumes it needs twenty lines.
   */
  async execute(
    run: MigrationRun,
    kind: ExecutionKind,
    command: string,
    /** `onLine` passes through, so a caller can watch the run as it happens. */
    spec: Omit<ExecutionSpec, 'command' | 'commitSha'>,
  ): Promise<{ execution: ExecutionRun; inventory: TestInventory }> {
    const executionRunId = `exec_${run.migrationRunId}_${kind.toLowerCase()}_${Date.now().toString(36)}`;
    const startedAt = new Date();

    // The commit the tree is ACTUALLY at, read now rather than taken from the
    // caller's copy of the run. Every commit moves the head, and `EXEC-VER-002`
    // pins the build check to it — an execution stamped with the base commit
    // after three patches have landed claims to have tested a tree that no
    // longer exists.
    const commitSha = await this.headOf(run);

    const outcome = await this.executor.run({ ...spec, command, commitSha });

    const inventory = parseReports(outcome.reports);

    const logUri = outcome.log
      ? (await this.blobs.put(
          gcsPath.executionLog(run.projectId, executionRunId),
          Buffer.from(outcome.log, 'utf8'),
          'text/plain; charset=utf-8',
        )).gcsUri
      : undefined;

    const reportUri = outcome.reports.length > 0
      ? (await this.blobs.put(
          gcsPath.testReport(run.projectId, executionRunId),
          Buffer.from(outcome.reports.map((r) => r.xml).join('\n'), 'utf8'),
          'application/xml',
        )).gcsUri
      : undefined;

    const execution: ExecutionRun = {
      _schemaVersion: 1, createdAt: startedAt, updatedAt: new Date(),
      executionRunId, projectId: run.projectId, migrationRunId: run.migrationRunId,
      kind,
      environment: this.executor.environment,
      provider: outcome.provider,
      commitSha,
      command,
      exitCode: outcome.exitCode,
      status: outcome.status,
      ...(inventory.total > 0
        ? { tests: { ...executionTests(inventory), ...(reportUri ? { reportGcsUri: reportUri } : {}) } }
        : {}),
      ...(logUri ? { logGcsUri: logUri } : {}),
      logExcerpt: outcome.logExcerpt,
      startedAt,
      finishedAt: new Date(),
      durationMs: outcome.durationMs,
    };

    await this.repos.executionRuns.insert(execution);
    return { execution, inventory };
  }

  /** Where the branch is now, not where it was when the caller loaded the run. */
  private async headOf(run: MigrationRun): Promise<string> {
    const current = await this.repos.migrationRuns.findOne({
      migrationRunId: run.migrationRunId,
    } as never);
    return current?.branch.headCommitSha
      ?? run.branch.headCommitSha
      ?? run.branch.baseCommitSha;
  }

  /**
   * Refuses to capture a baseline against a tree that has already moved.
   *
   * `EXEC-INV-001`. A baseline captured after the first change is not a
   * baseline, and everything downstream — the known-failure allowance, the
   * preserved-invariants check, the report's before and after — is measured
   * against it.
   */
  async assertNothingChangedYet(run: MigrationRun): Promise<void> {
    const changes = await this.repos.migrationChanges.count({
      migrationRunId: run.migrationRunId,
    } as never);
    if (changes > 0) {
      throw new BaselineNotCapturable(
        'EXEC-INV-001',
        `${run.migrationRunId} already has ${changes} change(s); a baseline captured after `
        + 'the first modification measures the modified tree, not the base commit.',
      );
    }
  }

  /**
   * Writes the contract from executions that have already run.
   *
   * Separate from `capture` because the invariants are classified between the
   * test run and the write: the agent is shown the real inventory before it
   * proposes what to preserve, and the rules decide the disposition before any
   * of it is persisted.
   */
  async writeContract(
    run: MigrationRun,
    parts: {
      build: { executionRunId: string; status: string; durationMs?: number };
      tests: { executionRunId: string };
      inventory: TestInventory;
      invariants: BehavioralInvariant[];
    },
  ): Promise<Baseline> {
    const { inventory } = parts;
    const now = new Date();

    const baseline: Baseline = {
      _schemaVersion: 1, createdAt: now, updatedAt: now,
      baselineId: `base_${run.migrationRunId}`,
      projectId: run.projectId,
      migrationRunId: run.migrationRunId,
      commitSha: run.branch.baseCommitSha,
      build: {
        executionRunId: parts.build.executionRunId,
        passed: parts.build.status === 'SUCCESS',
        durationMs: parts.build.durationMs ?? 0,
      },
      tests: {
        executionRunId: parts.tests.executionRunId,
        total: inventory.total,
        passed: inventory.passed,
        failed: inventory.failed,
        skipped: inventory.skipped,
        // EXEC-INV-002 — inherited, never attributed to the migration.
        knownFailures: inventory.tests
          .filter((t) => t.status === 'FAILED')
          .map((t) => ({
            testId: t.testId, name: t.name, ...(t.message ? { message: t.message } : {}),
          })),
        inventory: inventory.tests.map((t) => ({
          testId: t.testId, name: t.name, suite: t.suite, status: t.status,
        })),
      },
      invariants: parts.invariants,
      capturedAt: now,
    };

    await this.repos.baselines.insert(baseline);
    await this.repos.migrationRuns.collection.updateOne(
      { migrationRunId: run.migrationRunId } as never,
      { $set: { baselineId: baseline.baselineId, updatedAt: now } as never },
    );

    return baseline;
  }

  /** Runs the build and tests, then writes the contract. The whole of spec §24. */
  async capture(input: CaptureInput): Promise<CaptureResult> {
    const { run, workdir, commands } = input;
    await this.assertNothingChangedYet(run);

    const build = await this.execute(run, 'BASELINE_BUILD', commands.build, { workdir });
    // Tests run even when the build failed. A compile error produces no reports
    // and the inventory is empty, which is itself the honest record.
    const tests = await this.execute(run, 'BASELINE_TEST', commands.test, { workdir });

    const baseline = await this.writeContract(run, {
      build: {
        executionRunId: build.execution.executionRunId,
        status: build.execution.status,
        ...(build.execution.durationMs !== undefined
          ? { durationMs: build.execution.durationMs }
          : {}),
      },
      tests: { executionRunId: tests.execution.executionRunId },
      inventory: tests.inventory,
      invariants: input.invariants,
    });

    return { baseline, inventory: tests.inventory, buildPassed: baseline.build.passed };
  }

  async current(projectId: string): Promise<Baseline | null> {
    const rows = await this.repos.baselines.collection
      .find({ projectId } as never).sort({ capturedAt: -1 }).limit(1).toArray();
    return (rows[0] as Baseline | undefined) ?? null;
  }
}

/**
 * Moves a migration run to the next stage and writes its checkpoint.
 *
 * The checkpoint is what a restarted worker resumes from. Cloud Run can evict
 * the instance mid-migration, and without a stage boundary written at each step
 * the only options are to start over — destroying the branch's history — or to
 * continue from a state nobody recorded.
 */
export async function advance(
  repos: Repositories,
  run: MigrationRun,
  stage: MigrationStage,
  cursor?: Record<string, unknown>,
): Promise<MigrationRun> {
  const now = new Date();
  const result = await repos.migrationRuns.collection.findOneAndUpdate(
    { migrationRunId: run.migrationRunId } as never,
    {
      $set: {
        stage, stageEnteredAt: now, updatedAt: now,
        checkpoint: { stage, at: now, ...(cursor ? { cursor } : {}) },
      } as never,
    },
    { returnDocument: 'after' },
  );
  await repos.projects.collection.updateOne({ projectId: run.projectId } as never, {
    $set: { stageDetail: stage, updatedAt: now } as never,
  });
  return (result ?? { ...run, stage }) as unknown as MigrationRun;
}
