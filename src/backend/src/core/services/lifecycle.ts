import {
  COLLECTIONS, canTransitionLifecycle,
  type Project, type ProjectLifecycle, type SandboxDeployment,
} from '@proteus/schema';
import type { Repositories } from '../repositories';
import type { SecretVault } from '../../integrations/secrets/vault';
import type { SandboxDeployer } from '../../integrations/cloudrun/sandbox';
import { releaseSandbox } from './sandboxCapacity';

/**
 * Ending a project's life (PRD-17).
 *
 * Two actions with different audiences and one shared shape: neither removes a
 * row, both release the sandbox, and both are one-way.
 *
 * Archive makes a project read-only. Delete makes it invisible — a soft delete,
 * because removing one project across twenty-four collections is twenty-four
 * chances to miss one and the code this replaces already missed eighteen.
 * Setting one field cannot partially fail (D-022).
 *
 * Two things are still destroyed rather than hidden, and both for the same
 * reason: a project nobody can see must not leave anything running. The GitHub
 * token is destroyed, and the sandbox is torn down.
 */

export class LifecycleError extends Error {
  constructor(readonly code: 'BUSY' | 'ALREADY' | 'CONFIRM', message: string) {
    super(message);
    this.name = 'LifecycleError';
  }
}

/** Stages where a worker may hold a lease and still be writing. */
const BUSY_STAGES = ['ANALYZING', 'MIGRATING', 'VERIFYING'] as const;

/**
 * Whether anything is actually running.
 *
 * The stage alone is not the answer. A worker that died leaves the project in
 * `MIGRATING` for ever, and refusing to archive or delete on that basis means
 * a crashed run makes its project permanently undeletable — the guard protects
 * a process that no longer exists.
 *
 * `currentHolder` already treats an expired lease as unheld, so this asks the
 * question that matters: is someone holding this right now?
 */
async function liveHolder(repos: Repositories, projectId: string): Promise<string | null> {
  const rows = await repos.migrationRuns.collection
    .find({ projectId, status: { $in: ['RUNNING', 'PAUSED_FOR_HUMAN'] } } as never)
    .toArray() as unknown as Array<{ migrationRunId: string }>;

  for (const r of rows) {
    const holder = await repos.migrationLease.currentHolder(r.migrationRunId);
    if (holder) return holder;
  }
  return null;
}

export interface DeletionPreview {
  projectId: string;
  lifecycle: ProjectLifecycle;
  /** Rows that will become unreachable. Nothing is removed. */
  rows: Array<{ collection: string; count: number }>;
  totalRows: number;
  sandbox: { present: boolean; url?: string; placement?: string };
  credential: { present: boolean; secretName?: string };
}

export class LifecycleService {
  constructor(
    private readonly repos: Repositories,
    private readonly vault: SecretVault,
    /** Absent where hosting is not configured; teardown is then skipped. */
    private readonly deployerFor?: (d: SandboxDeployment) => SandboxDeployer,
  ) {}

  /**
   * Read-only from here on. The sandbox goes with it.
   *
   * Releasing the sandbox is not tidiness: an archived project cannot be
   * reviewed in a sandbox it no longer offers a link to, so retaining one would
   * hold a public URL and one of thirty platform slots for nothing (D-020).
   */
  async archive(project: Project, userId: string, confirm: string): Promise<Project> {
    this.assertConfirmed(project, confirm);
    this.assertTransition(project, 'ARCHIVED');
    await this.assertNotBusy(project);

    await this.releaseSandbox(project, 'REQUESTED');

    const at = new Date();
    await this.repos.projects.collection.updateOne(
      // Conditional on the version we read: a worker that took a lease between
      // the check and this write would otherwise have its progress overwritten.
      { projectId: project.projectId, version: project.version } as never,
      {
        $set: {
          lifecycle: 'ARCHIVED', archivedAt: at, archivedBy: userId, updatedAt: at,
          actionRequired: false,
          'summary.lastActivityAt': at,
          'summary.lastActivityText': 'Archived — read-only',
        } as never,
        $inc: { version: 1 } as never,
      },
    );

    await this.repos.events.emit(project.projectId, {
      type: 'PROJECT_ARCHIVED', phase: 'SYSTEM', level: 'MILESTONE', severity: 'INFO',
      title: 'Project archived',
      message: 'Read-only. Reports and evidence remain available.',
      actor: 'USER', refs: {},
    }).catch(() => undefined);

    return (await this.repos.projects.byId(project.projectId))!;
  }

