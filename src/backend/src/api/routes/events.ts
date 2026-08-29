import type { EventLevel } from '@proteus/schema';
import type { FastifyInstance } from 'fastify';
import type { Repositories } from '../../core/repositories';
import { loadOwnedProject } from '../middleware/ownership';
import { openEventStream, resumePoint } from '../sse/stream';

interface Params { id: string }
interface EventQuery { fromSeq?: string; level?: string; limit?: string }

/**
 * Reading the event log, and tailing it.
 *
 * Both are ownership-checked. A stream is a long-lived read of a project's
 * history, so it is exactly as sensitive as the history itself.
 */
export function registerEventRoutes(app: FastifyInstance, repos: Repositories): void {
  /** History. `level` filters the live feed from the audit trail (spec §38). */
  app.get<{ Params: Params; Querystring: EventQuery }>(
    '/projects/:id/events',
    async (req) => {
      await loadOwnedProject(repos, req, req.params.id);

      const fromSeq = Number(req.query.fromSeq ?? 0) || 0;
      const limit = Math.min(Number(req.query.limit ?? 200) || 200, 500);
      const levels = req.query.level?.split(',').filter(Boolean) as EventLevel[] | undefined;

      const events = await repos.events.since(req.params.id, fromSeq, limit);
      const filtered = levels?.length ? events.filter((e) => levels.includes(e.level)) : events;

      return { projectId: req.params.id, fromSeq, count: filtered.length, events: filtered };
    },
  );

  /**
   * The live tail.
   *
   * Fastify must not try to serialise or close this reply — the handler owns the
   * socket until the client goes away, so it returns `reply` to hand control over.
   */
  app.get<{ Params: Params; Querystring: EventQuery }>(
    '/projects/:id/stream',
    async (req, reply) => {
      await loadOwnedProject(repos, req, req.params.id);

      const fromSeq = resumePoint(
        req.headers as unknown as Record<string, unknown>,
        req.query,
      );
      req.log.info({ projectId: req.params.id, fromSeq }, 'sse stream opened');

      await openEventStream(repos, reply, req.params.id, fromSeq);
      return reply;
    },
  );
}
