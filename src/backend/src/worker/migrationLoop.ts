import {
  type Assessment, type Baseline, type Diagnosis, type Finding, type MigrationAttempt,
  type MigrationRun, type PlanItem, type Project, type StructuredFailure,
} from '@proteus/schema';
import { DiagnosticAgent } from '../agent/flows/diagnosis';
import { MigrationAgent } from '../agent/flows/migration';
import type { ModelClient } from '../agent/model';
import type { Logger } from '../config/logger';
import { WorkingCopy } from '../core/discovery/workingCopy';
import { advance, BaselineService, type BuildCommands } from '../core/migration/baseline';
import { ChangeRecorder, closeAttempt, openAttempt } from '../core/migration/changes';
import { changeSetsOf } from '../core/migration/changeSets';
import { apiSurfaceOf } from '../core/migration/apiSurface';
import { targetOfItem } from '../core/migration/target';
import {
  authoriseRepair, classifyDeterministically, factsForFailure, touchedInvariant,
  unclassified, LEGACY_ALGORITHM, type Classification, type DiagnosisContext,
} from '../core/migration/diagnosis';
import { failureJson, structureFailure } from '../core/migration/failures';
import {
  baselineContractGate, openGate, retryBudgetGate, unclassifiedGate,
} from '../core/migration/gates';
import {
  MAX_MEANINGFUL_AUTONOMOUS_ATTEMPTS, recordAttempt, resolveThread,
} from '../core/migration/problems';
import { guardTestArtifact } from '../core/migration/testGuard';
import {
  GROUP_LABEL, ProgressTracker, buildGroups, parseLine, totalsFor,
} from '../core/migration/progress';
import type { RuleEngine } from '../core/rules/engine';
import type { Repositories } from '../core/repositories';
import type { BuildExecutor } from '../integrations/cloudbuild/executor';
import type { GitWriter } from '../integrations/github/writer';
import type { BlobStore } from '../integrations/storage/blobs';

/**
 * The migration loop.
 *
 * It lives here, in the orchestrator, and not inside model reasoning. That is
 * the load-bearing decision of this increment and it buys four properties:
 *
 *   THE MODEL NEVER DECIDES TO LOOP AGAIN. Continuation is a function of a build
 *   result, not of a model's sense that one more try might work.
 *
 *   THE BUILD RESULT IS A TOOL FACT. `ExecutionRun` comes from a command that
 *   ran. No agent reports on its own build.
 *
 *   THE RETRY BUDGET IS ENFORCED OUTSIDE THE REASONING THAT WANTS TO KEEP GOING.
 *   Counted per problem, in a document, so eviction does not reset it.
 *
 *   EVERY ITERATION IS A CHECKPOINT. An evicted worker repeats at most one
 *   attempt rather than the run.
 */

/**
 * A change the guardrails would not permit.
 *
 * Distinguished from any other error the patch step can raise, because the two
 * mean opposite things: a refusal is the system working as designed and belongs
 * in front of a human as a decision, while a model or transport error is a
 * failure of the run and should say so rather than being reported as though the
 * agent had proposed something forbidden.
 */
/**
 * The stack, as discovery established it.
 *
 * Defaults only where the profile is absent — a project that was never analysed
 * has no profile, and refusing to migrate over it would be worse than assuming
 * the fixture's stack.
 */
export function stackOf(project: Project): {
  language: string; languageVersion?: string; buildSystem: string; framework?: string;
} {
  const p = project.repository.profile;
  return {
    language: p?.language ?? 'Java',
    buildSystem: p?.buildSystem ?? 'Maven',
    ...(p?.languageVersion ? { languageVersion: p.languageVersion } : {}),
    ...(p?.framework ? { framework: p.framework } : {}),
  };
}

export class PatchRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PatchRefused';
  }
}

export interface LoopDeps {
  repos: Repositories;
  engine: RuleEngine;
  model: ModelClient;
  executor: BuildExecutor;
  blobs: BlobStore;
  logger: Logger;
  git: GitWriter;
  workdir: string;
  commands: BuildCommands;
  /** Continues into verification. PRD-13 supplies it. */
  onChangesApplied?: (run: MigrationRun) => void;
}

export interface LoopOutcome {
  run: MigrationRun;
  /** Plan items whose acceptance tests went green. */
  completed: string[];
  /** Plan items that stopped on a gate or an exhausted budget. */
  blocked: Array<{ planItemId: string; reason: string; gateId?: string }>;
  autonomousRepairs: number;
  attempts: number;
}

/**
 * Runs the approved plan to completion, or to the point where a human is needed.
 *
 * Each plan item is independent: a gate on one does not stop the others, which
 * is what spec §30's "continue with unrelated eligible work" means in practice
 * and what keeps the one-approval model honest.
 */
