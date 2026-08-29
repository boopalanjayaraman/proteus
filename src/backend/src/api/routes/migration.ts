import {
  APPROVE_OPTION_ID, ApproveMigrationInput, ResolveGateInput,
  type Baseline, type ExecutionRun, type MigrationChange,
} from '@proteus/schema';
import type { FastifyInstance } from 'fastify';
import type { Repositories } from '../../core/repositories';
import { ApprovalError, type ApprovalService } from '../../core/services/approval';
import { StaleProjectError } from '../../core/repositories/projects';
import { ApiError } from '../errors';
import { currentUser } from '../middleware/auth';
import { loadOwnedProject } from '../middleware/ownership';

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
  /** Starts the migration once approved. Injected — this layer must not import `agent/`. */
  startMigration?: (projectId: string, migrationRunId: string) => void,
): void {
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

  app.post<{ Params: Params }>('/projects/:id/migration/approve', async (req, reply) => {
    const project = await loadOwnedProject(repos, req, req.params.id);
    const input = parse(req.body);

    const result = await run(() =>
      approvals.approve(project, currentUser(req).uid, input),
    );

    // A repeated approval is not an error — it is the same approval — so it
    // answers 200 with the run that exists rather than 409.
    if (result.created) startMigration?.(project.projectId, result.run.migrationRunId);
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
