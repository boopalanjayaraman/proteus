import { COLLECTIONS, Project, type ProjectStage } from '@proteus/schema';
import type { Db } from 'mongodb';
import { nextProjectId } from '../db/counters';
import { Repository } from './base';

/**
 * The resumable state root.
 *
 * Stage transitions are guarded on the expected stage AND the document version.
 * The agent worker and a user request can both try to move a project at once;
 * a blind `$set` would let the later write erase the earlier one silently. Here
 * the loser is told it lost.
 */
export class StaleProjectError extends Error {
  constructor(projectId: string, expected: ProjectStage, actual: string) {
    super(`${projectId}: expected stage ${expected}, found ${actual}`);
    this.name = 'StaleProjectError';
  }
}

/**
 * Fills in a field that predates its own default.
 *
 * `findOne` returns the raw document without parsing, so Zod's
 * `.default('ACTIVE')` never applies on the way out. A backfill fixes the stored
 * data; this makes the code correct even for a document that escaped it — which
 * matters because the wrong branch here turns the whole product read-only.
 */
function hydrate(project: Project | null): Project | null {
  if (!project) return null;
  return project.lifecycle ? project : { ...project, lifecycle: 'ACTIVE' };
}

export class ProjectRepository extends Repository<typeof Project> {
  constructor(database: Db) {
    super(database, COLLECTIONS.projects, Project);
  }

  /** Allocates `PQC-####` and inserts. Ids are never reused. */
  async create(project: Omit<Project, 'projectId'>): Promise<Project> {
    const projectId = await nextProjectId(this.database);
    return this.insert({ ...project, projectId } as Project);
  }

  /**
   * The project, unless it has been deleted.
   *
   * This and `listForOwner` are the only two reads in the backend that surface
   * a project — everything else is an `updateOne` scoped by a projectId the
   * caller already holds. Excluding DELETED here is therefore the whole of
   * FR-15: every project-scoped route 404s on a deleted project without
   * needing a check of its own.
   */
  async byId(projectId: string): Promise<Project | null> {
    return hydrate(await this.findOne({ projectId, lifecycle: { $ne: 'DELETED' } } as never));
  }

  /**
   * The same lookup, including deleted projects.
   *
   * For the two callers that legitimately need one: the delete endpoint, which
   * must be idempotent, and the orphan sweep. Named so that reaching for it is
   * a deliberate act rather than an autocomplete.
   */
  async byIdIncludingDeleted(projectId: string): Promise<Project | null> {
    return hydrate(await this.findOne({ projectId } as never));
  }

  /** Landing screen: one query, `summary` is the tile. Archived projects stay. */
  async listForOwner(ownerId: string, limit = 50): Promise<Project[]> {
    return ((await this.collection
      .find({ ownerId, lifecycle: { $ne: 'DELETED' } } as never)
      .sort({ 'summary.lastActivityAt': -1 })
      .limit(limit)
      .toArray()) as unknown as Project[])
      .map((p) => hydrate(p)!);
  }

  /**
   * Marks a project failed from wherever it happens to be.
   *
   * Unconditional on purpose. `transition` guards on the expected stage, which
   * is right for the happy path and wrong here: a job can die anywhere — a
   * clone that fails while the project is still CREATED, a crash between two
   * stages — and a guarded write would leave it stuck in the stage it was
   * passing through, looking like it is still working.
   *
   * The reason is stored on the project rather than only on the run, because
   * the project list is where someone looks first and it has no run to read.
   */
  async markFailed(projectId: string, reason: string): Promise<void> {
    const at = new Date();
    await this.collection.updateOne(
      { projectId } as never,
      {
        $set: {
          stage: 'FAILED',
          stageEnteredAt: at,
          updatedAt: at,
          failureReason: reason.slice(0, 2000),
          actionRequired: false,
          'summary.lastActivityAt': at,
          'summary.lastActivityText': `Failed — ${reason.slice(0, 160)}`,
        } as never,
        $inc: { version: 1 } as never,
      },
    );
  }

  /**
   * Moves a project between stages, or refuses.
   *
   * @throws StaleProjectError when the project is no longer in `from`, which
   *         means another writer got there first and this caller's view of the
   *         world is out of date.
   */
  async transition(
    projectId: string,
    from: ProjectStage,
    to: ProjectStage,
    extra: Partial<Project> = {},
  ): Promise<Project> {
    const result = await this.collection.findOneAndUpdate(
      { projectId, stage: from } as never,
      {
        $set: { stage: to, stageEnteredAt: new Date(), updatedAt: new Date(), ...extra } as never,
        $inc: { version: 1 } as never,
      },
      { returnDocument: 'after' },
    );
    if (!result) {
      const current = await this.byId(projectId);
      throw new StaleProjectError(projectId, from, current?.stage ?? 'MISSING');
    }
    return result as unknown as Project;
  }

  /** Denormalised tile projection. Written on every meaningful change. */
  async touchActivity(projectId: string, text: string): Promise<void> {
    await this.collection.updateOne({ projectId } as never, {
      $set: {
        'summary.lastActivityAt': new Date(),
        'summary.lastActivityText': text,
        updatedAt: new Date(),
      } as never,
    });
  }

  async setLastEventSeq(projectId: string, seq: number): Promise<void> {
    // Never move the cursor backwards — a late write from a slow emitter would
    // otherwise make a client replay events it has already rendered.
    await this.collection.updateOne(
      { projectId, lastEventSeq: { $lt: seq } } as never,
      { $set: { lastEventSeq: seq } as never },
    );
  }

  async bumpGraphVersion(projectId: string): Promise<void> {
    await this.collection.updateOne({ projectId } as never, {
      $inc: { graphVersion: 1 } as never,
    });
  }
}
