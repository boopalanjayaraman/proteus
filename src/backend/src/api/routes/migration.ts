import {
  APPROVE_OPTION_ID, ApproveMigrationInput, ResolveGateInput,
  type Baseline, type ExecutionRun, type MigrationAttempt, type MigrationChange,
  type ProblemThread, type SandboxDeployment, type VerificationResult,
} from '@proteus/schema';
import type { FastifyInstance } from 'fastify';
import type { Repositories } from '../../core/repositories';
import { ApprovalError, type ApprovalService } from '../../core/services/approval';
import type { BlobStore } from '../../integrations/storage/blobs';
import type { SandboxDeployer } from '../../integrations/cloudrun/sandbox';
import { releaseSandbox, type SandboxCapacityService } from '../../core/services/sandboxCapacity';
import type { SandboxLifecycleService } from '../../core/services/sandboxLifecycle';
import { MAX_MEANINGFUL_AUTONOMOUS_ATTEMPTS } from '../../core/migration/problems';
import { StaleProjectError } from '../../core/repositories/projects';
import { ApiError } from '../errors';
import { currentUser } from '../middleware/auth';
import { loadOwnedProject } from '../middleware/ownership';
import { activityContext } from '../middleware/activity';
import type { ActivityRecorder } from '../../core/services/activity';

/**
 * The approval surface.
 *
 * Two endpoints reach the same service method. `POST /migration/approve` is the
 * one spec §44 names and the one the modal calls; `POST /decisions/:gateId` is
 * the generic gate resolution every later mid-migration gate will use, and it
 * routes an approval gate to the same place rather than growing a second path
 * through the same decision.
 */

interface Params { id: string }
interface GateParams extends Params { gateId: string }

