import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { Logger } from '../config/logger';
import type { Repositories } from '../core/repositories';
import { installErrorHandler } from './errors';
import { requireAuth, type TokenVerifier } from './middleware/auth';
import { registerEventRoutes } from './routes/events';
import { registerHealthRoutes } from './routes/health';
import { registerMeRoutes } from './routes/me';
import { registerProjectRoutes } from './routes/projects';
import type { ProjectService } from '../core/services/projects';

export interface ServerOptions {
  repos: Repositories;
  projects: ProjectService;
  verifier: TokenVerifier;
  logger: Logger;
}

/**
 * The HTTP surface.
 *
 * Thin by design: routes validate, check ownership and delegate. Anything that
 * decides something belongs in `core/`, and anything that reasons belongs in
 * `agent/` — which this layer may start but never becomes.
 */
export async function buildServer(opts: ServerOptions): Promise<FastifyInstance> {
  const app = Fastify({
    // Typed as the base logger so route registrars are not coupled to pino's
    // concrete type, which otherwise propagates through every Fastify generic.
    loggerInstance: opts.logger as FastifyBaseLogger,
    // Cloud Run terminates TLS and forwards the client address here.
    trustProxy: true,
    // A long-lived SSE connection must not be timed out as a slow request.
    connectionTimeout: 0,
    requestTimeout: 0,
  });

  installErrorHandler(app);

  // Health is unauthenticated: a readiness probe has no credentials.
  registerHealthRoutes(app);

  await app.register(async (authed) => {
    authed.addHook('preHandler', requireAuth(opts.verifier));
    registerMeRoutes(authed, opts.repos);
    registerProjectRoutes(authed, opts.repos, opts.projects);
    registerEventRoutes(authed, opts.repos);
  });

  return app;
}