export async function runMigrationLoop(
  project: Project,
  run: MigrationRun,
  assessment: Assessment,
  baseline: Baseline,
  deps: LoopDeps,
): Promise<LoopOutcome> {
  const { repos, model, blobs, git } = deps;
  const log = deps.logger.child({ projectId: project.projectId, job: 'migration-loop' });

  const migrationAgent = new MigrationAgent(model);
  const diagnostician = new DiagnosticAgent(model);
  const baselines = new BaselineService(repos, deps.executor, blobs);
  const recorder = new ChangeRecorder(repos, blobs, git);
  const wc = new WorkingCopy(deps.workdir);

  const approved = new Set(run.approval.approvedPlanItemIds);
  const items = assessment.planItems
    .filter((p) => approved.has(p.planItemId))
    .sort((a, b) => a.order - b.order);

  const outcome: LoopOutcome = {
    run, completed: [], blocked: [], autonomousRepairs: 0, attempts: 0,
  };
  let current = run;

  // Items that have to land together, because a primitive swap is one change
  // however many files it touches. Within a set, only the last item's build is
  // a verdict; the earlier ones are mid-migration by construction.
  const findings = await repos.findings.find(
    { projectId: project.projectId } as never,
  ) as unknown as Finding[];
  const changeSets = changeSetsOf(items, findings);

  for (const set of changeSets) {
    // Applied but not yet judged. The set's last build decides for all of them.
    const deferred: string[] = [];

    for (const [index, item] of set.entries()) {
      // The cursor is the plan item, so a restarted worker resumes at the item it
      // was on rather than replaying the ones already committed.
      current = await advance(repos, current, 'APPLYING_MIGRATION_CHANGES', {
        planItemId: item.planItemId,
      });

      const result = await runPlanItem(
        project, current, item, assessment, baseline,
        { ...deps, migrationAgent, diagnostician, baselines, recorder, wc, log },
        index < set.length - 1,
      );

      current = result.run;
      outcome.attempts += result.attempts;
      outcome.autonomousRepairs += result.repairs;

      if (result.deferred) {
        deferred.push(item.planItemId);
        continue;
      }
      if (result.completed) {
        // The build that passed covers everything applied since the last verdict.
        outcome.completed.push(...deferred, item.planItemId);
        deferred.length = 0;
        continue;
      }

      // The set could not be made to work. Everything in it is blocked, not just
      // the item that happened to be last — reporting only the last one would
      // point a reviewer at a file that is very likely correct.
      for (const planItemId of [...deferred, item.planItemId]) {
        outcome.blocked.push({
          planItemId,
          reason: result.reason ?? 'unresolved',
          ...(result.gateId ? { gateId: result.gateId } : {}),
        });
      }
      deferred.length = 0;
    }
  }

  await repos.migrationRuns.collection.updateOne(
    { migrationRunId: current.migrationRunId } as never,
    {
      $set: {
        'metrics.autonomousRepairs': outcome.autonomousRepairs,
        status: outcome.blocked.length === 0 ? 'RUNNING' : 'PAUSED_FOR_HUMAN',
        updatedAt: new Date(),
      } as never,
    },
  );
  await repos.projects.collection.updateOne({ projectId: project.projectId } as never, {
    $set: {
      'summary.autonomy.completedAutonomously': outcome.completed.length,
      'summary.autonomy.completionPct': items.length
        ? Math.round((outcome.completed.length / items.length) * 100)
        : null,
      updatedAt: new Date(),
    } as never,
  });

  log.info(
    { completed: outcome.completed.length, blocked: outcome.blocked.length,
      repairs: outcome.autonomousRepairs },
    'migration loop finished',
  );

  outcome.run = current;
  if (outcome.blocked.length === 0) deps.onChangesApplied?.(current);
  return outcome;
}

// ---------------------------------------------------------------------------

interface ItemDeps extends LoopDeps {
  migrationAgent: MigrationAgent;
  diagnostician: DiagnosticAgent;
  baselines: BaselineService;
  recorder: ChangeRecorder;
  wc: WorkingCopy;
  log: Logger;
}

interface ItemResult {
  run: MigrationRun;
  completed: boolean;
  /**
   * The change this item made is applied and committed, but the suite was not
   * judged: more of its change set is still to land. Neither completed nor
   * blocked — the group's last item decides for all of them.
   */
  deferred?: boolean;
  attempts: number;
  repairs: number;
  reason?: string;
  gateId?: string;
}

/**
 * One plan item: patch, build, and then repair until it works or must stop.
 *
 * The bound is the retry budget, not an iteration count — `EXEC-DIAG-007` and
 * `-012` failures retry freely because they are not engineering attempts, and
 * charging them would exhaust the budget before any real work was tried.
 */
