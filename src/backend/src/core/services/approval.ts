import {
  APPROVE_OPTION_ID,
  AUTONOMOUS_PLAN_MODES,
  DECLINE_OPTION_ID,
  MIGRATION_DISCLOSURE_TEXT,
  MIGRATION_UNTOUCHED_STATEMENT,
  type ApproveMigrationInput,
  type Assessment,
  type HumanGate,
  type MigrationRun,
  type Project,
} from '@proteus/schema';
import type { Repositories } from '../repositories';

/**
 * The hinge.
 *
 * Everything before this point reads; everything after it writes to someone
 * else's repository. So the approval is not a button that sets a flag — it is a
 * record of a specific scope, pinned to the exact assessment version that was on
 * screen, naming the plan items authorised and the disclosure the user was shown.
 *
 * Three properties carry the weight:
 *
 *   PINNED       `assessmentId` AND `assessmentVersion`. A regenerated
 *                assessment supersedes its predecessor, and approving a
 *                superseded version is refused rather than silently upgraded —
 *                the user approved the scope they read, not the newer one.
 *   EXACTLY ONE  the run id is derived from the project and assessment version,
 *                so two concurrent approvals collide on a unique index and the
 *                loser reads the winner's run instead of creating a second.
 *   NOTHING ON   a refused approval writes nothing at all. The run is inserted
 *   REFUSAL      before the stage moves, so the only way to reach MIGRATING is
 *                through a run that already exists.
 */

export class ApprovalError extends Error {
  constructor(readonly reason: 'STALE_ASSESSMENT' | 'WRONG_STAGE' | 'DISCLOSURE_MISMATCH'
    | 'UNKNOWN_PLAN_ITEM' | 'NOT_AUTONOMOUS' | 'NO_ASSESSMENT',
    message: string) {
    super(message);
    this.name = 'ApprovalError';
  }
}

export interface ApprovalResult {
  run: MigrationRun;
  /** Null only on the idempotent path, if the run outlived its gate. */
  gate: HumanGate | null;
  assessment: Assessment;
  /** False when this call found an approval another request had already made. */
  created: boolean;
}

const LEASE_TTL_MS = 60_000;

/** `PQC-0184` → `agent/pqc/PQC-0184`, matching the branch the UX shows. */
export const branchNameFor = (projectId: string): string => `agent/pqc/${projectId}`;

const migrationRunId = (projectId: string, version: number): string =>
  `mig_${projectId}_v${version}`;

const approvalGateId = (projectId: string, version: number): string =>
  `gate_${projectId}_approval_v${version}`;

export class ApprovalService {
  constructor(private readonly repos: Repositories) {}

  /**
   * Opens the approval gate when an assessment becomes ready.
   *
   * The disclosure is copied onto the gate rather than referenced, so the audit
   * record says what was shown at the time even after the constant changes.
   * Gates for older versions are withdrawn: a regenerated assessment invalidates
   * the question the previous gate was asking.
   */
  async openApprovalGate(projectId: string, assessment: Assessment): Promise<HumanGate> {
    const now = new Date();
    const gateId = approvalGateId(projectId, assessment.version);

    await this.repos.humanGates.collection.updateMany(
      {
        projectId, type: 'MIGRATION_APPROVAL', status: 'OPEN', gateId: { $ne: gateId },
      } as never,
      { $set: { status: 'WITHDRAWN', updatedAt: now } as never },
    );

    const existing = await this.repos.humanGates.findOne({ gateId } as never);
    if (existing) return existing;

    const autonomous = assessment.planItems.filter(isAutonomous);
    const gate: HumanGate = {
      _schemaVersion: 1, createdAt: now, updatedAt: now,
      gateId, projectId,
      type: 'MIGRATION_APPROVAL',
      blocking: true,
      title: 'Authorize autonomous migration',
      question: 'Approve the proposed migration scope?',
      // The whole disclosure, frozen. `acknowledgedActions` on the run is the
      // other half of the pair: what was shown, and what was confirmed.
      context: [
        'You are approving the migration scope shown, not a generic instruction to start. '
        + 'After confirmation the agent will perform reversible engineering work without '
        + 'asking for routine approvals.',
        '',
        ...MIGRATION_DISCLOSURE_TEXT.map((t) => `- ${t}`),
        '',
        MIGRATION_UNTOUCHED_STATEMENT,
      ].join('\n'),
      evidenceIds: [],
      relatedFindingIds: [...new Set(autonomous.flatMap((p) => p.findingIds))],
      relatedChangeIds: [],
      options: [
        {
          optionId: APPROVE_OPTION_ID,
          label: 'Confirm & start migration',
          detail: MIGRATION_UNTOUCHED_STATEMENT,
          consequence: `Creates ${branchNameFor(projectId)} and begins autonomous engineering `
            + `on ${autonomous.length} plan item${autonomous.length === 1 ? '' : 's'}.`,
        },
        {
          optionId: DECLINE_OPTION_ID,
          label: 'Cancel',
          detail: 'Nothing changes. The assessment stays ready for approval.',
          consequence: 'The project remains awaiting approval and no branch is created.',
        },
      ],
      status: 'OPEN',
      openedAt: now,
    };

    await this.repos.humanGates.insert(gate);

    await this.repos.projects.collection.updateOne({ projectId } as never, {
      $inc: { 'summary.counts.openGates': 1 } as never,
      $set: { actionRequired: true, updatedAt: now } as never,
    });

    await this.repos.events.emit(projectId, {
      type: 'HUMAN_GATE_REQUIRED', phase: 'ASSESSMENT', level: 'MILESTONE', severity: 'WARN',
      title: 'Human approval required before migration',
      message: `Assessment v${assessment.version} · ${autonomous.length} autonomous plan items `
        + `· ${MIGRATION_DISCLOSURE_TEXT.length} disclosed actions`,
      actor: 'SYSTEM', refs: { gateId, assessmentId: assessment.assessmentId },
    });

    return gate;
  }