  /**
   * Invisible from here on, and nothing else changes.
   *
   * The event is emitted before the lifecycle write, because after it the
   * project cannot be read back by the stream that would carry it.
   */
  async softDelete(project: Project, userId: string, confirm: string): Promise<void> {
    this.assertConfirmed(project, confirm);
    this.assertTransition(project, 'DELETED');
    await this.assertNotBusy(project);

    await this.repos.events.emit(project.projectId, {
      type: 'PROJECT_DELETED', phase: 'SYSTEM', level: 'MILESTONE', severity: 'WARN',
      title: 'Project deleted',
      message: 'Removed from the platform. Stored records are retained but unreachable.',
      actor: 'USER', refs: {},
    }).catch(() => undefined);

    await this.releaseSandbox(project, 'REQUESTED');
    await this.destroyCredential(project);

    const at = new Date();
    await this.repos.projects.collection.updateOne(
      { projectId: project.projectId } as never,
      {
        $set: {
          lifecycle: 'DELETED', deletedAt: at, deletedBy: userId, updatedAt: at,
          actionRequired: false,
        } as never,
        $inc: { version: 1 } as never,
      },
    );
  }

  /** What would happen, without anything happening. */
  async preview(project: Project): Promise<DeletionPreview> {
    const rows: Array<{ collection: string; count: number }> = [];

    // Enumerated from COLLECTIONS rather than a hand-written list, so a
    // collection added later appears here without anyone remembering to.
    for (const name of Object.values(COLLECTIONS)) {
      if (name === COLLECTIONS.users || name === COLLECTIONS.counters) continue;
      // The activity log is never deleted and is not part of this count.
      if (name === COLLECTIONS.userActivity) continue;
      const count = await this.repos.db
        .collection(name)
        .countDocuments({ projectId: project.projectId });
      if (count > 0) rows.push({ collection: name, count });
    }

    const sandbox = await this.liveSandbox(project);
    return {
      projectId: project.projectId,
      lifecycle: project.lifecycle,
      rows,
      totalRows: rows.reduce((n, r) => n + r.count, 0),
      sandbox: sandbox
        ? { present: true, ...(sandbox.service.url ? { url: sandbox.service.url } : {}),
            ...(sandbox.placement ? { placement: sandbox.placement } : {}) }
        : { present: false },
      credential: project.repository.credential
        ? { present: true, secretName: project.repository.credential.secretName }
        : { present: false },
    };
  }

  // -------------------------------------------------------------------------

  private assertConfirmed(project: Project, confirm: string): void {
    // Typed, not clicked. The one guardrail that survives a misplaced click on
    // an irreversible action.
    if (confirm !== project.projectId) {
      throw new LifecycleError('CONFIRM',
        `Type ${project.projectId} to confirm. This cannot be undone.`);
    }
  }

  private assertTransition(project: Project, to: ProjectLifecycle): void {
    const from: ProjectLifecycle = project.lifecycle ?? 'ACTIVE';
    if (from === to) {
      throw new LifecycleError('ALREADY', `This project is already ${to.toLowerCase()}.`);
    }
    if (!canTransitionLifecycle(from, to)) {
      throw new LifecycleError('ALREADY',
        `A ${from.toLowerCase()} project cannot become ${to.toLowerCase()}.`);
    }
  }

  /**
   * Refuses only while a worker is genuinely holding the run.
   *
   * Checked against the lease rather than the stage, because a stage outlives
   * the process that set it: a crashed migration would otherwise leave its
   * project undeletable for ever.
   */
  private async assertNotBusy(project: Project): Promise<void> {
    if (!(BUSY_STAGES as readonly string[]).includes(project.stage)) return;

    const holder = await liveHolder(this.repos, project.projectId);
    if (!holder) return;

    throw new LifecycleError('BUSY',
      `${project.projectId} is ${project.stage.toLowerCase()} and ${holder} is still `
      + 'working on it. Stop the migration first, or wait for it to finish — otherwise '
      + 'the run keeps writing to a project nobody can open.');
  }

