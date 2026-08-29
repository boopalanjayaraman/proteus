import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * One error shape, and nothing internal in it.
 *
 * A stack trace or a driver message in a response body tells an attacker about
 * the shape of the system. The detail goes to the log with a correlation id; the
 * caller gets the id and a category.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  static unauthorized(detail?: string) {
    return new ApiError(401, 'UNAUTHENTICATED', 'Authentication required', detail);
  }

  /**
   * Used for a project the caller does not own as well as one that does not
   * exist. A 403 would confirm the project is real, which hands an authenticated
   * user a way to enumerate other tenants' ids. The distinction is logged.
   */
  static notFound(what = 'Resource') {
    return new ApiError(404, 'NOT_FOUND', `${what} not found`);
  }

  static badRequest(message: string, detail?: string) {
    return new ApiError(400, 'BAD_REQUEST', message, detail);
  }

  static conflict(message: string) {
    return new ApiError(409, 'CONFLICT', message);
  }
}

export interface ErrorBody {
  error: { code: string; message: string; requestId: string };
}

export function installErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err, req, reply) => {
    const requestId = req.id as string;

    if (err instanceof ApiError) {
      // `detail` never leaves the process.
      req.log.warn({ requestId, code: err.code, detail: err.detail }, err.message);
      return reply.status(err.status).send({
        error: { code: err.code, message: err.message, requestId },
      } satisfies ErrorBody);
    }

    const validation = (err as { validation?: unknown }).validation;
    if (validation) {
      req.log.warn({ requestId, validation }, 'request failed validation');
      return reply.status(400).send({
        error: { code: 'BAD_REQUEST', message: 'Request failed validation', requestId },
      } satisfies ErrorBody);
    }

    req.log.error({ requestId, err }, 'unhandled error');
    return reply.status(500).send({
      error: { code: 'INTERNAL', message: 'Internal error', requestId },
    } satisfies ErrorBody);
  });
}