async function runPlanItem(
  project: Project,
  run: MigrationRun,
  item: PlanItem,
  assessment: Assessment,
  baseline: Baseline,
  deps: ItemDeps,
  /** True while later items of the same change set are still unapplied. */
  deferFailure = false,
): Promise<ItemResult> {
  const { repos, engine, log } = deps;
  let current = run;
  let attempts = 0;
  let repairs = 0;
  let lastFailure: { failure: StructuredFailure; classification: Classification } | null = null;
  let priorAttempts: Array<{ summary: string; outcome: string }> = [];
  let lastChangeId: string | undefined;

  // A hard ceiling on iterations, distinct from the retry budget. The budget
  // bounds attempts on ONE problem; this bounds a pathological run that produces
  // a different problem every time and would otherwise never terminate.
  const MAX_ITERATIONS = MAX_MEANINGFUL_AUTONOMOUS_ATTEMPTS * 3;

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    const attempt = await openAttempt(
      repos, current,
      iteration === 0 ? item.action : `Repair: ${lastFailure?.classification.classification}`,
    );
    attempts++;

    // ---- 1. Patch or repair -------------------------------------------
    let change;
    try {
      change = lastFailure
        ? await applyRepair(project, current, attempt, item, baseline, lastFailure, priorAttempts, deps)
        : await applyPatch(project, current, attempt, item, assessment, baseline, deps);
    } catch (e) {
      // A refused patch is not a build failure and must not be diagnosed as one.
      // It is the guardrails doing their job, and it stops this item.
      const refused = e instanceof PatchRefused;
      log.warn({ planItemId: item.planItemId, refused }, (e as Error).message);
      await closeAttempt(repos, attempt, 'ABANDONED');
      const { gate } = await openGate(repos, {
        run: current, type: 'MATERIAL_ARCHITECTURE_DECISION',
        attemptId: attempt.attemptId,
        title: refused
          ? `Proposed change to ${item.targetName} was refused`
          : `Could not produce a change for ${item.targetName}`,
        question: refused
          ? 'The agent proposed a change the guardrails do not permit. How should this '
            + 'item be handled?'
          : 'The agent could not produce a usable change for this item. How should it be '
            + 'handled?',
        context: (e as Error).message,
        options: [
          { optionId: 'ACKNOWLEDGE', label: 'Acknowledge and continue',
            detail: 'Recorded and carried into the report.',
            consequence: 'No further autonomous attempts on this item.' },
          { optionId: 'ABANDON', label: 'Abandon this item',
            detail: 'The rest of the approved scope continues.',
            consequence: 'Reported as requiring human action.' },
        ],
      }, `${item.planItemId}-refused`);
      return {
        run: current, completed: false, attempts, repairs,
        reason: (e as Error).message, gateId: gate.gateId,
      };
    }
    if (change) lastChangeId = change.changeId;
    if (lastFailure) repairs++;

    // ---- 2. Build and test. Truth, not a model claim (FR-3) ------------
    current = await advance(repos, current, iteration === 0 ? 'BUILDING' : 'REBUILDING');
    await repos.events.emit(project.projectId, {
      type: 'BUILD_STARTED', phase: 'MIGRATION', level: 'ACTIVITY', severity: 'INFO',
      stage: current.stage,
      title: `${iteration === 0 ? 'Building' : 'Rebuilding'} ${item.targetName}`,
      message: deps.commands.test,
      actor: 'TOOL', refs: { attemptId: attempt.attemptId },
    });

    current = await advance(repos, current, iteration === 0 ? 'RUNNING_TESTS' : 'RETESTING');
    // Live progress, read off the build's own output. The denominator comes
    // from the baseline, which recorded every test before anything moved — Maven
    // never announces how many classes it is about to run, which is why a
    // progress bar looked impossible until the baseline was the answer.
    const groups = buildGroups({
      baseline,
      approvedItems: [item],
      changes: await repos.migrationChanges.find({
        migrationRunId: current.migrationRunId,
      } as never) as never,
    });
    const tracker = new ProgressTracker(totalsFor({
      baseline,
      changes: await repos.migrationChanges.find({
        migrationRunId: current.migrationRunId,
      } as never) as never,
    }));

    const execution = await deps.baselines.execute(
      current, iteration === 0 ? 'INTEGRATION_TEST' : 'UNIT_TEST', deps.commands.test,
      {
        workdir: deps.workdir,
        onLine: (line) => {
          const event = parseLine(line, groups);
          if (!event) return;
          tracker.apply(event);
          void emitProgress(repos, project.projectId, current.stage, event, tracker);
        },
      },
    );
    await repos.migrationAttempts.collection.updateOne(
      { attemptId: attempt.attemptId } as never,
      { $addToSet: { executionRunIds: execution.execution.executionRunId } as never },
    );
    await repos.migrationRuns.collection.updateOne(
      { migrationRunId: current.migrationRunId } as never,
      {
        $set: {
          'metrics.testsPassing': execution.inventory.passed,
          'metrics.testsFailing': execution.inventory.failed,
        } as never,
        $inc: { 'metrics.cloudBuildAttempts': 1 } as never,
      },
    );

    // Pre-existing failures are never attributed to the migration (EXEC-INV-002).
    const known = new Set(baseline.tests.knownFailures.map((f) => f.testId));
    const newFailures = execution.inventory.tests.filter(
      (t) => t.status === 'FAILED' && !known.has(t.testId),
    );
    /*
     * A failing command is forgiven only when tests actually ran and every
     * failure among them was already failing on the base commit.
     *
     * This read `status === 'SUCCESS' || newFailures.length === 0`, and the
     * second clause is satisfied by the one state it must never accept: a build
     * that does not compile runs no tests, so it has no failures, so it passed.
     * The loop then reported "all tests green" over a tree whose main sources
     * did not build, and the lie held all the way to verification — which runs
     * its own build, fails, and reports a contradiction nobody can act on.
     *
     * `inventory.total > 0` is the missing half. It is only trustworthy because
     * the executor now discards the previous run's reports first; without that,
     * a compile failure inherits the last run's inventory and this check passes
     * on someone else's results.
     */
    const testsRan = execution.inventory.total > 0;
    const passed = execution.execution.status === 'SUCCESS'
      || (testsRan && newFailures.length === 0);

    if (passed) {
      await repos.events.emit(project.projectId, {
        type: 'TEST_PASSED', phase: 'MIGRATION', level: 'MILESTONE', severity: 'SUCCESS',
        stage: current.stage,
        title: `${item.targetName} — ${execution.inventory.passed}/${execution.inventory.total} passing`,
        message: known.size > 0
          ? `${known.size} pre-existing failure${known.size === 1 ? '' : 's'} unchanged and `
            + 'not attributed to the migration'
          : 'all tests green',
        actor: 'TOOL', refs: { attemptId: attempt.attemptId },
      });
      await closeAttempt(repos, attempt, 'SUCCEEDED');
      if (lastFailure) {
        await resolveThreadFor(deps, current, lastFailure);
      }
      return { run: current, completed: true, attempts, repairs };
    }

    // ---- 2b. Not every failing build is a defect -----------------------
    // A cryptographic primitive cannot be half-replaced across a call graph and
    // still produce a green suite. While the rest of this change set is
    // unapplied, a failure here is a mid-migration state, and diagnosing it
    // would ask the repair agent to make a correct-in-progress build green with
    // the other files still on the old primitive. The only edit that does that
    // is undoing the migration — which is exactly what kept happening.
    if (deferFailure) {
      await repos.events.emit(project.projectId, {
        type: 'TEST_FAILED', phase: 'MIGRATION', level: 'ACTIVITY', severity: 'INFO',
        stage: current.stage,
        title: `${item.targetName} applied — change set incomplete`,
        message: `${newFailures.length} test${newFailures.length === 1 ? '' : 's'} failing `
          + 'while the rest of this change set is unapplied. Not diagnosed: the suite is '
          + 'judged once every item in the set has landed.',
        actor: 'TOOL', refs: { attemptId: attempt.attemptId },
      });
      await closeAttempt(repos, attempt, 'FAILED');
      return { run: current, completed: false, deferred: true, attempts, repairs };
    }

    // ---- 3. Structure the evidence (spec §33, FR-4) --------------------
    const failure = structureFailure({
      execution: execution.execution,
      inventory: {
        ...execution.inventory,
        tests: newFailures.length > 0
          ? execution.inventory.tests.filter((t) => !known.has(t.testId))
          : execution.inventory.tests,
      },
      log: await readLog(deps, execution.execution.logGcsUri),
    });

    await repos.events.emit(project.projectId, {
      type: 'TEST_FAILED', phase: 'MIGRATION', level: 'MILESTONE', severity: 'ERROR',
      stage: current.stage,
      title: `${failure.failedTests[0]?.name ?? 'Build'} failed`,
      message: failureJson(failure, attempt.attemptNumber),
      actor: 'TOOL', refs: { attemptId: attempt.attemptId },
    });

    // ---- 4. Classify. Rules first, always (FR-5) -----------------------
    current = await advance(repos, current, 'ANALYZING_FAILURE');
    const classification = await classify(project, current, attempt, failure, baseline, item, deps);

    await repos.migrationAttempts.collection.updateOne(
      { attemptId: attempt.attemptId } as never,
      { $set: { failure, updatedAt: new Date() } as never },
    );

    // ---- 5. The retry budget (FR-8, FR-9, FR-10) -----------------------
    const thread = await recordAttempt(
      repos, current, classification, failure, attempt.attemptId,
    );

    await repos.events.emit(project.projectId, {
      type: 'FAILURE_DIAGNOSED', phase: 'MIGRATION', level: 'MILESTONE',
      severity: classification.permitAutonomousRepair ? 'WARN' : 'ERROR',
      stage: 'ANALYZING_FAILURE',
      title: `${classification.classification.replace(/_/g, ' ')} — ${classification.ruleId}`,
      message: [
        classification.rationale.split('\n')[0],
        classification.countsTowardRetryBudget
          ? `Attempt ${thread.display}`
          : 'Not charged to the retry budget',
      ].join(' · '),
      actor: classification.source === 'MODEL' ? 'AGENT' : 'SYSTEM',
      refs: { attemptId: attempt.attemptId },
    });

    if (thread.exhausted) {
      // Non-blocking by rule: four failures on this problem say nothing about
      // the rest of the approved scope.
      const { gate } = await openGate(
        repos,
        retryBudgetGate(current, thread.thread.problemKey, thread.thread.meaningfulAttempts,
          classification, failure),
        thread.thread.problemKey,
      );
      await closeAttempt(repos, attempt, 'ESCALATED');
      await resolveThread(repos, thread.thread.problemKey, current.migrationRunId, 'ESCALATED');
      return {
        run: current, completed: false, attempts, repairs,
        reason: `retry budget exhausted after ${thread.thread.meaningfulAttempts} attempts`,
        gateId: gate.gateId,
      };
    }

    // ---- 6. Repair authorisation (FR-11) -------------------------------
    const authorisation = authoriseRepair(
      engine, classification, thread.thread.meaningfulAttempts,
    );

    if (!authorisation.permitted) {
      const gateInput = gateFor(current, classification, failure, baseline);
      const { gate } = await openGate(repos, gateInput, `${item.planItemId}-${classification.classification}`);
      await closeAttempt(repos, attempt, 'ESCALATED');
      return {
        run: current, completed: false, attempts, repairs,
        reason: authorisation.reason, gateId: gate.gateId,
      };
    }

    // EXEC-REP-003 — replace the failed approach rather than layering on it.
    if (authorisation.revertFirst && lastChangeId) {
      await revertChange(deps, current, attempt, lastChangeId);
    }

    await closeAttempt(repos, attempt, 'FAILED');
    priorAttempts = [...priorAttempts, {
      summary: lastFailure ? `repair for ${lastFailure.classification.classification}` : item.action,
      outcome: failure.error.slice(0, 160),
    }].slice(-4);
    lastFailure = { failure, classification };
    current = await advance(repos, current, 'REPAIRING');

    await repos.events.emit(project.projectId, {
      type: 'AUTONOMOUS_REPAIR_STARTED', phase: 'MIGRATION', level: 'ACTIVITY', severity: 'INFO',
      stage: 'REPAIRING',
      title: `Repairing — ${classification.classification.replace(/_/g, ' ').toLowerCase()}`,
      // EXEC-ESC-005, visibly: the agent states what it is doing rather than
      // asking whether it may.
      message: `Authorised by ${authorisation.citedRuleIds.join(', ')}. `
        + `${authorisation.revertFirst ? 'Reverting the previous attempt first. ' : ''}`
        + 'No approval is required for reversible work inside the branch.',
      actor: 'AGENT', refs: { attemptId: attempt.attemptId },
    });
  }

  return {
    run: current, completed: false, attempts, repairs,
    reason: `no resolution after ${MAX_ITERATIONS} iterations`,
  };
}

