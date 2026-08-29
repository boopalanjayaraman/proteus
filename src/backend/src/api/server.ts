import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import type { Logger } from '../config/logger';
import type { Project, SandboxDeployment } from '@proteus/schema';
import type { Repositories } from '../core/repositories';
import { installErrorHandler } from './errors';
import { requireAuth, type TokenVerifier } from './middleware/auth';
import { installActivityHooks } from './middleware/activity';
import { setOwnershipRecorder } from './middleware/ownership';
import { registerActivityRoutes } from './routes/activity';
import { ActivityRecorder } from '../core/services/activity';
import { registerEventRoutes } from './routes/events';
import { registerHealthRoutes } from './routes/health';
import { registerMaintenanceRoutes, registerMeRoutes } from './routes/me';
import { registerAssessmentRoutes } from './routes/assessment';
import { registerGraphRoutes } from './routes/graph';
import { registerMigrationRoutes } from './routes/migration';
import { registerProjectRoutes } from './routes/projects';
import type { ApprovalService } from '../core/services/approval';
import type { SandboxCapacityService } from '../core/services/sandboxCapacity';
import type { SandboxLifecycleService } from '../core/services/sandboxLifecycle';
import type { SandboxDeployer } from '../integrations/cloudrun/sandbox';
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
  /** Regenerates the evidence package. PRD-14 supplies it. */
  generateReport?: (projectId: string) => Promise<void>;
  /** Sandbox capacity, lifecycle and reclaim. PRD-16 supplies them. */
  capacity?: SandboxCapacityService;
  lifecycle?: SandboxLifecycleService;
  deployerFor?: (deployment: SandboxDeployment) => SandboxDeployer;
  sandboxSweep?: () => Promise<{
    scanned: number; reclaimed: string[];
    failed: Array<{ projectId: string; reason: string }>;
  }>;
  /** User activity. PRD-15 supplies it; constructed here when absent. */
  activity?: ActivityRecorder;
  /**
   * Browser origins allowed to call this API. Empty disables CORS entirely,
   * which is what the tests want — they call the server directly, and a
   * same-process fetch has no origin to check.
   */
  allowedOrigins?: string[];
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

  /**
   * CORS, because the frontend is never the same origin as this API.
   *
   * Vite serves the app on :5173 in development and Cloud Run or Firebase
   * Hosting serves it from its own domain in production — so every deployment
   * shape this product has is cross-origin, and without this the browser
   * refuses every call before it leaves the page.
   *
   * An allowlist rather than `*`. Requests carry a Firebase ID token in an
   * Authorization header, and `credentials` plus a wildcard is exactly the
   * combination that lets an unrelated page read a signed-in user's data.
   */
  if (opts.allowedOrigins?.length) {
    await app.register(cors, {
      origin: opts.allowedOrigins,
      methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      // The screen header PRD-15 added is a custom header, so a preflight will
      // ask about it by name and fail if it is not listed.
      allowedHeaders: ['authorization', 'content-type', 'x-proteus-screen'],
      maxAge: 3600,
    });
  }

  installErrorHandler(app);

  // Health is unauthenticated: a readiness probe has no credentials.
  registerHealthRoutes(app);

  // Always present, because a route that records conditionally is a route that
  // eventually stops recording. An empty admin list is a valid configuration.
  const activity = opts.activity ?? new ActivityRecorder(opts.repos);
  setOwnershipRecorder(activity);

  await app.register(async (authed) => {
    authed.addHook('preHandler', requireAuth(opts.verifier));
    // After requireAuth, so every hook and handler downstream has the uid.
    installActivityHooks(authed, activity);
    registerActivityRoutes(authed, opts.repos, activity);
    registerMeRoutes(authed, opts.repos, activity);
    registerMaintenanceRoutes(authed, opts.repos, opts.sandboxSweep);
    registerProjectRoutes(authed, opts.repos, opts.projects, opts.startDiscovery, activity);
    registerGraphRoutes(authed, opts.repos, opts.graph);
    registerAssessmentRoutes(
      authed, opts.repos, opts.assessments, opts.blobs, opts.regenerateAssessment, activity,
    );
    registerMigrationRoutes(
      authed, opts.repos, opts.approvals, opts.blobs,
      opts.startMigration, opts.generateReport,
      opts.capacity, opts.lifecycle, opts.deployerFor, activity,
    );
    registerEventRoutes(authed, opts.repos);
  });

  return app;
}
