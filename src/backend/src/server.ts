import { coreConfig, configuredFeatures, firebaseConfig } from './config/env';
import { createLogger } from './config/logger';
import { buildServer } from './api/server';
import { FirebaseTokenVerifier, type TokenVerifier } from './api/middleware/auth';
import { changeStreamsAvailable, connect, disconnect, redactUri } from './core/db/client';
import { ensureIndexes } from './core/db/indexes';
import { Repositories } from './core/repositories';

/**
 * Process entry point.
 *
 * Connects, creates indexes, reports what is configured, and serves. The banner
 * matters: a partly-configured environment is common during a build and should be
 * visible at startup rather than discovered by whichever request first needs the
 * missing setting.
 */
async function main(): Promise<void> {
  const core = coreConfig();
  const log = createLogger(core.LOG_LEVEL, core.NODE_ENV === 'development');

  const { db } = await connect(core.MONGODB_URI, core.MONGODB_DB);
  const indexes = await ensureIndexes(db);
  const repos = new Repositories(db);

  const features = configuredFeatures();
  log.info(
    {
      mongo: redactUri(core.MONGODB_URI),
      database: core.MONGODB_DB,
      indexes: `${indexes.created} across ${indexes.collections} collections`,
      changeStreams: changeStreamsAvailable(),
      features,
    },
    'proteus starting',
  );

  if (!changeStreamsAvailable()) {
    // Not fatal — the API still serves — but the live screens will silently stop
    // updating, which is worse than an error nobody sees.
    log.error(
      'change streams unavailable: MongoDB is not a replica set. Live discovery and ' +
        'migration screens will not update. See docs/pqc_migration_deployment_v1.md §3.',
    );
  }

  let verifier: TokenVerifier;
  try {
    verifier = new FirebaseTokenVerifier(firebaseConfig().FIREBASE_PROJECT_ID);
  } catch (e) {
    log.error((e as Error).message);
    throw e;
  }

  const app = await buildServer({ repos, verifier, logger: log });
  await app.listen({ port: core.PORT, host: '0.0.0.0' });
  log.info(`listening on :${core.PORT}`);

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      log.info(`${signal} — draining`);
      void app
        .close()
        .then(disconnect)
        .then(() => process.exit(0));
    });
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