// ---------------------------------------------------------------------------

/** Applies A3's patch, checked against the approved scope before it lands. */
async function applyPatch(
  project: Project,
  run: MigrationRun,
  attempt: MigrationAttempt,
  item: PlanItem,
  assessment: Assessment,
  baseline: Baseline,
  deps: ItemDeps,
) {
  const declared = item.expectedChanges.flatMap((c) => c.paths);
  const files = await readFiles(deps.wc, declared);
  const acceptanceTests = await readFiles(
    deps.wc,
    (await deps.wc.files())
      .filter((f) => f.kind === 'TEST')
      .map((f) => f.path)
      .slice(0, 6),
  );

  const patch = await deps.migrationAgent.produce({
    planItem: item,
    files,
    acceptanceTests,
    invariants: baseline.invariants,
    // What it must keep working, including the callers it may not edit.
    apiSurface: await apiSurfaceOf(deps.wc).catch(() => []),
    // From what discovery established, not from constants. The stack was
    // hardcoded here while the profile sat unread on the project — so the agent
    // was told "Java" and never "Java 17", and proposed an API that arrived in
    // Java 21.
    ...stackOf(project),
    ...(targetOf(assessment, item) ? { target: targetOf(assessment, item)! } : {}),
  });

  assertWithinScope(patch.files.map((f) => f.path), declared, item);

  for (const f of patch.files) await deps.git.writeFile(f.path, f.content);

  const change = await deps.recorder.commit({
    run, attempt,
    changeType: patch.changeType,
    intent: 'MIGRATION',
    summary: patch.summary,
    rationale: patch.rationale,
    paths: patch.files.map((f) => f.path),
    commitMessage: `feat(pqc): ${patch.summary}`,
    findingIds: patch.findingIds,
    planItemIds: [item.planItemId],
  });

  await deps.repos.events.emit(project.projectId, {
    type: 'PATCH_APPLIED', phase: 'MIGRATION', level: 'MILESTONE', severity: 'INFO',
    stage: run.stage,
    title: `Modification #${change.sequence} — ${patch.summary}`,
    message: patch.rationale,
    actor: 'AGENT',
    refs: { attemptId: attempt.attemptId, changeId: change.changeId,
            paths: patch.files.map((f) => f.path) },
  });
  return change;
}

