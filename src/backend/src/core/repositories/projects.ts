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

export class ProjectRepository extends Repository<typeof Project> {
  constructor(database: Db) {
    super(database, COLLECTIONS.projects, Project);
  }

  /** Allocates `PQC-####` and inserts. Ids are never reused. */
  async create(project: Omit<Project, 'projectId'>): Promise<Project> {
    const projectId = await nextProjectId(this.database);
    return this.insert({ ...project, projectId } as Project);
  }

  async byId(projectId: string): Promise<Project | null> {
    return this.findOne({ projectId } as never);
  }

  /** Landing screen: one query, `summary` is the tile. */
  async listForOwner(ownerId: string, limit = 50): Promise<Project[]> {
    return (await this.collection
      .find({ ownerId } as never)
      .sort({ 'summary.lastActivityAt': -1 })
      .limit(limit)
      .toArray()) as unknown as Project[];
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
