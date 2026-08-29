import type { FastifyInstance } from 'fastify';
import type { GraphService } from '../../core/services/graph';
import type { Repositories } from '../../core/repositories';
import { ApiError } from '../errors';
import { loadOwnedProject } from '../middleware/ownership';

interface Params { id: string }
interface NodeParams extends Params { nodeId: string }

const MAX_EVIDENCE_IDS = 100;

export function registerGraphRoutes(
  app: FastifyInstance,
  repos: Repositories,
  graph: GraphService,
): void {
  /** Nodes and edges in reveal order, with the version a client uses to detect drift. */
  app.get<{ Params: Params }>('/projects/:id/graph', async (req) => {
    await loadOwnedProject(repos, req, req.params.id);
    return graph.snapshot(req.params.id);
  });

  /**
   * The evidence a node or a finding cites (spec §11, §16).
   *
   * Fetched by id rather than embedded, because the same record is cited by a
   * finding, a graph node and an edge — and duplicating it into each is what
   * makes "click the source and inspect it" three components instead of one.
   *
   * Scoped by `projectId` as well as by id. Ownership is already checked above,
   * but evidence ids are guessable strings and a query that filtered only on
   * them would return another tenant's citation to an authenticated caller.
   */
  app.get<{ Params: Params; Querystring: { ids?: string } }>(
    '/projects/:id/evidence',
    async (req) => {
      await loadOwnedProject(repos, req, req.params.id);

      const ids = (req.query.ids ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      if (ids.length === 0) return { evidence: [] };
      // A finding cites a handful and a node a few more. A caller asking for
      // hundreds is enumerating, not rendering.
      if (ids.length > MAX_EVIDENCE_IDS) {
        throw ApiError.badRequest(
          `Too many evidence ids: ${ids.length}. The limit is ${MAX_EVIDENCE_IDS}.`,
        );
      }

      const evidence = await repos.evidence.collection
        .find({ projectId: req.params.id, evidenceId: { $in: ids } } as never)
        .toArray();
      return { evidence };
    },
  );

  /** What depends on this node, transitively — the question the graph exists for. */
  app.get<{ Params: NodeParams }>('/projects/:id/graph/nodes/:nodeId/blast-radius', async (req) => {
    await loadOwnedProject(repos, req, req.params.id);
    const nodeId = decodeURIComponent(req.params.nodeId);
    return { nodeId, upstream: await graph.blastRadius(req.params.id, nodeId) };
  });

  /**
   * A dragged node. Only a deliberate placement is stored — computed positions
   * go stale on every insertion, and nodes are inserted continuously during
   * discovery (data model §7).
   */
  app.patch<{ Params: NodeParams; Body: { x: number; y: number; style: string } | null }>(
    '/projects/:id/graph/nodes/:nodeId/pin',
    async (req, reply) => {
      await loadOwnedProject(repos, req, req.params.id);
      const nodeId = decodeURIComponent(req.params.nodeId);

      if (req.body === null) {
        await graph.pin(req.params.id, nodeId, null);
        return reply.status(204).send();
      }
      const { x, y, style } = req.body;
      if (!['force', 'radial', 'blueprint'].includes(style)) {
        throw ApiError.badRequest(`Unknown layout style: ${style}`);
      }
      await graph.pin(req.params.id, nodeId, { x, y, style: style as 'force' });
      return reply.status(204).send();
    },
  );
}
