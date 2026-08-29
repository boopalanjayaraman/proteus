import type { Project } from '@proteus/schema';
import type { FastifyRequest } from 'fastify';
import type { Repositories } from '../../core/repositories';
import { ApiError } from '../errors';
import { currentUser } from './auth';

/**
 * Every project is owned, and ownership is checked on the server.
 *
 * A project the caller does not own returns 404, not 403 — a 403 confirms it
 * exists, which lets an authenticated user enumerate other tenants' ids by
 * probing. The two cases are distinguished in the log, where it is useful, and
 * nowhere the caller can see.
 */
export async function loadOwnedProject(
  repos: Repositories,
  req: FastifyRequest,
  projectId: string,
): Promise<Project> {
  const user = currentUser(req);
  const project = await repos.projects.byId(projectId);

  if (!project) {
    req.log.info({ projectId, uid: user.uid }, 'project not found');
    throw ApiError.notFound('Project');
  }
  if (project.ownerId !== user.uid) {
    req.log.warn(
      { projectId, uid: user.uid, ownerId: project.ownerId },
      'project access denied — returning 404 so existence is not confirmed',
    );
    throw ApiError.notFound('Project');
  }
  return project;
}
