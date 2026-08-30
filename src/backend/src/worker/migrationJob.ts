import { randomUUID } from 'node:crypto';
import {
  type Assessment, type BehavioralInvariant, type MigrationRun, type Project,
} from '@proteus/schema';
import { TestEngineeringAgent, type MigrationContext, type RepositoryContext } from '../agent/flows/testEngineering';
import type { ModelClient } from '../agent/model';
import type { GeneratedTestInput } from '../agent/tools/registry';
import type { Logger } from '../config/logger';
import { detectProfile } from '../core/discovery/profile';
import { WorkingCopy } from '../core/discovery/workingCopy';
import { advance, BaselineService, commandsFor } from '../core/migration/baseline';
import { ChangeRecorder, closeAttempt, openAttempt } from '../core/migration/changes';
import { classifyAll } from '../core/migration/invariants';
import { coveredSuites } from '../core/migration/testReports';
import {
  guardTestArtifact, validateAgainstBase,
  type GuardRefusal, type ProposedTestArtifact,
} from '../core/migration/testGuard';
import type { RuleEngine } from '../core/rules/engine';
import type { Repositories } from '../core/repositories';
import type { ProjectService } from '../core/services/projects';
import type { BuildExecutor } from '../integrations/cloudbuild/executor';
import { GitHubReader } from '../integrations/github/client';
import { GitWriter, migrationBranchName } from '../integrations/github/writer';
import type { SandboxDeployer } from '../integrations/cloudrun/sandbox';
import type { SandboxCapacityService } from '../core/services/sandboxCapacity';
import type { SandboxLifecycleService } from '../core/services/sandboxLifecycle';
import { runVerification, type VerificationJobOutcome } from './verificationJob';
import { runReport } from './reportJob';
import { runMigrationLoop, type LoopOutcome } from './migrationLoop';
import type { BlobStore } from '../integrations/storage/blobs';

/**
 * The migration job, up to the point where implementation changes begin.
 *
 * Branch, baseline, invariants, coverage, tests, mocks, validation. Everything
 * here happens before a line of implementation moves, and the order is not
 * incidental — `EXEC-INV-001` makes the baseline meaningless if anything is
 * modified first, and `EXEC-TEST-002` can only detect a vacuous test while the
 * unmigrated build still exists to run it against.
 *
 * `worker/` is one of the two places allowed to depend on both `core/` and
 * `agent/`. Everything the agent proposes passes through `core/` before it
 * reaches the repository.
 */

export interface MigrationJobDeps {
  repos: Repositories;
  projects: ProjectService;
  engine: RuleEngine;
  model: ModelClient;
  executor: BuildExecutor;
  blobs: BlobStore;
  logger: Logger;
  github?: GitHubReader;
  /** Set for tests: a working copy already on disk, so nothing is cloned. */
  workdir?: string;
  /** The port the migrated image listens on. */
  containerPort?: number;
  /** Injected so tests can point the sandbox probe at a stub server. */
  fetchImpl?: typeof fetch;
  /** Deploys the verified build. PRD-13 supplies it. */
  deployer?: SandboxDeployer;
  /** Sandbox capacity and lifecycle. Absent means unlimited — the local default. */
  capacity?: SandboxCapacityService;
  lifecycle?: SandboxLifecycleService;
  /** Absent to skip the narrative; the report renders without it. */
  reportModel?: ModelClient;
}

export interface TestEngineeringOutcome {
  run: MigrationRun;
  baselineId: string;
  invariants: BehavioralInvariant[];
  written: string[];
  refused: Array<{ path: string; refusals: GuardRefusal[] }>;
  vacuous: string[];
  /** Present once the build/test loop has run — PRD-12. */
  loop?: LoopOutcome;
  /** Present once verification has run — PRD-13. */
  verification?: VerificationJobOutcome;
}

