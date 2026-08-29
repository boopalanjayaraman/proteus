import {
  COLLECTIONS, makeEdgeId, makeNodeId, rollUpEvidence,
  type Evidence, type GraphEdge, type GraphNode, type MigrationImpact,
  type NodeType, type RelationshipType,
} from '@proteus/schema';
import type { Repositories } from '../repositories';

/**
 * The PQC dependency graph.
 *
 * Written incrementally while discovery runs, so every write is an idempotent
 * upsert on a deterministic id. A streaming agent re-observes the same HSM from
 * three documents; without stable identity the graph would grow duplicates and
 * the screen it is the centrepiece of would degenerate into noise.
 */

export interface NodeAssertion {
  type: NodeType;
  canonicalName: string;
  subtitle?: string;
  note?: string;
  impact?: MigrationImpact;
  attributes?: Record<string, unknown>;
  evidenceIds?: string[];
  findingIds?: string[];
}

export interface EdgeAssertion {
  fromNodeId: string;
  toNodeId: string;
  relationship: RelationshipType;
  label?: string;
  impact?: MigrationImpact;
  evidenceIds?: string[];
  findingIds?: string[];
}

export interface UpsertResult {
  id: string;
  created: boolean;
}

export class GraphService {
  constructor(private readonly repos: Repositories) {}

  /**
   * Asserts a node.
   *
   * The caller supplies a canonical name and never an id — the slug is derived
   * here, which is what makes repeated observation converge rather than
   * accumulate. `$setOnInsert` fixes identity and first-seen order; `$addToSet`
   * merges evidence; `$set` refreshes what can legitimately change.
   */
  async upsertNode(projectId: string, a: NodeAssertion, seq: number): Promise<UpsertResult> {
    const nodeId = makeNodeId(a.type, a.canonicalName);
    const now = new Date();

    const result = await this.repos.graphNodes.collection.updateOne(
      { projectId, nodeId } as never,
      {
        $setOnInsert: {
          _schemaVersion: 1, createdAt: now, firstSeenAt: now,
          projectId, nodeId, type: a.type, name: a.canonicalName,
          // The reveal order on the live screen. Timestamps tie; a sequence
          // number does not, so replay reproduces the build-up exactly.
          sequence: seq,
        } as never,
        $set: {
          updatedAt: now,
          ...(a.subtitle !== undefined ? { subtitle: a.subtitle } : {}),
          ...(a.note !== undefined ? { note: a.note } : {}),
          ...(a.impact !== undefined ? { impact: a.impact } : {}),
          ...(a.attributes ? { attributes: a.attributes } : {}),
        } as never,
        $addToSet: {
          evidenceIds: { $each: a.evidenceIds ?? [] },
          findingIds: { $each: a.findingIds ?? [] },
        } as never,
      },
      { upsert: true },
    );

    await this.rollUp(projectId, COLLECTIONS.graphNodes, { nodeId });
    await this.repos.projects.bumpGraphVersion(projectId);
    return { id: nodeId, created: result.upsertedCount > 0 };
  }

  async upsertEdge(projectId: string, a: EdgeAssertion, seq: number): Promise<UpsertResult> {
    const edgeId = makeEdgeId(a.fromNodeId, a.relationship, a.toNodeId);
    const now = new Date();

    const result = await this.repos.graphEdges.collection.updateOne(
      { projectId, edgeId } as never,
      {
        $setOnInsert: {
          _schemaVersion: 1, createdAt: now, firstSeenAt: now,
          projectId, edgeId, fromNodeId: a.fromNodeId, toNodeId: a.toNodeId,
          relationship: a.relationship, sequence: seq,
        } as never,
        $set: {
          updatedAt: now,
          ...(a.label !== undefined ? { label: a.label } : {}),
          ...(a.impact !== undefined ? { impact: a.impact } : {}),
        } as never,
        $addToSet: {
          evidenceIds: { $each: a.evidenceIds ?? [] },
          findingIds: { $each: a.findingIds ?? [] },
        } as never,
      },
      { upsert: true },
    );

    await this.rollUp(projectId, COLLECTIONS.graphEdges, { edgeId });
    await this.repos.projects.bumpGraphVersion(projectId);
    return { id: edgeId, created: result.upsertedCount > 0 };
  }