  /**
   * Stops a migration, so its project can be archived or deleted.
   *
   * Marks the run ABANDONED and releases the lease. Nothing is rolled back: the
   * branch, the commits and the evidence stay exactly as the run left them,
   * because they are the record of what was attempted. This ends the run, it
   * does not undo it.
   */
  async stopMigration(project: Project, userId: string): Promise<{ stopped: number }> {
    const runs = await this.repos.migrationRuns.collection
      .find({
        projectId: project.projectId,
        status: { $in: ['RUNNING', 'PAUSED_FOR_HUMAN'] },
      } as never)
      .toArray() as unknown as Array<{ migrationRunId: string }>;

    const now = new Date();
    for (const run of runs) {
      await this.repos.migrationRuns.collection.updateOne(
        { migrationRunId: run.migrationRunId } as never,
        {
          $set: {
            status: 'ABANDONED', outcome: 'HUMAN_ACTION_REQUIRED',
            completedAt: now, updatedAt: now,
            // Cleared so nothing reads it as still held, and so a reaper does
            // not pick the run up and start a second worker on it.
            lease: { holder: 'stopped', expiresAt: now },
          } as never,
        },
      );
    }

    if (runs.length > 0) {
      await this.repos.projects.collection.updateOne(
        { projectId: project.projectId } as never,
        {
          $set: {
            stage: 'NEEDS_HUMAN_ACTION', stageEnteredAt: now, updatedAt: now,
            actionRequired: true,
            'summary.lastActivityAt': now,
            'summary.lastActivityText': 'Migration stopped',
          } as never,
          $inc: { version: 1 } as never,
        },
      );
      await this.repos.events.emit(project.projectId, {
        type: 'MIGRATION_STOPPED', phase: 'MIGRATION', level: 'MILESTONE', severity: 'WARN',
        title: 'Migration stopped',
        message: `Stopped by ${userId}. The branch and every change it made are kept — `
          + 'this ends the run, it does not undo it.',
        actor: 'USER', refs: {},
      }).catch(() => undefined);
    }

    return { stopped: runs.length };
  }

  private async liveSandbox(project: Project): Promise<SandboxDeployment | null> {
    const rows = await this.repos.sandboxDeployments.collection
      .find({ projectId: project.projectId, status: { $ne: 'TORN_DOWN' } } as never)
      .sort({ createdAt: -1 }).limit(1).toArray();
    return (rows[0] as SandboxDeployment | undefined) ?? null;
  }

  /**
   * Frees the slot, and reports rather than throws.
   *
   * A sandbox someone already deleted by hand must not stop the archive: the
   * point of both actions is that they complete.
   */
  private async releaseSandbox(project: Project, reason: 'REQUESTED'): Promise<void> {
    const deployment = await this.liveSandbox(project);
    if (!deployment || !this.deployerFor) return;
    await releaseSandbox(this.repos, this.deployerFor(deployment), deployment, reason)
      .catch(() => undefined);
  }

  /**
   * Destroys the token.
   *
   * A hidden project holding a live credential is a token nobody is watching on
   * a project nobody can see — exactly what the data model's credential rule
   * exists to prevent.
   */
  private async destroyCredential(project: Project): Promise<void> {
    const cred = project.repository.credential;
    if (!cred) return;
    await this.vault.destroy(cred.secretName).catch(() => undefined);
    await this.repos.projects.collection.updateOne(
      { projectId: project.projectId } as never,
      { $set: { 'repository.credential.status': 'REVOKED' } as never },
    );
  }
}

/**
 * Finds what the old hard delete left behind (PRD-17 risk 1).
 *
 * Reports, never removes. This increment's whole argument is that destroying
 * data is a deliberate act, and a sweep that quietly deleted rows on a schedule
 * would be the opposite of it.
 */
export async function findOrphans(repos: Repositories): Promise<{
  projectIds: string[];
  rows: Array<{ collection: string; count: number }>;
  strandedSandboxes: Array<{ projectId: string; url?: string }>;
}> {
  const known = new Set(
    (await repos.projects.collection.find({}, { projection: { projectId: 1 } } as never)
      .toArray()).map((p) => String((p as { projectId: string }).projectId)),
  );

  const orphanIds = new Set<string>();
  const rows: Array<{ collection: string; count: number }> = [];

  for (const name of Object.values(COLLECTIONS)) {
    if (name === COLLECTIONS.users || name === COLLECTIONS.counters) continue;
    const ids = (await repos.db.collection(name).distinct('projectId')) as string[];
    const missing = ids.filter((id) => id && !known.has(id));
    if (missing.length === 0) continue;
    missing.forEach((id) => orphanIds.add(id));
    rows.push({
      collection: name,
      count: await repos.db.collection(name).countDocuments({ projectId: { $in: missing } }),
    });
  }

  // The half that costs money and capacity rather than storage.
  const stranded = (await repos.sandboxDeployments.collection
    .find({ status: { $ne: 'TORN_DOWN' } } as never)
    .toArray()) as unknown as SandboxDeployment[];

  return {
    projectIds: [...orphanIds].sort(),
    rows,
    strandedSandboxes: stranded
      .filter((d) => !known.has(d.projectId))
      .map((d) => ({ projectId: d.projectId, ...(d.service.url ? { url: d.service.url } : {}) })),
  };
}