export async function runTestEngineering(
  project: Project,
  run: MigrationRun,
  deps: MigrationJobDeps,
): Promise<TestEngineeringOutcome> {
  const { repos, model, executor, blobs } = deps;
  const log = deps.logger.child({ projectId: project.projectId, job: 'migration' });
  const holder = `worker-${randomUUID().slice(0, 8)}`;

  // The lease was taken at approval. Refreshing under this worker's identity is
  // what lets an evicted instance's run be picked up rather than duplicated.
  await repos.migrationLease.acquire(run.migrationRunId, holder, { ttlMs: 300_000 });

  const assessment = await repos.assessments.findOne({
    assessmentId: run.approval.assessmentId,
  } as never) as Assessment | null;
  if (!assessment) throw new Error(`${run.migrationRunId}: approved assessment is missing`);

  // ---- 1. Branch (spec §23, FR-1) --------------------------------------
  let current = await advance(repos, run, 'CREATING_BRANCH');

  const checkout = deps.workdir
    ? { dir: deps.workdir, dispose: async () => undefined }
    : await cloneForMigration(project, deps);

  try {
    const git = new GitWriter(checkout.dir, migrationBranchName(project.projectId));
    const branch = await git.createBranch(run.branch.baseCommitSha);

    await repos.events.emit(project.projectId, {
      type: 'BRANCH_CREATED', phase: 'MIGRATION', level: 'MILESTONE', severity: 'SUCCESS',
      stage: 'CREATING_BRANCH',
      title: `Branch ${branch.branch} created`,
      message: `base ${branch.baseCommitSha.slice(0, 7)} · the original branch is untouched`,
      actor: 'TOOL', refs: {},
    });

    const wc = new WorkingCopy(checkout.dir);
    const profile = await detectProfile(wc);
    const commands = commandsFor(profile.buildSystem);
    if (!commands) {
      throw new Error(
        `no build commands known for ${profile.buildSystem ?? 'an unrecognised build system'}`,
      );
    }

    // ---- 2. Baseline (spec §24, EXEC-INV-001/002) ------------------------
    current = await advance(repos, current, 'CAPTURING_BASELINE');
    await repos.events.emit(project.projectId, {
      type: 'BASELINE_CAPTURE_STARTED', phase: 'MIGRATION', level: 'MILESTONE', severity: 'INFO',
      stage: 'CAPTURING_BASELINE',
      title: 'Capturing the behavioural baseline',
      message: `${commands.build} · ${commands.test} on ${run.branch.baseCommitSha.slice(0, 7)}`,
      actor: 'TOOL', refs: {},
    });

    const baselines = new BaselineService(repos, executor, blobs);
    // EXEC-INV-001, before anything runs: a baseline measured after the first
    // change measures the modified tree.
    await baselines.assertNothingChangedYet(current);
    const build = await baselines.execute(current, 'BASELINE_BUILD', commands.build, {
      workdir: checkout.dir,
    });
    const tests = await baselines.execute(current, 'BASELINE_TEST', commands.test, {
      workdir: checkout.dir,
    });
    const inventory = tests.inventory;

    // ---- 3. Invariants (EXEC-INV-003/004) --------------------------------
    const agent = new TestEngineeringAgent(model);
    const repoContext = await buildRepoContext(wc, profile, project, inventory);
    const migrationContext = await buildMigrationContext(wc, assessment, run);

    const proposed = await agent.captureInvariants(repoContext, migrationContext, {
      total: inventory.total, passed: inventory.passed, failed: inventory.failed,
      suites: [...coveredSuites(inventory)],
    });
    // Rules decide the disposition; the model only proposed one, and only a
    // constrained departure from the default survives.
    const pass = classifyAll(
      proposed.map((p) => ({ ...p, capturedFrom: p.capturedFrom })),
      project.projectId,
    );
    for (const r of pass.rejected) {
      log.warn({ invariant: r.description }, 'invariant rejected: no executable assertion');
    }

    const invariants = pass.classified.map((c) => c.invariant);
    const captured = await baselines.writeContract(current, {
      build: {
        executionRunId: build.execution.executionRunId,
        status: build.execution.status,
        ...(build.execution.durationMs !== undefined
          ? { durationMs: build.execution.durationMs }
          : {}),
      },
      tests: { executionRunId: tests.execution.executionRunId },
      inventory,
      invariants,
    });

    await repos.events.emit(project.projectId, {
      type: 'BASELINE_CAPTURE_COMPLETED', phase: 'MIGRATION',
      level: 'MILESTONE',
      // A base commit that does not build is a finding about the repository, not
      // a crash. Recorded, surfaced, and the run continues to report it.
      severity: captured.build.passed ? 'SUCCESS' : 'WARN',
      stage: 'CAPTURING_BASELINE',
      title: captured.build.passed
        ? `Baseline captured — ${inventory.passed}/${inventory.total} tests passing`
        : 'Baseline captured — the base commit does not build',
      message: [
        `${inventory.unit} unit · ${inventory.integration} integration`,
        `${captured.tests.knownFailures.length} pre-existing failure`
          + `${captured.tests.knownFailures.length === 1 ? '' : 's'} recorded as known`,
        `${invariants.length} invariants (`
          + `${invariants.filter((i) => i.disposition === 'MUST_PRESERVE').length} must preserve, `
          + `${invariants.filter((i) => i.disposition === 'EXPECTED_TO_CHANGE').length} expected to change)`,
      ].join(' · '),
      actor: 'TOOL', refs: {},
    });

    for (const c of pass.classified.filter((x) => x.override)) {
      await repos.events.emit(project.projectId, {
        type: 'BASELINE_CAPTURE_COMPLETED', phase: 'MIGRATION', level: 'DETAIL', severity: 'INFO',
        stage: 'CAPTURING_BASELINE',
        title: `${c.invariant.description} — ${c.invariant.disposition.replace(/_/g, ' ').toLowerCase()}`,
        message: `${c.ruleId}: ${c.override!.reason}`,
        actor: 'SYSTEM', refs: {},
      });
    }

    // ---- 4. Coverage (EXEC-TEST-001) -------------------------------------
    current = await advance(repos, current, 'ASSESSING_TEST_COVERAGE');
    const coverage = await agent.assessCoverage(repoContext, migrationContext);
    const uncovered = coverage.filter((c) => !c.covered);

    // ---- 5. Tests and mocks (spec §25, EXEC-MOCK-004, EXEC-TEST-004) -----
    current = await advance(repos, current, 'CREATING_TESTS');
    const artifacts = await agent.generateTests(
      repoContext, migrationContext, { invariants }, uncovered,
    );

    const attempt = await openAttempt(repos, current, 'Baseline contract and crypto regression tests');
    const recorder = new ChangeRecorder(repos, blobs, git);

    const written: string[] = [];
    const refused: TestEngineeringOutcome['refused'] = [];
    const kinds = new Map<string, GeneratedTestInput['testKind']>();

    for (const artifact of artifacts) {
      const proposal: ProposedTestArtifact = {
        path: artifact.path,
        changeType: artifact.changeType,
        testKind: artifact.testKind,
        content: artifact.content,
        ...(artifact.mockTarget ? { mockTarget: artifact.mockTarget } : {}),
        ...(artifact.testIntegrity ? { testIntegrity: artifact.testIntegrity } : {}),
      };

      // The approved paths are known before any test is written, so a
      // characterization test that pins one of them can be refused rather than
      // discovered later as a self-inflicted failure (EXEC-TEST-008).
      const verdict = guardTestArtifact(proposal, {
        invariants,
        approvedPaths: migrationContext.targetPaths,
      });
      if (!verdict.allowed) {
        refused.push({ path: artifact.path, refusals: verdict.refusals });
        for (const r of verdict.refusals) log.warn({ path: artifact.path, ruleId: r.ruleId }, r.reason);
        // One line per refused artifact, not per reason. A file can break two
        // rules at once — a declared mock of the primitive whose body also stubs
        // it — and the reader needs one entry naming both, not the same file
        // twice.
        await repos.events.emit(project.projectId, {
          type: 'MIGRATION_BLOCKER_IDENTIFIED', phase: 'MIGRATION',
          level: 'ACTIVITY', severity: 'WARN',
          stage: current.stage,
          title: `Refused ${artifact.path} — `
            + `${[...new Set(verdict.refusals.map((r) => r.ruleId))].join(', ')}`,
          message: verdict.refusals.map((r) => r.reason).join('\n'),
          actor: 'SYSTEM', refs: { paths: [artifact.path] },
        });
        continue;
      }

      if (artifact.changeType === 'MOCK') {
        current = await advance(repos, current, 'PREPARING_MOCKS');
      }

      await git.writeFile(artifact.path, artifact.content);
      await recorder.commit({
        run: current, attempt,
        changeType: artifact.changeType,
        intent: 'TEST_ENGINEERING',
        summary: artifact.summary,
        rationale: artifact.rationale,
        paths: [artifact.path],
        commitMessage: `test(pqc): ${artifact.summary}`,
        findingIds: artifact.findingIds,
        planItemIds: artifact.planItemIds,
        // Every TEST/MOCK/FIXTURE change carries one. The guard has already
        // refused any artifact that arrived without it, so this is the record
        // the agent supplied rather than one invented here.
        ...(artifact.testIntegrity ? { testIntegrity: artifact.testIntegrity } : {}),
      });

      written.push(artifact.path);
      kinds.set(artifact.path, artifact.testKind);

      await repos.events.emit(project.projectId, {
        type: artifact.changeType === 'MOCK' ? 'MOCK_CREATED' : 'TEST_CREATED',
        phase: 'MIGRATION', level: 'ACTIVITY', severity: 'INFO',
        stage: current.stage,
        title: artifact.summary,
        message: `${artifact.testKind.replace(/_/g, ' ').toLowerCase()} · ${artifact.path}`,
        actor: 'AGENT', refs: { paths: [artifact.path] },
      });
    }

    // ---- 6. Validate against the base commit (EXEC-TEST-002) -------------
    current = await advance(repos, current, 'VALIDATING_BASELINE_TESTS');
    let vacuous: string[] = [];

    if (written.length > 0) {
      const validation = await baselines.execute(
        current, 'UNIT_TEST', commands.test, { workdir: checkout.dir },
      );
      const outcomeById = new Map(validation.inventory.tests.map((t) => [t.testId, t.status]));

      const results = [...kinds.entries()].map(([path, testKind]) => {
        const suite = suiteOf(path);
        const own = [...outcomeById.entries()].filter(([id]) => id.startsWith(`${suite}#`));
        return {
          testId: path,
          testKind,
          // A suite that produced no result at all did not pass. Treating a
          // missing result as a pass would let a test that fails to compile be
          // recorded as a valid acceptance test.
          passedAtBase: own.length > 0 && own.every(([, s]) => s === 'PASSED'),
        };
      });

      const verdict = validateAgainstBase(results);
      vacuous = verdict.vacuous;

      for (const path of verdict.vacuous) {
        await repos.events.emit(project.projectId, {
          type: 'MIGRATION_BLOCKER_IDENTIFIED', phase: 'MIGRATION',
          level: 'ACTIVITY', severity: 'WARN',
          stage: 'VALIDATING_BASELINE_TESTS',
          title: `${path} already passes against the unmigrated build`,
          message: 'EXEC-TEST-002: a migration acceptance test that passes before the '
            + 'migration is asserting nothing about it.',
          actor: 'SYSTEM', refs: { paths: [path] },
        });
      }
      for (const path of verdict.brokenAtBase) {
        await repos.events.emit(project.projectId, {
          type: 'MIGRATION_BLOCKER_IDENTIFIED', phase: 'MIGRATION',
          level: 'ACTIVITY', severity: 'WARN',
          stage: 'VALIDATING_BASELINE_TESTS',
          title: `${path} fails against the unmigrated build`,
          message: 'EXEC-TEST-001: a characterization test that fails on the base commit has '
            + 'documented a bug, not captured a baseline.',
          actor: 'SYSTEM', refs: { paths: [path] },
        });
      }
    }

    await closeAttempt(repos, attempt, 'SUCCEEDED');

    log.info(
      { written: written.length, refused: refused.length, vacuous: vacuous.length },
      'test engineering complete',
    );

    // The tests exist and fail. Now make them pass — the loop is the orchestrator's,
    // not the model's, so it can be checkpointed, resumed and bounded.
    const loop = await runMigrationLoop(project, current, assessment, captured, {
      repos, engine: deps.engine, model, executor, blobs,
      logger: deps.logger,
      git, workdir: checkout.dir, commands,
    });

    // Verification runs whether or not every item landed. A partially blocked
    // run still has a verdict worth computing and reporting — reaching the end
    // is not the same as passing, and the checks are what say which happened.
    const verification = deps.deployer
      ? await runVerification(project, loop.run, {
          repos, engine: deps.engine, executor, blobs,
          deployer: deps.deployer,
          logger: deps.logger,
          workdir: checkout.dir, commands,
          ...(deps.containerPort !== undefined ? { containerPort: deps.containerPort } : {}),
          ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
          ...(deps.capacity ? { capacity: deps.capacity } : {}),
          ...(deps.lifecycle ? { lifecycle: deps.lifecycle } : {}),
        })
      : undefined;

    // The evidence package. `EXEC-VER-013` puts it before the migration may be
    // reported complete — it is the deliverable, not a by-product — so it runs
    // whatever the verdict was, and the report says which verdict that is.
    /**
     * Publish the branch, whatever the verdict.
     *
     * "Create a migration branch" is what the approval disclosed, and the scopes
     * the create screen asks for — `contents: read & write` — only make sense if
     * the branch reaches the repository. A branch that exists solely in a
     * temporary directory on a server is not one anybody can review.
     *
     * Pushed even when verification failed, because that is exactly when a human
     * most needs to read the diff. The evidence package says which verdict it
     * carries; the branch is not a claim of success.
     *
     * A failed push does not fail the run: the work is committed, the report is
     * still worth writing, and the failure is recorded rather than swallowed.
     */
    await publishBranch(project, loop.run, git, deps);

    if (verification) {
      await runReport(project, loop.run, {
        repos, blobs, logger: deps.logger,
        ...(deps.reportModel ? { model: deps.reportModel } : {}),
      });
    }

    return {
      run: loop.run,
      baselineId: captured.baselineId,
      invariants,
      written,
      refused,
      vacuous,
      loop,
      ...(verification ? { verification } : {}),
    };
  } finally {
    await checkout.dispose();
  }
}