export function registerMigrationRoutes(
  app: FastifyInstance,
  repos: Repositories,
  approvals: ApprovalService,
  blobs: BlobStore,
  /** Starts the migration once approved. Injected — this layer must not import `agent/`. */
  startMigration?: (projectId: string, migrationRunId: string) => void,
  /** Regenerates the evidence package. Injected for the same reason. */
  generateReport?: (projectId: string) => Promise<void>,
  /** Sandbox capacity and lifecycle. Absent where hosting is not configured. */
  capacity?: SandboxCapacityService,
  lifecycle?: SandboxLifecycleService,
  deployerFor?: (deployment: SandboxDeployment) => SandboxDeployer,
  activity?: ActivityRecorder,
): void {
  const record = (
    req: Parameters<typeof activityContext>[0],
    input: Parameters<ActivityRecorder['record']>[1],
  ) => {
    const ctx = activityContext(req);
    if (ctx && activity) void activity.record(ctx, input);
  };
  app.get<{ Params: Params }>('/projects/:id/gates', async (req) => {
    await loadOwnedProject(repos, req, req.params.id);
    const gates = await approvals.gates(req.params.id);
    return { count: gates.length, open: gates.filter((g) => g.status === 'OPEN').length, gates };
  });

  /** The run, once one exists. Absent before approval — spec §6, FR-9. */
  app.get<{ Params: Params }>('/projects/:id/migration', async (req) => {
    const project = await loadOwnedProject(repos, req, req.params.id);
    const run = project.current.migrationRunId
      ? await repos.migrationRuns.findOne({
          migrationRunId: project.current.migrationRunId,
        } as never)
      : null;
    if (!run) throw ApiError.notFound('Migration run');
    return { run };
  });

  /**
   * The baseline contract (spec §24).
   *
   * Returned with the executions that produced it, because a checklist a user
   * cannot trace back to a command that ran is a claim rather than evidence.
   */
  app.get<{ Params: Params }>('/projects/:id/baseline', async (req) => {
    await loadOwnedProject(repos, req, req.params.id);
    const rows = await repos.baselines.collection
      .find({ projectId: req.params.id } as never).sort({ capturedAt: -1 }).limit(1).toArray();
    const baseline = rows[0] as Baseline | undefined;
    if (!baseline) throw ApiError.notFound('Baseline');

    const executions = await repos.executionRuns.collection
      .find({
        executionRunId: { $in: [baseline.build.executionRunId, baseline.tests.executionRunId] },
      } as never)
      .toArray() as unknown as ExecutionRun[];

    return {
      baseline,
      // The full log stays in blob storage; the excerpt is what a screen shows.
      executions: executions.map(({ logExcerpt, ...rest }) => ({
        ...rest, logExcerpt: logExcerpt.slice(0, 20),
      })),
    };
  });

  /** Everything the agent has changed on the branch, newest first. */
  app.get<{ Params: Params }>('/projects/:id/changes', async (req) => {
    await loadOwnedProject(repos, req, req.params.id);
    const changes = await repos.migrationChanges.collection
      .find({ projectId: req.params.id } as never)
      .sort({ sequence: -1 })
      .toArray() as unknown as MigrationChange[];
    return { count: changes.length, changes };
  });

  /**
   * The attempt history — the audit trail of the loop.
   *
   * Each attempt carries its structured failure and its diagnosis, so "why did
   * the agent edit that test?" is answerable from data rather than from a
   * transcript. Ordered newest first, like the feed.
   */
  app.get<{ Params: Params }>('/projects/:id/migration/attempts', async (req) => {
    await loadOwnedProject(repos, req, req.params.id);
    const [attempts, threads] = await Promise.all([
      repos.migrationAttempts.collection
        .find({ projectId: req.params.id } as never)
        .sort({ attemptNumber: -1 })
        .toArray() as unknown as Promise<MigrationAttempt[]>,
      repos.problemThreads.collection
        .find({ projectId: req.params.id } as never)
        .sort({ firstSeenAt: 1 })
        .toArray() as unknown as Promise<ProblemThread[]>,
    ]);
    return {
      count: attempts.length,
      attempts,
      // The `n / 4` counter, per problem. Only meaningful attempts are counted,
      // so a run full of infrastructure flakes still shows zero.
      problems: threads.map((t) => ({
        problemKey: t.problemKey,
        classification: t.classification,
        signature: t.signature,
        meaningfulAttempts: t.meaningfulAttempts,
        budget: MAX_MEANINGFUL_AUTONOMOUS_ATTEMPTS,
        status: t.status,
      })),
    };
  });

  /** The branch diff, as the report and the review both need it. */
  app.get<{ Params: Params }>('/projects/:id/diff', async (req, reply) => {
    const project = await loadOwnedProject(repos, req, req.params.id);
    const changes = await repos.migrationChanges.collection
      .find({ projectId: req.params.id } as never)
      .sort({ sequence: 1 })
      .toArray() as unknown as MigrationChange[];

    const withDiffs = changes.filter((c) => c.diffGcsUri);
    if (withDiffs.length === 0) throw ApiError.notFound('Diff');

    const parts: string[] = [];
    for (const change of withDiffs) {
      const path = change.diffGcsUri!.replace(/^gs:\/\/[^/]+\//, '');
      const body = await blobs.get(path).catch(() => null);
      if (!body) continue;
      parts.push(
        `# Modification #${change.sequence} — ${change.summary}`,
        `# ${change.intent} · ${change.changeType} · ${change.commitSha ?? ''}`,
        body.toString('utf8'),
      );
    }

    record(req, {
      action: 'DIFF_DOWNLOADED',
      summary: `Downloaded the branch diff for ${project.projectId}`,
      target: `${project.projectId}-migration.diff`,
      projectId: project.projectId,
      detail: { modifications: withDiffs.length },
    });

    return reply
      .header('content-type', 'text/x-diff; charset=utf-8')
      .header('content-disposition',
        `attachment; filename="${project.projectId}-migration.diff"`)
      .send(parts.join('\n'));
  });

  /**
   * The verdict, with every check's provenance.
   *
   * `cryptoAssertions` comes back alongside but separate, because it carries a
   * `NOTED` state the nine gating checks do not — and conflating them on the
   * wire is how a screen ends up implying a noted residual is a failure.
   */
  app.get<{ Params: Params }>('/projects/:id/verification', async (req) => {
    await loadOwnedProject(repos, req, req.params.id);
    const rows = await repos.verificationResults.collection
      .find({ projectId: req.params.id } as never)
      .sort({ verifiedAt: -1 })
      .limit(1)
      .toArray() as unknown as VerificationResult[];
    const result = rows[0];
    if (!result) throw ApiError.notFound('Verification result');

    const cited = [...new Set(result.checks.map((c) => c.executionRunId).filter(Boolean))];
    const executions = await repos.executionRuns.collection
      .find({ executionRunId: { $in: cited } } as never)
      .toArray() as unknown as ExecutionRun[];

    return {
      result,
      // A check that cites an execution should be clickable through to it.
      executions: executions.map(({ logExcerpt, ...rest }) => ({
        ...rest, logExcerpt: logExcerpt.slice(0, 20),
      })),
    };
  });

  /** The sandbox. 404 until one is deployed, which requires a passing verdict. */
  app.get<{ Params: Params }>('/projects/:id/sandbox', async (req) => {
    await loadOwnedProject(repos, req, req.params.id);
    const rows = await repos.sandboxDeployments.collection
      .find({ projectId: req.params.id } as never)
      .sort({ createdAt: -1 })
      .limit(1)
      .toArray() as unknown as SandboxDeployment[];
    const sandbox = rows[0];
    if (!sandbox) throw ApiError.notFound('Sandbox deployment');
    return { sandbox };
  });

  /**
   * Regenerates the evidence package.
   *
   * Reproducible by construction: the report is a pure transform of a stored
   * snapshot, so regenerating after the fact produces the same bytes unless the
   * underlying state actually changed.
   */
  app.post<{ Params: Params }>('/projects/:id/report', async (req, reply) => {
    const project = await loadOwnedProject(repos, req, req.params.id);
    if (!generateReport) throw ApiError.badRequest('Report generation is not configured.');
    if (!project.current.migrationRunId) {
      throw ApiError.badRequest('No migration has run for this project yet.');
    }
    await generateReport(req.params.id);
    record(req, {
      action: 'ASSESSMENT_REGENERATED',
      summary: `Regenerated the evidence package for ${project.projectId}`,
      projectId: req.params.id,
    });
    return reply.status(202).send({ status: 'GENERATING' });
  });

  /**
   * Extends the sandbox, and records that it was opened.
   *
   * The "inactivity" clock. Called by the completion screen when a user follows
   * the link, so a sandbox under active review stays up and a forgotten one does
   * not — without needing Cloud Monitoring to tell us about traffic.
   */
  app.post<{ Params: Params }>('/projects/:id/sandbox/extend', async (req) => {
    await loadOwnedProject(repos, req, req.params.id);
    if (!lifecycle) throw ApiError.badRequest('Sandbox lifecycle is not configured.');

    const result = await lifecycle.extend(req.params.id);
    if (!result) throw ApiError.notFound('Sandbox deployment');

    // The completion screen calls this both when a user follows the link and
    // when they press Extend, so the two are recorded as what they are: opening
    // a sandbox is the access that resets the clock, extending is a request that
    // may hit the ceiling.
    record(req, result.extended
      ? {
          action: 'SANDBOX_EXTENDED',
          summary: result.atCeiling
            ? 'Extended the sandbox to its maximum lifetime'
            : 'Extended the sandbox',
          projectId: req.params.id,
          detail: { atCeiling: result.atCeiling },
        }
      : {
          action: 'SANDBOX_OPENED',
          summary: 'Opened the sandbox application',
          projectId: req.params.id,
        });

    return {
      expiresAt: result.deployment.expiresAt,
      hardExpiresAt: result.deployment.hardExpiresAt,
      extended: result.extended,
      // Said plainly rather than silently capping: a user who keeps clicking
      // extend deserves to know the ceiling exists.
      atCeiling: result.atCeiling,
    };
  });

  /** Tears down on demand — the way to free a slot without waiting for expiry. */
  app.delete<{ Params: Params }>('/projects/:id/sandbox', async (req, reply) => {
    await loadOwnedProject(repos, req, req.params.id);
    if (!deployerFor) throw ApiError.badRequest('Sandbox hosting is not configured.');

    const rows = await repos.sandboxDeployments.collection
      .find({ projectId: req.params.id } as never).sort({ createdAt: -1 }).limit(1).toArray();
    const deployment = rows[0] as SandboxDeployment | undefined;
    if (!deployment || deployment.status === 'TORN_DOWN') {
      throw ApiError.notFound('Sandbox deployment');
    }

    await releaseSandbox(repos, deployerFor(deployment), deployment, 'REQUESTED');
    record(req, {
      action: 'SANDBOX_TORN_DOWN',
      summary: 'Tore down the sandbox and freed the slot',
      target: deployment.service.url ?? deployment.service.name,
      projectId: req.params.id,
    });
    return reply.status(204).send();
  });

  /**
   * What is used and what is free.
   *
   * So the screen can say a sandbox will not be retained *before* someone starts
   * a migration rather than after — capacity is not a failure, but it is a
   * surprise if the first mention of it is in the report.
   */
  app.get('/sandbox/capacity', async (req) => {
    if (!capacity) return { configured: false };
    const state = await capacity.state(currentUser(req).uid);
    // A cap is not a failure — the migration still deploys, verifies and
    // releases (D-020) — but a user who hits one should be able to see when and
    // why the shareable link stopped appearing.
    if (state.canRetain === false) {
      record(req, {
        action: 'CAPACITY_REACHED',
        summary: state.boundBy === 'USER'
          ? `At the per-user sandbox limit (${state.perUserUsed}/${state.perUserLimit}) — `
            + 'the next migration will verify and release rather than retain'
          : `At the platform sandbox limit (${state.totalUsed}/${state.totalLimit}) — `
            + 'the next migration will verify and release rather than retain',
        outcome: 'DENIED',
        target: state.boundBy ?? 'PLATFORM',
      });
    }
    return { configured: true, ...state };
  });

  /**
   * Runs the approved migration again.
   *
   * Deliberately not a re-approval: the human decision is already recorded, and
   * sending someone back through discovery and assessment to change nothing
   * would regenerate a plan they had already authorised.
   */
  app.post<{ Params: Params }>('/projects/:id/migration/retry', async (req, reply) => {
    const project = await loadOwnedProject(repos, req, req.params.id);

    const result = await run(() => approvals.retry(project, currentUser(req).uid));
    startMigration?.(project.projectId, result.run.migrationRunId);

    record(req, {
      action: 'MIGRATION_RERUN',
      summary: `Retried the migration of ${project.name} — same approved scope`,
      target: result.run.branch.name,
      projectId: project.projectId,
      detail: {
        migrationRunId: result.run.migrationRunId,
        assessmentVersion: result.assessment.version,
      },
    });

    return reply.status(202).send({
      migrationRunId: result.run.migrationRunId,
      approvedPlanItemIds: result.run.approval.approvedPlanItemIds,
      status: 'RUNNING',
    });
  });

  app.post<{ Params: Params }>('/projects/:id/migration/approve', async (req, reply) => {
    const project = await loadOwnedProject(repos, req, req.params.id);
    const input = parse(req.body);

    const result = await run(() =>
      approvals.approve(project, currentUser(req).uid, input),
    );

    // A repeated approval is not an error — it is the same approval — so it
    // answers 200 with the run that exists rather than 409.
    if (result.created) startMigration?.(project.projectId, result.run.migrationRunId);

    // The single most important row in this collection. It is the one human
    // authorisation the whole product rests on, and the migration audit trail
    // records that it happened without recording who gave it.
    record(req, {
      action: result.created ? 'MIGRATION_APPROVED' : 'MIGRATION_RERUN',
      summary: result.created
        ? `Approved the migration of ${project.name} — ${result.run.approval.approvedPlanItemIds.length} plan items`
        : `Re-submitted an approval for ${project.name}; the existing run was returned`,
      target: result.run.branch.name,
      projectId: project.projectId,
      detail: {
        migrationRunId: result.run.migrationRunId,
        assessmentVersion: input.assessmentVersion,
        approvedItems: result.run.approval.approvedPlanItemIds.length,
      },
    });

    return reply.status(result.created ? 201 : 200).send({
      migrationRunId: result.run.migrationRunId,
      branch: result.run.branch.name,
      approvedPlanItemIds: result.run.approval.approvedPlanItemIds,
      approvedAt: result.run.approval.approvedAt,
      gateId: result.gate?.gateId,
      created: result.created,
    });
  });

  /**
   * Generic gate resolution.
   *
   * An approval gate needs the disclosure acknowledgement, so this path requires
   * the same body fields the dedicated endpoint does. Declining records the
   * answer and changes nothing else, which is the point of FR-10: a cancel has
   * no side effect beyond saying it happened.
   */
  app.post<{ Params: GateParams }>('/projects/:id/decisions/:gateId', async (req, reply) => {
    const project = await loadOwnedProject(repos, req, req.params.id);
    const gate = await repos.humanGates.findOne({
      projectId: req.params.id, gateId: req.params.gateId,
    } as never);
    if (!gate) throw ApiError.notFound('Gate');

    const decision = ResolveGateInput.safeParse(req.body);
    if (!decision.success) throw ApiError.badRequest('Request failed validation');
    if (!gate.options.some((o) => o.optionId === decision.data.optionId)) {
      throw ApiError.badRequest(
        `"${decision.data.optionId}" is not an option on this gate.`,
      );
    }

    if (gate.type === 'MIGRATION_APPROVAL' && decision.data.optionId === APPROVE_OPTION_ID) {
      const input = parse(req.body);
      const result = await run(() =>
        approvals.approve(project, currentUser(req).uid, input),
      );
      if (result.created) startMigration?.(project.projectId, result.run.migrationRunId);
      record(req, {
        action: result.created ? 'MIGRATION_APPROVED' : 'MIGRATION_RERUN',
        summary: `Approved the migration of ${project.name} at gate ${gate.gateId}`,
        target: gate.title,
        projectId: project.projectId,
        detail: { gateId: gate.gateId, migrationRunId: result.run.migrationRunId },
      });
      return reply.status(result.created ? 201 : 200).send({
        migrationRunId: result.run.migrationRunId, gateId: gate.gateId, created: result.created,
      });
    }

    if (gate.status !== 'OPEN') throw ApiError.conflict('That gate has already been resolved.');

    const now = new Date();
    await repos.humanGates.collection.updateOne({ gateId: gate.gateId } as never, {
      $set: {
        status: 'RESOLVED',
        resolution: {
          optionId: decision.data.optionId,
          ...(decision.data.note ? { note: decision.data.note } : {}),
          resolvedBy: currentUser(req).uid,
          resolvedAt: now,
        },
        updatedAt: now,
      } as never,
    });
    // A decline changes nothing else, which is the point — but it is still a
    // decision a person made, and the only place it is attributed to them.
    record(req, {
      action: gate.type === 'MIGRATION_APPROVAL' ? 'MIGRATION_DECLINED' : 'GATE_RESOLVED',
      summary: `${gate.title} — ${decision.data.optionId.toLowerCase().replace(/_/g, ' ')}`,
      target: gate.gateId,
      projectId: project.projectId,
      detail: { optionId: decision.data.optionId, gateType: gate.type },
    });

    await repos.events.emit(project.projectId, {
      type: 'HUMAN_GATE_RESOLVED', phase: 'MIGRATION', level: 'ACTIVITY', severity: 'INFO',
      title: `${gate.title} — ${decision.data.optionId.toLowerCase()}`,
      message: decision.data.note,
      actor: 'USER', refs: { gateId: gate.gateId },
    });

    return { gateId: gate.gateId, status: 'RESOLVED', optionId: decision.data.optionId };
  });
}

function parse(body: unknown): ApproveMigrationInput {
  const parsed = ApproveMigrationInput.safeParse(body);
  if (!parsed.success) {
    throw ApiError.badRequest(
      'Approval requires the assessment id, its version and the acknowledged disclosure.',
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    );
  }
  return parsed.data;
}

/**
 * Maps the service's refusals to status codes.
 *
 * A stale assessment and a project already past approval are both conflicts —
 * the request was well-formed and the caller's view of the world is behind.
 * A scope error is the caller asking for something that is not on offer.
 */
async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ApprovalError) {
      throw e.reason === 'STALE_ASSESSMENT' || e.reason === 'WRONG_STAGE'
        ? ApiError.conflict(e.message)
        : ApiError.badRequest(e.message);
    }
    // Lost the guarded transition to a concurrent approver.
    if (e instanceof StaleProjectError) {
      throw ApiError.conflict('This project has already been approved for migration.');
    }
    throw e;
  }
}
