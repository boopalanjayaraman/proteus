import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { Logger } from '../config/logger';
import type { Project } from '@proteus/schema';
import type { Repositories } from '../core/repositories';
import { installErrorHandler } from './errors';
import { requireAuth, type TokenVerifier } from './middleware/auth';
import { registerEventRoutes } from './routes/events';
import { registerHealthRoutes } from './routes/health';
import { registerMeRoutes } from './routes/me';
import { registerAssessmentRoutes } from './routes/assessment';
import { registerGraphRoutes } from './routes/graph';
import { registerMigrationRoutes } from './routes/migration';
import { registerProjectRoutes } from './routes/projects';
import type { ApprovalService } from '../core/services/approval';
import type { AssessmentService } from '../core/services/assessment';
import type { GraphService } from '../core/services/graph';
import type { BlobStore } from '../integrations/storage/blobs';
import type { ProjectService } from '../core/services/projects';

export interface ServerOptions {
  repos: Repositories;
  projects: ProjectService;
  graph: GraphService;
  assessments: AssessmentService;
  approvals: ApprovalService;
  blobs: BlobStore;
  /** Regenerates an assessment. Needs the model, so it is injected. */
  regenerateAssessment?: (projectId: string) => Promise<void>;
  verifier: TokenVerifier;
  logger: Logger;
  /** Kicks off discovery after a project is created. Absent in tests that do not clone. */
  startDiscovery?: (project: Project) => void;
  /** Kicks off the migration once a human has approved it. PRD-11 supplies it. */
  startMigration?: (projectId: string, migrationRunId: string) => void;
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
    registerProjectRoutes(authed, opts.repos, opts.projects, opts.startDiscovery);
    registerGraphRoutes(authed, opts.repos, opts.graph);
    registerAssessmentRoutes(
      authed, opts.repos, opts.assessments, opts.blobs, opts.regenerateAssessment,
    );
    registerMigrationRoutes(authed, opts.repos, opts.approvals, opts.startMigration);
    registerEventRoutes(authed, opts.repos);
  });

  return app;
}