/** Pushes the migration branch and records that it reached the remote. */
export async function publishBranch(
  project: Project,
  run: MigrationRun,
  git: GitWriter,
  deps: MigrationJobDeps,
): Promise<void> {
  const { repos, projects, logger } = deps;
  if (run.branch.commitCount === 0) return;

  try {
    const token = await projects.credentialFor(project.projectId);
    await git.push(project.repository.url, token);

    await repos.migrationRuns.collection.updateOne(
      { migrationRunId: run.migrationRunId } as never,
      { $set: { 'branch.pushed': true, updatedAt: new Date() } as never },
    );
    await repos.events.emit(project.projectId, {
      type: 'BRANCH_CREATED', phase: 'MIGRATION', level: 'MILESTONE', severity: 'SUCCESS',
      title: `Branch ${run.branch.name} pushed`,
      message: `${run.branch.commitCount} commit${run.branch.commitCount === 1 ? '' : 's'} `
        + `on ${run.branch.name}, based on ${run.branch.baseCommitSha.slice(0, 7)}.`,
      actor: 'AGENT', refs: {},
    });
  } catch (e) {
    // The token is redacted inside `push`; this only carries the message.
    const reason = e instanceof Error ? e.message : String(e);
    logger.error({ err: e }, 'could not push the migration branch');
    await repos.events.emit(project.projectId, {
      type: 'BRANCH_CREATED', phase: 'MIGRATION', level: 'DETAIL', severity: 'WARN',
      title: 'Migration branch could not be pushed',
      message: `${reason} — the work is committed locally and the diff is in the `
        + 'evidence package.',
      actor: 'SYSTEM', refs: {},
    }).catch(() => undefined);
  }
}

