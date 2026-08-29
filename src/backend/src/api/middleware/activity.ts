import { Screen } from '@proteus/schema';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ActivityContext, ActivityRecorder } from '../../core/services/activity';

/**
 * Turning a request into an activity context (PRD-15 FR-3).
 *
 * There is no write endpoint. Every entry is a side effect of a request the
 * backend already authenticated and served, which is a stronger guarantee than
 * the beacon this replaces: a browser cannot assert that something happened, it
 * can only say which screen it was on while something did.
 */

export const SCREEN_HEADER = 'x-proteus-screen';

declare module 'fastify' {
  interface FastifyRequest {
    activity?: ActivityContext;
  }
}

/**
 * The declared screen, or nothing.
 *
 * Validated against the closed enum and dropped otherwise — never stored as
 * free text, because an unvalidated header is a way to write arbitrary strings
 * into a field the activity screen searches and renders.
 */
export function declaredScreen(req: FastifyRequest): Screen | undefined {
  const raw = req.headers[SCREEN_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return undefined;
  const parsed = Screen.safeParse(value.trim().toUpperCase());
  return parsed.success ? parsed.data : undefined;
}

/** Present on every authenticated request; the recorder reads nothing else. */
export function activityContext(req: FastifyRequest): ActivityContext | undefined {
  return req.activity;
}

const PROJECT_IN_PATH = /\/projects\/(PQC-\d{4,})/;

export function projectInPath(url: string): string | undefined {
  return PROJECT_IN_PATH.exec(url)?.[1];
}

/**
 * Builds the context after authentication, and records the page visit after the
 * response.
 *
 * Two hooks rather than one. `preHandler` runs after `requireAuth`, so the uid
 * is known to every handler that wants to record something. `onResponse` runs
 * after the reply is sent, so a navigation write cannot add latency to the
 * request that triggered it — and a failed request still records the visit,
 * because "the user opened the sandbox screen and it 500'd" is exactly the
 * sequence an audit log exists to show.
 */
export function installActivityHooks(
  app: FastifyInstance,
  recorder: ActivityRecorder,
): void {
  app.addHook('preHandler', async (req) => {
    const user = req.user;
    if (!user) return;
    const screen = declaredScreen(req);
    req.activity = {
      userId: user.uid,
      userEmail: user.email ?? `${user.uid}@unknown.invalid`,
      requestId: String(req.id),
      ...(req.ip ? { ip: req.ip } : {}),
      ...(req.headers['user-agent'] ? { userAgent: String(req.headers['user-agent']) } : {}),
      ...(screen ? { screen } : {}),
    };
  });

  app.addHook('onResponse', async (req) => {
    const ctx = req.activity;
    if (!ctx?.screen) return;
    // The SSE stream is one request that stays open for the whole migration.
    // Recording it on close would date the visit to when the user left.
    if (req.url.endsWith('/stream')) return;
    void recorder.recordNavigation(
      { ...ctx, screen: ctx.screen },
      projectInPath(req.url),
    );
  });
}