  async gates(projectId: string): Promise<HumanGate[]> {
    return this.repos.humanGates.collection
      .find({ projectId } as never)
      .sort({ openedAt: -1 })
      .toArray() as unknown as Promise<HumanGate[]>;
  }

  /**
   * Approves the migration.
   *
   * Every check runs before the first write. The order below is the order the
   * checks must happen in: stage, then assessment identity, then the disclosure,
   * then scope. A caller that fails any of them leaves the project exactly as it
   * found it.
   */
  async approve(
    project: Project,
    approvedBy: string,
    input: ApproveMigrationInput,
    holder = `worker-${Math.random().toString(36).slice(2, 10)}`,
  ): Promise<ApprovalResult> {
    const { projectId } = project;

    const assessment = await this.repos.assessments.findOne({
      projectId, assessmentId: input.assessmentId,
    } as never);
    if (!assessment) {
      throw new ApprovalError('NO_ASSESSMENT', 'That assessment does not belong to this project.');
    }

    // Version and status are both checked. The version catches a stale browser;
    // the status catches an assessment regenerated between render and click,
    // which leaves the version matching but the scope no longer current.
    if (assessment.version !== input.assessmentVersion) {
      throw new ApprovalError(
        'STALE_ASSESSMENT',
        `Assessment v${input.assessmentVersion} is not the version on file `
        + `(v${assessment.version}). Reload before approving.`,
      );
    }
    if (assessment.status === 'SUPERSEDED') {
      throw new ApprovalError(
        'STALE_ASSESSMENT',
        `Assessment v${assessment.version} has been superseded by a newer version. `
        + 'Review the current assessment before approving.',
      );
    }

    // Already approved: return what exists rather than approving twice. This is
    // what makes a retried request — or a second browser tab — harmless.
    const runId = migrationRunId(projectId, assessment.version);
    const already = await this.repos.migrationRuns.findOne({ migrationRunId: runId } as never);
    if (already) {
      const gate = await this.repos.humanGates.findOne({
        gateId: approvalGateId(projectId, assessment.version),
      } as never);
      return { run: already, gate, assessment, created: false };
    }

    if (project.stage !== 'AWAITING_APPROVAL') {
      throw new ApprovalError(
        'WRONG_STAGE',
        `A project in ${project.stage} cannot be approved for migration.`,
      );
    }

    assertDisclosureAcknowledged(input.acknowledgedActions);

    const approvedPlanItemIds = resolveScope(assessment, input.approvedPlanItemIds);

    const now = new Date();
    const run: MigrationRun = {
      _schemaVersion: 1, createdAt: now, updatedAt: now,
      migrationRunId: runId, projectId,
      approval: {
        assessmentId: assessment.assessmentId,
        assessmentVersion: assessment.version,
        approvedPlanItemIds,
        approvedBy,
        approvedAt: now,
        // Stored verbatim rather than as a version number: the point of the
        // record is that it can be read back years later without the code that
        // produced it.
        acknowledgedActions: [...input.acknowledgedActions],
      },
      branch: {
        name: branchNameFor(projectId),
        // The commit the assessment was built from, not HEAD. The approved scope
        // and the tree it applies to have to be the same tree.
        baseCommitSha: assessment.snapshot.repoCommitSha,
        pushed: false,
        commitCount: 0,
      },
      stage: 'PREPARING_MIGRATION',
      stageEnteredAt: now,
      status: 'RUNNING',
      attemptCount: 0,
      metrics: {
        testsPassing: 0, testsFailing: 0, autonomousRepairs: 0,
        humanGatesOpened: 0, cloudBuildAttempts: 0,
      },
      checkpoint: { stage: 'PREPARING_MIGRATION', at: now },
      // Taken here, not by the worker. The run must never exist unclaimed: an
      // unleased run in RUNNING looks identical to one whose worker died, and a
      // reaper would start a second migration on it.
      lease: { holder, expiresAt: new Date(now.getTime() + LEASE_TTL_MS) },
      startedAt: now,
    };

    try {
      await this.repos.migrationRuns.insert(run);
    } catch (e) {
      // The unique index on migrationRunId did its job: a concurrent approval
      // got there first. Its run is the one that counts.
      if (isDuplicateKey(e)) {
        const winner = await this.repos.migrationRuns.findOne({
          migrationRunId: runId,
        } as never);
        if (winner) {
          const gate = await this.repos.humanGates.findOne({
            gateId: approvalGateId(projectId, assessment.version),
          } as never);
          return { run: winner, gate, assessment, created: false };
        }
      }
      throw e;
    }

    const gate = await this.resolveGate(projectId, assessment, approvedBy, now);
    await this.markAssessmentApproved(assessment, approvedPlanItemIds, now);
    await this.advanceProject(project, assessment, run, now);

    await this.repos.events.emit(projectId, {
      type: 'MIGRATION_APPROVED', phase: 'MIGRATION', level: 'MILESTONE', severity: 'SUCCESS',
      title: `Migration approved — ${approvedPlanItemIds.length} plan item`
        + `${approvedPlanItemIds.length === 1 ? '' : 's'} authorised`,
      message: `Assessment v${assessment.version} · branch ${run.branch.name} · `
        + `base ${run.branch.baseCommitSha.slice(0, 7)} · approved scope recorded to audit trail`,
      actor: 'USER', refs: { gateId: gate.gateId, assessmentId: assessment.assessmentId },
    });
    await this.repos.events.emit(projectId, {
      type: 'HUMAN_GATE_RESOLVED', phase: 'MIGRATION', level: 'ACTIVITY', severity: 'INFO',
      title: 'Approval gate resolved',
      message: `${APPROVE_OPTION_ID} by ${approvedBy} · `
        + `${input.acknowledgedActions.length} disclosed actions acknowledged`,
      actor: 'USER', refs: { gateId: gate.gateId },
    });

    return { run, gate, assessment, created: true };
  }

