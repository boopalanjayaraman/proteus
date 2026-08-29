import type { FastifyInstance } from 'fastify';
import type { GraphService } from '../../core/services/graph';
import type { Repositories } from '../../core/repositories';
import { ApiError } from '../errors';
import { loadOwnedProject } from '../middleware/ownership';

interface Params { id: string }
interface NodeParams extends Params { nodeId: string }

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