/** Applies A3's repair, through the same guardrails as a generated test. */
async function applyRepair(
  project: Project,
  run: MigrationRun,
  attempt: MigrationAttempt,
  item: PlanItem,
  baseline: Baseline,
  last: { failure: StructuredFailure; classification: Classification },
  priorAttempts: Array<{ summary: string; outcome: string }>,
  deps: ItemDeps,
) {
  const implicated = [
    ...new Set([
      ...last.failure.failedTests.map((t) => t.name.split('#')[0] ?? ''),
      ...item.expectedChanges.flatMap((c) => c.paths),
    ]),
  ].filter(Boolean);

  const files = await readFiles(deps.wc, await resolvePaths(deps.wc, implicated));

  const repair = await deps.migrationAgent.repair({
    failure: last.failure,
    classification: last.classification.classification,
    classificationRuleId: last.classification.ruleId,
    classificationRationale: last.classification.rationale,
    authorisedRuleIds: [last.classification.ruleId, 'EXEC-REP-001', 'EXEC-REP-002'],
    ...stackOf(project),
    files,
    invariants: baseline.invariants,
    apiSurface: await apiSurfaceOf(deps.wc).catch(() => []),
    priorAttempts,
  });

  // A repair to a test, mock or fixture goes through the same guard a generated
  // test does. This is the path spec §26 is actually about — the agent under
  // pressure to make a red suite green.
  for (const f of repair.files) {
    if (!/^(TEST|MOCK|FIXTURE)$/.test(repair.changeType)) continue;
    const verdict = guardTestArtifact({
      path: f.path,
      changeType: repair.changeType,
      testKind: repair.changeType === 'MOCK' ? 'MOCK' : 'CHARACTERIZATION',
      content: f.content,
      ...(repair.testIntegrity ? { testIntegrity: repair.testIntegrity } : {}),
    }, { invariants: baseline.invariants });

    if (!verdict.allowed) {
      throw new PatchRefused(
        `repair refused: ${verdict.refusals.map((r) => `${r.ruleId} — ${r.reason}`).join('; ')}`,
      );
    }
  }

  for (const f of repair.files) await deps.git.writeFile(f.path, f.content);

  const integrity = repair.testIntegrity ?? (
    /^(TEST|MOCK|FIXTURE)$/.test(repair.changeType)
      ? {
          failureClassification: last.classification.classification,
          reason: last.classification.rationale.split('\n')[0] ?? last.classification.ruleId,
          // Asserted by the rule where the rule knows, rather than left to the
          // agent that wants the edit permitted.
          baselineRequirementChanged: last.classification.baselineRequirementChanged ?? false,
          safeAutonomousModification: true,
        }
      : undefined);

  const change = await deps.recorder.commit({
    run, attempt,
    changeType: repair.changeType,
    intent: 'REPAIR',
    summary: repair.summary,
    // EXEC-REP-002 — the authorisation is part of the record, so a repair cannot
    // be confused with the agent trying things until the suite went green.
    rationale: `${repair.rationale}\n\nAuthorised by ${last.classification.ruleId} `
      + `(${last.classification.classification}), EXEC-REP-001, EXEC-REP-002.`,
    paths: repair.files.map((f) => f.path),
    commitMessage: `fix(pqc): ${repair.summary}`,
    planItemIds: [item.planItemId],
    ...(integrity ? { testIntegrity: integrity } : {}),
  });

  await deps.repos.events.emit(project.projectId, {
    type: 'AUTONOMOUS_REPAIR_COMPLETED', phase: 'MIGRATION',
    level: 'MILESTONE', severity: 'SUCCESS',
    stage: run.stage,
    title: `Modification #${change.sequence} — ${repair.summary}`,
    message: `${last.classification.classification} · authorised by ${last.classification.ruleId}`,
    actor: 'AGENT',
    refs: { attemptId: attempt.attemptId, changeId: change.changeId,
            paths: repair.files.map((f) => f.path) },
  });
  return change;
}