/** Clones the repository with enough history to reach the approved base commit. */
async function cloneForMigration(
  project: Project,
  deps: MigrationJobDeps,
): Promise<{ dir: string; dispose: () => Promise<void> }> {
  if (!deps.github) throw new Error('no repository client configured for migration');
  const token = await deps.projects.credentialFor(project.projectId);
  const checkout = await deps.github.checkout(project.repository.url, token);
  return { dir: checkout.dir, dispose: checkout.dispose };
}

/** `src/test/java/pay/security/CryptoServiceTest.java` → `pay.security.CryptoServiceTest` */
export function suiteOf(path: string): string {
  const m = /src\/test\/(?:java|kotlin)\/(.+)\.(?:java|kt)$/.exec(path);
  if (m?.[1]) return m[1].replace(/\//g, '.');
  return path.split('/').pop()?.replace(/\.\w+$/, '') ?? path;
}

async function buildRepoContext(
  wc: WorkingCopy,
  profile: { language: string; buildSystem?: string },
  project: Project,
  inventory: { tests: Array<{ suite: string }> },
): Promise<RepositoryContext> {
  const files = await wc.files();
  return {
    repositoryName: project.repository.url.split('/').pop() ?? project.projectId,
    language: profile.language,
    buildSystem: profile.buildSystem ?? 'unknown',
    existingSuites: [...new Set(inventory.tests.map((t) => t.suite))].sort(),
    testPaths: files.filter((f) => f.kind === 'TEST').map((f) => f.path),
  };
}

/**
 * What the agent is told about the approved scope.
 *
 * Only the approved items, and only the sources they name. An agent shown the
 * whole repository writes tests for the whole repository, and the approval was
 * for a scope.
 */
async function buildMigrationContext(
  wc: WorkingCopy,
  assessment: Assessment,
  run: MigrationRun,
): Promise<MigrationContext> {
  const approved = new Set(run.approval.approvedPlanItemIds);
  const planItems = assessment.planItems.filter((p) => approved.has(p.planItemId));
  const targetPaths = [
    ...new Set(planItems.flatMap((p) => p.expectedChanges.flatMap((c) => c.paths))),
  ].filter((p) => !p.includes('*'));

  const sources: MigrationContext['sources'] = [];
  for (const path of targetPaths.slice(0, 8)) {
    try {
      sources.push({ path, excerpt: (await wc.read(path)).slice(0, 6000) });
    } catch {
      // A declared path that does not exist is the plan's claim, not a crash.
    }
  }

  return { planItems, targetPaths, sources };
}
