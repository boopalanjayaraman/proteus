import {
  gcsPath, redactTokens,
  type AgentAction, type Artifact, type ArtifactKind, type Assessment, type Baseline,
  type ExecutionRun, type Finding, type HumanGate, type MigrationAttempt,
  type MigrationChange, type MigrationRun, type ProblemThread, type Project,
  type Recommendation, type SandboxDeployment, type VerificationResult,
} from '@proteus/schema';
import { ReportNarrator } from '../agent/flows/report';
import type { ModelClient } from '../agent/model';
import type { Logger } from '../config/logger';
import type { Repositories } from '../core/repositories';
import type { BlobStore } from '../integrations/storage/blobs';
import {
  buildEvidence, diffMeta, evidenceMeta, pagesOf, renderDiff,
} from '../reports/evidence';
import { buildSnapshot, renderMarkdown, type MigrationReportSnapshot } from '../reports/migration';

/**
 * The evidence package (spec §39, §40; `EXEC-VER-013`).
 *
 * Four artifacts, each referencing the ids the rule requires, and open
 * recommendations carried forward with their owners — which is the part most
 * likely to be quietly dropped, because a successful migration makes the items
 * it never touched feel irrelevant. They are not: the HSM still cannot do
 * ML-KEM, and the person who has to buy a new one needs to find that somewhere.
 *
 * The narrative is one model call over the finished snapshot. Every number and
 * the outcome itself are computed before it runs and cannot be reached by it.
 */

export interface ReportJobDeps {
  repos: Repositories;
  blobs: BlobStore;
  logger: Logger;
  /** Absent in tests that do not want prose; the report renders without it. */
  model?: ModelClient;
}

export interface ReportJobOutcome {
  artifacts: Artifact[];
  snapshot: MigrationReportSnapshot;
}