/**
 * Classifies a failure: rules first, then the model, then a gate.
 *
 * The order is `EXEC-DIAG-001` and it is a correctness requirement rather than a
 * preference — `makeProblemKey` takes the classification as input, so a
 * classification that varies between identical attempts makes the retry budget
 * unenforceable.
 */
async function classify(
  project: Project,
  run: MigrationRun,
  attempt: MigrationAttempt,
  failure: StructuredFailure,
  baseline: Baseline,
  item: PlanItem,
  deps: ItemDeps,
): Promise<Classification> {
  const ctx = await diagnosisContext(failure, baseline, item, deps);
  const facts = factsForFailure(failure, ctx);

  const deterministic = classifyDeterministically(deps.engine, facts);
  if (deterministic) return deterministic;

  // Only now, and only for the residue.
  const changed = await deps.repos.migrationChanges.collection
    .find({ attemptId: attempt.attemptId } as never).toArray();

  const answer = await deps.diagnostician.diagnose({
    failure,
    invariants: baseline.invariants,
    changedFiles: (changed as unknown as Array<{ files: Array<{ path: string }> }>)
      .flatMap((c) => c.files.map((f) => ({ path: f.path, diff: '' }))),
    attemptNumber: attempt.attemptNumber,
  });

  const diagnosis: Diagnosis = {
    classification: answer.classification,
    rootCause: answer.rootCause,
    reasoning: answer.reasoning,
    withinAutonomousBoundary: answer.withinAutonomousBoundary,
    baselineRequirementChanged: answer.baselineRequirementChanged,
    proposedAction: answer.proposedAction,
    evidenceIds: [],
    modelRef: { model: answer.model, agentActionId: `act_${attempt.attemptId}` },
  };
  await deps.repos.migrationAttempts.collection.updateOne(
    { attemptId: attempt.attemptId } as never,
    { $set: { diagnosis, updatedAt: new Date() } as never },
  );

  // EXEC-DIAG-008: a low-confidence answer is not acted on. Neither is one that
  // says the cause is outside what this run may change, or that fixing it would
  // alter required behaviour — both of those are decisions, not repairs.
  if (!answer.actionable || !answer.withinAutonomousBoundary
      || answer.baselineRequirementChanged) {
    const refused = unclassified(deps.engine);
    return {
      ...refused,
      classification: answer.actionable ? answer.classification : 'UNKNOWN',
      source: 'MODEL',
      rationale: `${answer.rootCause} — ${
        !answer.actionable
          ? `confidence ${answer.confidence.toFixed(2)} is below the floor for autonomous action`
          : answer.baselineRequirementChanged
            ? 'fixing this would change a required behaviour'
            : 'the cause is outside the migration branch'
      }.`,
    };
  }

  return {
    classification: answer.classification,
    ruleId: 'EXEC-DIAG-001',
    source: 'MODEL',
    permitAutonomousRepair: true,
    countsTowardRetryBudget: answer.classification !== 'ENVIRONMENT_FAILURE',
    requiresTestIntegrityRecord: false,
    baselineRequirementChanged: false,
    rationale: answer.rootCause,
  };
}