  /** Records the human's answer on the gate that asked the question. */
  private async resolveGate(
    projectId: string,
    assessment: Assessment,
    resolvedBy: string,
    now: Date,
  ): Promise<HumanGate> {
    const gateId = approvalGateId(projectId, assessment.version);
    // The gate is normally opened when the assessment goes ready. An approval
    // arriving without one still needs somewhere to record consent, so it is
    // opened and resolved in the same breath rather than skipped.
    const existing = await this.repos.humanGates.findOne({ gateId } as never)
      ?? await this.openApprovalGate(projectId, assessment);

    await this.repos.humanGates.collection.updateOne({ gateId } as never, {
      $set: {
        status: 'RESOLVED',
        resolution: { optionId: APPROVE_OPTION_ID, resolvedBy, resolvedAt: now },
        updatedAt: now,
      } as never,
    });
    return { ...existing, status: 'RESOLVED', resolution: { optionId: APPROVE_OPTION_ID, resolvedBy, resolvedAt: now } };
  }

  /**
   * Marks the assessment approved and flags the authorised items.
   *
   * `approved` is written on every item, true or false — an unapproved item that
   * simply lacks the field is indistinguishable from one written before the
   * field existed, and execution has to be able to tell.
   */
  private async markAssessmentApproved(
    assessment: Assessment,
    approvedPlanItemIds: string[],
    now: Date,
  ): Promise<void> {
    const approved = new Set(approvedPlanItemIds);
    await this.repos.assessments.collection.updateOne(
      { assessmentId: assessment.assessmentId } as never,
      {
        $set: {
          status: 'APPROVED',
          planItems: assessment.planItems.map((p) => ({
            ...p, approved: approved.has(p.planItemId),
          })),
          updatedAt: now,
        } as never,
      },
    );
  }

