import type { Project } from '@proteus/schema';
import type { FastifyRequest } from 'fastify';
import type { Repositories } from '../../core/repositories';
import { ApiError } from '../errors';
import { currentUser } from './auth';
import { activityContext } from './activity';
import type { ActivityRecorder } from '../../core/services/activity';

/**
 * Set once at startup so every ownership check records without every call site
 * having to pass a recorder through. A module-level handle is the wrong shape
 * for a service with state; this one has none that matters, and the alternative
 * is threading an optional parameter through forty call sites.
 */
let recorder: ActivityRecorder | undefined;
export function setOwnershipRecorder(r: ActivityRecorder | undefined): void {
  recorder = r;
}

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
    // The entry most worth having. The caller is told nothing, which is the
    // point of the 404 — but somebody reaching for a project that exists and
    // is not theirs is exactly what an audit log is for, and the response
    // being indistinguishable from "not found" is why it cannot be inferred
    // from the access log afterwards.
    const ctx = activityContext(req);
    if (ctx && recorder) {
      void recorder.record(ctx, {
        action: 'ACCESS_DENIED',
        summary: `Attempted to open project ${projectId}, which belongs to another user`,
        target: projectId,
        outcome: 'DENIED',
        detail: { method: req.method, path: req.url.split('?')[0] ?? req.url },
      });
    }
    throw ApiError.notFound('Project');
  }
  assertMutable(req, project);
  return project;
}

/**
 * Loads a project for a platform admin, without the ownership check.
 *
 * Delete exists to clear other people's test projects, so requiring ownership
 * would make the admin gate meaningless — an admin can already delete their own
 * project through the owner path. Ownership is replaced by the role, not
 * dropped: the caller still has to be a platform admin, and a non-admin gets
 * the same 404 a non-owner would.
 */
export async function loadProjectAsAdmin(
  repos: Repositories,
  req: FastifyRequest,
  projectId: string,
): Promise<Project> {
  const user = currentUser(req);
  const me = await repos.users.findOne({ userId: user.uid } as never);

  if (me?.role !== 'PLATFORM_ADMIN') {
    req.log.warn({ uid: user.uid, projectId, path: req.url },
      'non-admin attempted an admin-only project action');
    const ctx = activityContext(req);
    if (ctx && recorder) {
      void recorder.record(ctx, {
        action: 'ACCESS_DENIED',
        summary: 'Attempted an admin-only project action without the platform admin role',
        target: projectId,
        projectId,
        outcome: 'DENIED',
        detail: { method: req.method, path: req.url.split('?')[0] ?? req.url },
      });
    }
    throw ApiError.notFound('Project');
  }

  const project = await repos.projects.byId(projectId);
  if (!project) throw ApiError.notFound('Project');
  return project;
}

/**
 * An archived project is read-only, and a deleted one does not exist.
 *
 * Inferred from the HTTP method rather than declared per route. There are ten
 * mutating endpoints and adding an eleventh is easy; a guard that has to be
 * remembered is a guard that will eventually be forgotten, and a disabled button
 * in the UI does nothing for a stale tab.
 *
 * Checked after ownership, so a project the caller does not own still answers
 * 404 rather than revealing that it exists and is archived.
 */
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** The two writes that are allowed to act ON an archived project's lifecycle. */
const LIFECYCLE_PATHS = /\/projects\/[^/]+(\/archive)?$/;

function assertMutable(req: FastifyRequest, project: Project): void {
  // `undefined` means the document predates the field, not that it is archived.
  // Getting this backwards turns the whole product read-only for older projects.
  if ((project.lifecycle ?? 'ACTIVE') === 'ACTIVE') return;
  if (READ_METHODS.has(req.method)) return;

  // POST /projects/:id/archive and DELETE /projects/:id — the actions whose
  // entire job is to change the lifecycle.
  const path = req.url.split('?')[0] ?? req.url;
  if (LIFECYCLE_PATHS.test(path)) return;

  throw new ApiError(
    409,
    'PROJECT_ARCHIVED',
    `${project.projectId} is archived and cannot be changed. `
    + 'Its reports and evidence remain available.',
  );
}