  /**
   * Recomputes `evidenceClass` and `confidence` from the evidence cited.
   *
   * Denormalised onto the node so the canvas can dash an inferred edge without a
   * second query per edge. One observed record is enough to make the whole
   * assertion observed — a fact corroborated by reasoning is still a fact.
   */
  private async rollUp(
    projectId: string,
    collection: string,
    key: Record<string, string>,
  ): Promise<void> {
    const doc = (await this.repos.db.collection(collection).findOne({ projectId, ...key })) as
      | { evidenceIds?: string[] }
      | null;
    if (!doc?.evidenceIds?.length) return;

    const evidence = (await this.repos.db
      .collection(COLLECTIONS.evidence)
      .find({ projectId, evidenceId: { $in: doc.evidenceIds } })
      .toArray()) as unknown as Evidence[];
    if (evidence.length === 0) return;

    const { evidenceClass, confidence } = rollUpEvidence(evidence);
    await this.repos.db
      .collection(collection)
      .updateOne({ projectId, ...key }, { $set: { evidenceClass, confidence } });
  }

  /** What `GET /projects/:id/graph` returns, ordered as the screen reveals it. */
  async snapshot(projectId: string): Promise<{
    projectId: string; graphVersion: number; nodes: GraphNode[]; edges: GraphEdge[];
  }> {
    const [nodes, edges, project] = await Promise.all([
      this.repos.graphNodes.collection.find({ projectId } as never)
        .sort({ sequence: 1 }).toArray() as unknown as Promise<GraphNode[]>,
      this.repos.graphEdges.collection.find({ projectId } as never)
        .sort({ sequence: 1 }).toArray() as unknown as Promise<GraphEdge[]>,
      this.repos.projects.byId(projectId),
    ]);
    return { projectId, graphVersion: project?.graphVersion ?? 0, nodes, edges };
  }

  /**
   * Blast radius — what depends on this, transitively.
   *
   * The question the graph exists to answer (spec §9). Traverses edges backwards
   * from the node: `connectFromField: fromNodeId` walking to `toNodeId` finds
   * everything upstream of it.
   */
  async blastRadius(projectId: string, nodeId: string, maxDepth = 5): Promise<string[]> {
    const rows = await this.repos.graphEdges.collection
      .aggregate([
        { $match: { projectId, toNodeId: nodeId } },
        {
          $graphLookup: {
            from: COLLECTIONS.graphEdges,
            startWith: '$fromNodeId',
            connectFromField: 'fromNodeId',
            connectToField: 'toNodeId',
            as: 'upstream',
            maxDepth,
            restrictSearchWithMatch: { projectId },
          },
        },
      ])
      .toArray();

    const ids = new Set<string>();
    for (const row of rows as Array<{ fromNodeId: string; upstream: Array<{ fromNodeId: string }> }>) {
      ids.add(row.fromNodeId);
      for (const u of row.upstream) ids.add(u.fromNodeId);
    }
    return [...ids].sort();
  }

  /** A user's manual placement. Computed positions are never stored (data model §7). */
  async pin(
    projectId: string,
    nodeId: string,
    pin: { x: number; y: number; style: 'force' | 'radial' | 'blueprint' } | null,
  ): Promise<void> {
    await this.repos.graphNodes.collection.updateOne(
      { projectId, nodeId } as never,
      pin ? ({ $set: { pin } } as never) : ({ $unset: { pin: '' } } as never),
    );
  }

  async counts(projectId: string): Promise<{ nodes: number; edges: number }> {
    const [nodes, edges] = await Promise.all([
      this.repos.graphNodes.count({ projectId } as never),
      this.repos.graphEdges.count({ projectId } as never),
    ]);
    return { nodes, edges };
  }
}
