import { initializeApp, getApps, applicationDefault } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ApiError } from '../errors';

/**
 * Firebase ID token verification.
 *
 * The verifier is an interface rather than a direct call so tests can supply
 * their own without a Firebase project. Verification is not something to mock at
 * the HTTP layer — the point of the tests is that a request without a valid
 * token cannot reach a handler, and that only holds if the middleware is real.
 */

export interface AuthenticatedUser {
  uid: string;
  email?: string;
  displayName?: string;
  photoUrl?: string;
}

export interface TokenVerifier {
  verify(idToken: string): Promise<AuthenticatedUser>;
}

export class FirebaseTokenVerifier implements TokenVerifier {
  constructor(projectId: string) {
    if (getApps().length === 0) {
      initializeApp({ credential: applicationDefault(), projectId });
    }
  }

  async verify(idToken: string): Promise<AuthenticatedUser> {
    const decoded = await getAuth().verifyIdToken(idToken);
    return {
      uid: decoded.uid,
      email: decoded.email,
      displayName: decoded.name as string | undefined,
      photoUrl: decoded.picture,
    };
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthenticatedUser;
  }
}

const BEARER = /^Bearer\s+(.+)$/i;

/**
 * Rejects anything without a valid token before a handler sees it.
 *
 * The reason for failure is logged but never returned: "token expired" and
 * "token malformed" are both 401 to the caller, because the difference is only
 * useful to someone probing.
 */
export function requireAuth(verifier: TokenVerifier) {
  return async (req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const header = req.headers.authorization;
    if (!header) throw ApiError.unauthorized('no Authorization header');

    const match = BEARER.exec(header);
    if (!match?.[1]) throw ApiError.unauthorized('Authorization header is not a Bearer token');

    try {
      req.user = await verifier.verify(match[1]);
    } catch (e) {
      throw ApiError.unauthorized(`token rejected: ${(e as Error).message}`);
    }
  };
}

export function currentUser(req: FastifyRequest): AuthenticatedUser {
  if (!req.user) throw ApiError.unauthorized('route reached without authentication');
  return req.user;
}