export async function runReport(
  project: Project,
  run: MigrationRun,
  deps: ReportJobDeps,
): Promise<ReportJobOutcome> {
  const { repos, blobs } = deps;
  const log = deps.logger.child({ projectId: project.projectId, job: 'report' });

  const ctx = await gather(project, run, repos);

  // The snapshot first, narrative second. The model is shown what the report
  // will print rather than the collections behind it, so it cannot describe
  // something a reader will not find.
  let snapshot = buildSnapshot({ project, run, ...ctx, eventCount: ctx.eventCount });

  if (deps.model) {
    try {
      snapshot = {
        ...snapshot,
        narrative: await new ReportNarrator(deps.model).narrate(snapshot),
      };
    } catch (e) {
      // A report without prose is still a complete report. Failing the whole
      // package because a sentence could not be written would lose the evidence
      // over the commentary.
      log.warn({ err: e }, 'narrative unavailable; rendering the report without it');
    }
  }

  const artifacts: Artifact[] = [];

  // ---- 1. The migration report ----------------------------------------
  const markdown = renderMarkdown(snapshot);
  artifacts.push(await write(project, run, deps, {
    kind: 'MIGRATION_REPORT',
    format: 'MARKDOWN',
    title: 'Migration report',
    body: Buffer.from(markdown, 'utf8'),
    contentType: 'text/markdown; charset=utf-8',
    extension: 'md',
    displayMeta: `${pagesOf(markdown)} PAGES · FULL AUDIT TRAIL`,
    stats: { pages: pagesOf(markdown) },
    contentSnapshot: snapshot as unknown as Record<string, unknown>,
    assessmentId: ctx.assessment.assessmentId,
  }));

  // ---- 2. The git diff -------------------------------------------------
  const patches = new Map<string, string>();
  for (const change of ctx.changes) {
    if (!change.diffGcsUri) continue;
    const path = change.diffGcsUri.replace(/^gs:\/\/[^/]+\//, '');
    const body = await blobs.get(path).catch(() => null);
    if (body) patches.set(change.changeId, body.toString('utf8'));
  }
  const diff = renderDiff(ctx.changes, patches);
  artifacts.push(await write(project, run, deps, {
    kind: 'GIT_DIFF',
    format: 'DIFF',
    title: 'Git diff',
    body: Buffer.from(diff.content, 'utf8'),
    contentType: 'text/x-diff; charset=utf-8',
    extension: 'diff',
    displayMeta: diffMeta(diff.stats),
    stats: diff.stats,
  }));

  // ---- 3. Build and test evidence --------------------------------------
  const evidence = buildEvidence(ctx.executions, ctx.attempts);
  artifacts.push(await write(project, run, deps, {
    kind: 'BUILD_TEST_EVIDENCE',
    format: 'JSON',
    title: 'Build & test evidence',
    body: Buffer.from(JSON.stringify(evidence, null, 2), 'utf8'),
    contentType: 'application/json',
    extension: 'json',
    displayMeta: evidenceMeta(evidence),
    stats: { buildAttempts: run.metrics.cloudBuildAttempts },
    contentSnapshot: evidence as unknown as Record<string, unknown>,
  }));

  // The assessment report is written by PRD-09 and is the fourth artifact; it is
  // not regenerated here, because it describes the scope as it was approved and
  // rewriting it now would let the outcome edit its own premise.

  await complete(project, run, snapshot, artifacts, deps);

  log.info(
    { artifacts: artifacts.length, outcome: snapshot.outcome.final },
    'evidence package written',
  );
  return { artifacts, snapshot };
}

// ---------------------------------------------------------------------------

interface Context {
  assessment: Assessment;
  findings: Finding[];
  baseline: Baseline | null;
  changes: MigrationChange[];
  attempts: MigrationAttempt[];
  problems: ProblemThread[];
  executions: ExecutionRun[];
  verification: VerificationResult | null;
  sandbox: SandboxDeployment | null;
  recommendations: Recommendation[];
  gates: HumanGate[];
  agentActions: AgentAction[];
  eventCount: number;
}

async function gather(
  project: Project,
  run: MigrationRun,
  repos: Repositories,
): Promise<Context> {
  const byRun = { migrationRunId: run.migrationRunId } as never;
  const byProject = { projectId: project.projectId } as never;

  const [
    assessment, findings, baseline, changes, attempts, problems,
    executions, verifications, sandboxes, recommendations, gates, agentActions, eventCount,
  ] = await Promise.all([
    repos.assessments.findOne({ assessmentId: run.approval.assessmentId } as never),
    repos.findings.find(byProject, 500) as Promise<Finding[]>,
    repos.baselines.findOne(byRun),
    repos.migrationChanges.collection.find(byRun).sort({ sequence: 1 })
      .toArray() as unknown as Promise<MigrationChange[]>,
    repos.migrationAttempts.collection.find(byRun).sort({ attemptNumber: 1 })
      .toArray() as unknown as Promise<MigrationAttempt[]>,
    repos.problemThreads.collection.find(byRun).sort({ firstSeenAt: 1 })
      .toArray() as unknown as Promise<ProblemThread[]>,
    repos.executionRuns.find(byRun, 200) as Promise<ExecutionRun[]>,
    repos.verificationResults.collection.find(byRun).sort({ verifiedAt: -1 }).limit(1)
      .toArray() as unknown as Promise<VerificationResult[]>,
    repos.sandboxDeployments.collection.find(byRun).sort({ createdAt: -1 }).limit(1)
      .toArray() as unknown as Promise<SandboxDeployment[]>,
    // Open ones only. `EXEC-VER-013` requires them carried forward, and a closed
    // recommendation has been dealt with — reprinting it would bury the live ones.
    repos.recommendations.find({
      projectId: project.projectId, status: { $ne: 'CLOSED' },
    } as never) as Promise<Recommendation[]>,
    repos.humanGates.find(byProject) as Promise<HumanGate[]>,
    repos.agentActions.find(byProject, 500) as Promise<AgentAction[]>,
    repos.events.count(byProject),
  ]);

  if (!assessment) throw new Error(`${run.migrationRunId}: approved assessment is missing`);

  return {
    assessment,
    findings,
    baseline: baseline ?? null,
    changes,
    attempts,
    problems,
    executions,
    verification: verifications[0] ?? null,
    sandbox: sandboxes[0] ?? null,
    recommendations,
    gates,
    agentActions,
    eventCount,
  };
}

interface WriteInput {
  kind: ArtifactKind;
  format: Artifact['format'];
  title: string;
  body: Buffer;
  contentType: string;
  extension: string;
  displayMeta: string;
  stats?: Artifact['stats'];
  contentSnapshot?: Record<string, unknown>;
  assessmentId?: string;
}

/**
 * Writes one artifact, redacted.
 *
 * `redactTokens` runs on the bytes as well as the document. The repository layer
 * already redacts what it stores, but an artifact's *content* goes to blob
 * storage without passing through it — and a build log is exactly the kind of
 * place a credential ends up. Design rule 8 has to hold on the file a user
 * downloads, not only on the record describing it.
 */
async function write(
  project: Project,
  run: MigrationRun,
  deps: ReportJobDeps,
  input: WriteInput,
): Promise<Artifact> {
  const artifactId = `art_${run.migrationRunId}_${input.kind.toLowerCase()}`;
  const now = new Date();

  const clean = Buffer.from(
    redactTokens({ body: input.body.toString('utf8') }).body,
    'utf8',
  );

  const stored = await deps.blobs.put(
    gcsPath.artifact(project.projectId, artifactId, input.extension),
    clean,
    input.contentType,
  );

  const artifact: Artifact = {
    _schemaVersion: 1, createdAt: now, updatedAt: now,
    artifactId,
    projectId: project.projectId,
    kind: input.kind,
    format: input.format,
    title: input.title,
    displayMeta: input.displayMeta,
    ...(input.stats ? { stats: input.stats } : {}),
    ...(input.assessmentId ? { assessmentId: input.assessmentId } : {}),
    // EXEC-VER-013's references live here: the run points at the baseline, the
    // approved assessment, the verification result and the sandbox.
    migrationRunId: run.migrationRunId,
    gcsUri: stored.gcsUri,
    sizeBytes: stored.sizeBytes,
    ...(input.contentSnapshot
      ? { contentSnapshot: redactTokens(input.contentSnapshot) }
      : {}),
    status: 'READY',
    generatedAt: now,
  };

  const existing = await deps.repos.artifacts.findOne({ artifactId } as never);
  if (existing) {
    await deps.repos.artifacts.collection.updateOne(
      { artifactId } as never,
      { $set: { ...artifact, createdAt: existing.createdAt } as never },
    );
  } else {
    await deps.repos.artifacts.insert(artifact);
  }
  return artifact;
}

/**
 * Moves the project to its final state.
 *
 * `EXEC-VER-013` puts this after the artifacts rather than before: a migration
 * is not complete until its evidence exists, because the evidence is the
 * deliverable.
 */
async function complete(
  project: Project,
  run: MigrationRun,
  snapshot: MigrationReportSnapshot,
  artifacts: Artifact[],
  deps: ReportJobDeps,
): Promise<void> {
  const { repos } = deps;
  const now = new Date();
  const verified = snapshot.outcome.final === 'VERIFIED';
  const report = artifacts.find((a) => a.kind === 'MIGRATION_REPORT');

  await repos.migrationRuns.collection.updateOne(
    { migrationRunId: run.migrationRunId } as never,
    {
      $set: {
        outcome: snapshot.outcome.final === 'VERIFIED'
          ? 'VERIFIED'
          : snapshot.outcome.final === 'PARTIALLY_MIGRATED'
            ? 'PARTIALLY_MIGRATED'
            : 'HUMAN_ACTION_REQUIRED',
        status: verified ? 'COMPLETED' : 'PAUSED_FOR_HUMAN',
        ...(verified && !run.completedAt ? { completedAt: now } : {}),
        updatedAt: now,
      } as never,
    },
  );

  await repos.projects.collection.updateOne({ projectId: project.projectId } as never, {
    $set: {
      ...(report ? { 'summary.latestArtifactId': report.artifactId } : {}),
      'summary.lastActivityAt': now,
      'summary.lastActivityText': verified
        ? 'Migration verified · evidence package ready'
        : `${snapshot.outcome.final.replace(/_/g, ' ').toLowerCase()} · evidence package ready`,
      updatedAt: now,
    } as never,
  });

  // SANDBOX_READY → COMPLETED. The transition is guarded, so a project that
  // never reached the sandbox stays where it is rather than jumping the rail.
  if (verified) {
    await repos.projects
      .transition(project.projectId, 'SANDBOX_READY', 'COMPLETED')
      .catch(() => undefined);
  }

  await repos.events.emit(project.projectId, {
    type: 'MIGRATION_COMPLETED', phase: 'SYSTEM', level: 'MILESTONE',
    severity: verified ? 'SUCCESS' : 'WARN',
    title: verified
      ? 'Evidence package ready'
      : `Evidence package ready — ${snapshot.outcome.final.replace(/_/g, ' ').toLowerCase()}`,
    message: [
      `${artifacts.length} artifact(s): ${artifacts.map((a) => a.title).join(', ')}`,
      `${snapshot.outcome.completionPct ?? 0}% autonomous completion · `
        + `${snapshot.outcome.humanEngineeringActions} human engineering action(s) · `
        + `${snapshot.outcome.autonomousRepairs} repair(s)`,
      snapshot.externalDependencies.length > 0
        ? `${snapshot.externalDependencies.length} recommendation(s) carried forward with owners`
        : '',
    ].filter(Boolean).join('\n'),
    actor: 'SYSTEM', refs: { ...(report ? { artifactId: report.artifactId } : {}) } as never,
  });
}