/** The facts a classifier needs, all read from the tree, the diff or the failure. */
async function diagnosisContext(
  failure: StructuredFailure,
  baseline: Baseline,
  item: PlanItem,
  deps: ItemDeps,
): Promise<DiagnosisContext> {
  void item;

  // What this run has changed so far. The discriminator between EXEC-DIAG-002
  // (the agent's own change did not compile) and EXEC-DIAG-009 (build tooling
  // failed on a file it never touched).
  const changes = await deps.repos.migrationChanges.collection
    .find({ migrationRunId: baseline.migrationRunId } as never)
    .toArray() as unknown as Array<{ files: Array<{ path: string }> }>;

  const referencingFiles: DiagnosisContext['referencingFiles'] = [];

  // Which files actually assert the legacy algorithm. EXEC-DIAG-004 turns on all
  // of them being test or mock code — a production file asserting it means the
  // expectation is a real requirement, not an obsolete stand-in, and the rule
  // must not match. Read only when the failure mentions one at all.
  if (LEGACY_ALGORITHM.test(`${failure.error} ${failure.relevantLogs.join(' ')}`)) {
    for (const f of await deps.wc.files()) {
      if (f.sizeBytes > 200_000) continue;
      const content = await deps.wc.read(f.path).catch(() => '');
      if (LEGACY_ALGORITHM.test(content)) referencingFiles.push({ path: f.path, content });
    }
  }

  const nodes = await deps.repos.graphNodes.find({
    projectId: baseline.projectId,
  } as never) as unknown as Array<{ name: string; type: string }>;

  return {
    changedPaths: [...new Set(changes.flatMap((c) => c.files.map((f) => f.path)))],
    invariants: baseline.invariants,
    referencingFiles,
    externalNames: nodes.map((n) => ({ name: n.name, type: n.type })),
  };
}

/** Picks the gate a refused classification calls for. */
function gateFor(
  run: MigrationRun,
  classification: Classification,
  failure: StructuredFailure,
  baseline: Baseline,
) {
  if (classification.gateType === 'BASELINE_CONTRACT_CHANGE') {
    const invariant = touchedInvariant(failure, baseline.invariants);
    return baselineContractGate(
      run,
      invariant?.description ?? 'a recorded behavioural requirement',
      invariant?.assertion ?? failure.error,
      failure,
    );
  }
  return unclassifiedGate(run, failure);
}

/**
 * Rejects a patch that reaches outside what the human approved.
 *
 * `PlanItem.expectedChanges` is the autonomy contract, and verification checks
 * the same thing at the end. Checking here as well means the breach is caught
 * before it is committed, when it is still a refusal rather than a diff to undo.
 */
export function assertWithinScope(
  actual: string[],
  declared: string[],
  item: PlanItem,
): void {
  if (declared.length === 0) return; // Nothing declared, nothing to breach.
  const patterns = declared.map(toPattern);
  const outside = actual.filter((p) => !patterns.some((re) => re.test(p)));
  if (outside.length > 0) {
    throw new PatchRefused(
      `"${item.targetName}" declared ${declared.join(', ')} but the patch also changes `
      + `${outside.join(', ')}. The approved scope is a contract, not a starting point.`,
    );
  }
}

/**
 * A declared path pattern, as a matcher.
 *
 * `*` stops at a directory boundary and `**` crosses one, which is what a reader
 * of `src/main/java/pay/security/*.java` expects. Built by walking the glob
 * rather than by chained replaces, so a literal escaped in one pass cannot be
 * re-interpreted by the next.
 */
function toPattern(glob: string): RegExp {
  const SPECIAL = '.+^${}()|[]\\?';
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i++;
      } else {
        out += '[^/]*';
      }
    } else if (SPECIAL.includes(c)) {
      out += `\\${c}`;
    } else {
      out += c;
    }
  }
  return new RegExp(`^${out}$`);
}

async function readFiles(
  wc: WorkingCopy,
  paths: string[],
): Promise<Array<{ path: string; content: string }>> {
  const out: Array<{ path: string; content: string }> = [];
  for (const path of [...new Set(paths)].filter((p) => !p.includes('*')).slice(0, 10)) {
    const content = await wc.read(path).catch(() => null);
    if (content !== null) out.push({ path, content: content.slice(0, 20_000) });
  }
  return out;
}

/** `pay.security.CryptoServiceTest` → its file, where one exists. */
async function resolvePaths(wc: WorkingCopy, names: string[]): Promise<string[]> {
  const files = await wc.files();
  const out: string[] = [];
  for (const name of names) {
    if (name.includes('/')) { out.push(name); continue; }
    const suffix = `${name.replace(/\./g, '/')}.`;
    const match = files.find((f) => f.path.includes(suffix));
    if (match) out.push(match.path);
  }
  return out;
}

function targetOf(assessment: Assessment, item: PlanItem) {
  void assessment;
  return targetOfItem(item);
}

/**
 * The build log, for the diagnosis.
 *
 * An empty return is not fatal — `structureFailure` falls back to the excerpt
 * stored on the ExecutionRun — but it is worth saying out loud. This used to
 * swallow the reason entirely, so a bucket that had stopped answering looked
 * exactly like a build that printed nothing, and the agent was handed an empty
 * log either way with no indication which had happened.
 */
