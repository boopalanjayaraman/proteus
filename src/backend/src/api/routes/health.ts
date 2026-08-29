import type { FastifyInstance } from 'fastify';
import { changeStreamsAvailable } from '../../core/db/client';
import { configuredFeatures } from '../../config/env';

/**
 * Unauthenticated liveness and configuration report.
 *
 * Reports which feature groups resolve, never a value from any of them. A
 * partly-configured environment should be visible here rather than discovered by
 * the first request that happens to need the missing setting.
 */
export function registerHealthRoutes(app: FastifyInstance): void {
  app.get('/healthz', async () => ({ status: 'ok' }));

  app.get('/readyz', async (_req, reply) => {
    const features = configuredFeatures();
    const changeStreams = changeStreamsAvailable();

    // Without change streams the live screens stop updating and nothing errors,
    // so it is a readiness failure rather than a warning.
    const ready = features.core && changeStreams;
    return reply.status(ready ? 200 : 503).send({
      status: ready ? 'ready' : 'degraded',
      features,
      changeStreams,
      ...(changeStreams
        ? {}
        : { warning: 'change streams unavailable — a replica set is required; live updates will not work' }),
    });
  });
}