  /**
   * Moves the project to MIGRATING.
   *
   * Guarded on the expected stage, so it is also the point at which a second
   * approver would lose. By the time this runs the run already exists, which is
   * why losing here is safe: the loser returns the winner's run rather than
   * finding a project in MIGRATING with nothing driving it.
   */
  private async advanceProject(
    project: Project,
    assessment: Assessment,
    run: MigrationRun,
    now: Date,
  ): Promise<void> {
    await this.repos.projects.transition(project.projectId, 'AWAITING_APPROVAL', 'MIGRATING', {
      stageDetail: 'PREPARING_MIGRATION',
      // The gate is answered; nothing is waiting on the user any more.
      actionRequired: false,
    } as never);

    await this.repos.projects.collection.updateOne({ projectId: project.projectId } as never, {
      $set: {
        'current.approvedAssessmentId': assessment.assessmentId,
        'current.migrationRunId': run.migrationRunId,
        'summary.migrationApproved': true,
        'summary.lastActivityAt': now,
        'summary.lastActivityText':
          `Migration approved — ${run.approval.approvedPlanItemIds.length} plan items authorised`,
      } as never,
      // The one approval, counted separately from engineering interventions —
      // "one approval, zero human engineering actions" is the product's claim
      // and it only holds if the approval never lands in the other counter.
      $inc: {
        'summary.autonomy.approvals': 1,
        'summary.counts.openGates': -1,
      } as never,
    });
  }
}

const isAutonomous = (p: { mode: string }): boolean =>
  (AUTONOMOUS_PLAN_MODES as readonly string[]).includes(p.mode);

/**
 * Rejects an acknowledgement that is not the disclosure this build shows.
 *
 * A stale tab showing last week's list would otherwise record consent to
 * something the user never read. Compared as sets, because the modal's two-column
 * layout does not fix an order.
 */
function assertDisclosureAcknowledged(acknowledged: readonly string[]): void {
  const got = [...new Set(acknowledged)].sort();
  const want = [...MIGRATION_DISCLOSURE_TEXT].sort();
  const missing = want.filter((t) => !got.includes(t));
  const extra = got.filter((t) => !want.includes(t));

  if (missing.length > 0 || extra.length > 0) {
    throw new ApprovalError(
      'DISCLOSURE_MISMATCH',
      'The disclosure you confirmed does not match the current one. Reload and review '
      + 'the actions before approving.',
    );
  }
}

/**
 * Resolves what was approved to a concrete set of plan item ids.
 *
 * Omitting the list approves every autonomous item, which is what the UX does.
 * Naming items narrows it. Naming an item outside the autonomy boundary is
 * refused rather than dropped — a user who thinks they authorised a hardware
 * replacement should be told they did not.
 */
function resolveScope(assessment: Assessment, requested?: string[]): string[] {
  const autonomous = assessment.planItems.filter(isAutonomous);
  if (!requested) return autonomous.map((p) => p.planItemId);

  const byId = new Map(assessment.planItems.map((p) => [p.planItemId, p]));
  for (const id of requested) {
    const item = byId.get(id);
    if (!item) {
      throw new ApprovalError(
        'UNKNOWN_PLAN_ITEM',
        `Plan item ${id} is not part of assessment v${assessment.version}.`,
      );
    }
    if (!isAutonomous(item)) {
      throw new ApprovalError(
        'NOT_AUTONOMOUS',
        `"${item.targetName}" is ${item.mode.replace(/_/g, ' ').toLowerCase()} and cannot be `
        + 'authorised for autonomous execution.',
      );
    }
  }
  return [...new Set(requested)];
}

function isDuplicateKey(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: number }).code === 11000;
}