async function readLog(deps: ItemDeps, gcsUri: string | undefined): Promise<string> {
  if (!gcsUri) return '';
  const path = gcsUri.replace(/^gs:\/\/[^/]+\//, '');
  try {
    return (await deps.blobs.get(path)).toString('utf8');
  } catch (e) {
    deps.log.warn(
      { gcsUri },
      `could not read the build log, diagnosing from the stored excerpt: ${(e as Error).message}`,
    );
    return '';
  }
}

async function revertChange(
  deps: ItemDeps,
  run: MigrationRun,
  attempt: MigrationAttempt,
  changeId: string,
): Promise<void> {
  /*
   * The working copy first, then the record.
   *
   * This used to mark the change REVERTED in Mongo and touch nothing else, so
   * the feed said "reverting the previous attempt" while every file stayed
   * exactly as that attempt had left it. The next repair was then written
   * against a tree it had been told was clean — which is how a test came to call
   * `new PartnerHandshakeMock(String)` against a no-arg constructor, and how the
   * loop produced the stacked partial fixes EXEC-REP-003 exists to prevent
   * while quoting EXEC-REP-003 in the event.
   *
   * A failed revert is reported and does not stop the attempt: the alternative
   * is abandoning a run over a git operation, and the next build will surface
   * whatever state the tree is in.
   */
  await deps.git.revertLastCommit(`attempt ${attempt.attemptNumber}`).catch(async (e) => {
    await deps.repos.events.emit(run.projectId, {
      type: 'PATCH_APPLIED', phase: 'MIGRATION', level: 'DETAIL', severity: 'WARN',
      stage: 'REPAIRING',
      title: 'Could not revert the previous attempt',
      message: `${(e as Error).message} — the next patch is written on top of it.`,
      actor: 'SYSTEM', refs: { attemptId: attempt.attemptId, changeId },
    }).catch(() => undefined);
  });

  await deps.repos.migrationChanges.collection.updateOne(
    { changeId } as never,
    { $set: { verificationOutcome: 'REVERTED', updatedAt: new Date() } as never },
  );
  await deps.repos.events.emit(run.projectId, {
    type: 'PATCH_APPLIED', phase: 'MIGRATION', level: 'ACTIVITY', severity: 'INFO',
    stage: 'REPAIRING',
    title: 'Reverting the previous attempt before trying a different approach',
    message: 'EXEC-REP-003: stacked partial fixes make the diff unreviewable and the next '
      + 'failure harder to classify.',
    actor: 'AGENT', refs: { attemptId: attempt.attemptId, changeId },
  });
}

async function resolveThreadFor(
  deps: ItemDeps,
  run: MigrationRun,
  last: { failure: StructuredFailure; classification: Classification },
): Promise<void> {
  const { makeProblemKey } = await import('@proteus/schema');
  await resolveThread(
    deps.repos,
    makeProblemKey({
      classification: last.classification.classification,
      ...(last.failure.failedTests[0]?.name
        ? { failedTest: last.failure.failedTests[0].name }
        : {}),
      error: last.failure.error,
    }),
    run.migrationRunId,
  );
}

/**
 * One feed line per thing that happened, while it is happening.
 *
 * `DETAIL` because spec §38 splits the live activity stream from the audit
 * trail by level, and thirty suite lines belong in the drawer rather than in
 * the milestone feed beside "migration approved". The screen reads them and
 * renders the grouped bars; the milestone feed stays legible.
 */
async function emitProgress(
  repos: Repositories,
  projectId: string,
  stage: MigrationRun['stage'],
  event: ReturnType<typeof parseLine>,
  tracker: ProgressTracker,
): Promise<void> {
  if (!event) return;
  const snapshot = tracker.snapshot();
  const counted = snapshot.totals.known
    ? `${snapshot.testsFinished}/${snapshot.totals.tests} tests · `
      + `${snapshot.suitesFinished}/${snapshot.totals.suites} suites`
    // The baseline run has no denominator and says so, rather than rendering a
    // bar that cannot fill.
    : `${snapshot.suitesFinished} suites so far`;

  const [title, message, severity] = describe(event);
  if (!title) return;

  await repos.events.emit(projectId, {
    type: severity === 'ERROR' ? 'TEST_FAILED' : 'TEST_STARTED',
    phase: 'MIGRATION', level: 'DETAIL', severity,
    stage,
    title,
    message: `${message}${message ? ' · ' : ''}${counted}`,
    actor: 'TOOL', refs: {},
  }).catch(() => undefined);
}

function describe(
  event: NonNullable<ReturnType<typeof parseLine>>,
): [string, string, 'INFO' | 'SUCCESS' | 'ERROR'] {
  switch (event.kind) {
    case 'PHASE':
      return [event.phase, '', 'INFO'];
    case 'SUITE_STARTED':
      return [`${short(event.suite)}`, GROUP_LABEL[event.group], 'INFO'];
    case 'SUITE_FINISHED':
      return [
        `${short(event.suite)} — ${event.passed
          ? `${event.total} passed`
          : `${event.failures + event.errors} of ${event.total} failed`}`,
        `${GROUP_LABEL[event.group]} · ${event.seconds.toFixed(2)}s`,
        event.passed ? 'SUCCESS' : 'ERROR',
      ];
    case 'TEST_FAILED':
      // The one line that matters most, and the reason failures are worth
      // streaming at all: Surefire names the failing method, and nothing else
      // in the run does until the XML lands.
      return [`✗ ${event.method}`, short(event.suite), 'ERROR'];
    case 'FAILURE_DETAIL':
      return event.message ? [event.message, event.at ?? '', 'ERROR'] : ['', '', 'INFO'];
  }
}

const short = (suite: string): string => suite.split('.').pop() ?? suite;
