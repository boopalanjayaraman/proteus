import {
  CreateProjectInput, FileKind, REDISCOVERABLE_STAGES, REQUIRED_GITHUB_SCOPES,
  UpdateProjectInput, railProgress, type Project,
} from '@proteus/schema';
import type { FastifyInstance } from 'fastify';
import type { ProjectService, UploadedFile } from '../../core/services/projects';
import { LifecycleError, type LifecycleService } from '../../core/services/lifecycle';
import type { Repositories } from '../../core/repositories';
import { ApiError } from '../errors';
import { currentUser } from '../middleware/auth';
import { loadOwnedProject, loadProjectAsAdmin } from '../middleware/ownership';
import { activityContext } from '../middleware/activity';
import type { ActivityRecorder } from '../../core/services/activity';

/**
 * Project routes.
 *
 * The credential rule made concrete: `POST` accepts a token in the body and
 * nothing here ever returns one. `GET` responses carry `displayPrefix` and
 * `status` — enough to recognise the credential, nowhere near enough to use it.
 */

interface Params { id: string }

interface CreateBody {
  name: string;
  repositoryUrl: string;
  defaultBranch?: string;
  githubToken: string;
  instructions?: string;
  files?: Array<{ kind: string; originalName: string; mimeType: string; contentBase64: string }>;
}

/** Strips the credential to what the UI is allowed to see. */
function present<T extends { repository: { credential?: unknown } }>(project: T) {
  const cred = project.repository.credential as
    | { displayPrefix: string; status: string; declaredScopes: string[]; rotationDueAt: Date }
    | undefined;
  return {
    ...project,
    repository: {
      ...project.repository,
      credential: cred
        ? {
            displayPrefix: cred.displayPrefix,
            status: cred.status,
            declaredScopes: cred.declaredScopes,
            rotationDueAt: cred.rotationDueAt,
          }
        : undefined,
    },
  };
}

export function registerProjectRoutes(
  app: FastifyInstance,
  repos: Repositories,
  service: ProjectService,
  /**
   * Starts discovery for a newly created project.
   *
   * Injected rather than imported so this layer never depends on `agent/`, and
   * so a test can create a project without a clone. It returns immediately: the
   * run outlives this request, and the client watches it over SSE.
   */
  startDiscovery?: (project: Project) => void,
  activity?: ActivityRecorder,
  /** Archive and soft delete. PRD-17 supplies it. */
  lifecycle?: LifecycleService,
): void {
  /** Records against the request, or does nothing. Never awaited (FR-5). */
  const record = (
    req: Parameters<typeof activityContext>[0],
    input: Parameters<ActivityRecorder['record']>[1],
  ) => {
    const ctx = activityContext(req);
    if (ctx && activity) void activity.record(ctx, input);
  };
  /** What the create screen must ask the user to grant (UX v1.2). */
  app.get('/projects/required-scopes', async () => ({ scopes: REQUIRED_GITHUB_SCOPES }));

  app.post<{ Body: CreateBody }>('/projects', async (req, reply) => {
    const user = currentUser(req);

    const parsed = CreateProjectInput.safeParse(req.body);
    if (!parsed.success) {
      // The message names the field but never echoes the value — a validation
      // error on githubToken must not put the token in a response.
      throw ApiError.badRequest(
        `Invalid project: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`,
      );
    }

    const files: UploadedFile[] = (req.body.files ?? []).map((f) => {
      const kind = FileKind.safeParse(f.kind);
      if (!kind.success) throw ApiError.badRequest(`Unknown file kind: ${f.kind}`);
      return {
        kind: kind.data,
        originalName: f.originalName,
        mimeType: f.mimeType,
        data: Buffer.from(f.contentBase64, 'base64'),
      };
    });

    const project = await service.create(user.uid, parsed.data, files);
    req.log.info({ projectId: project.projectId, files: files.length }, 'project created');

    record(req, {
      action: 'PROJECT_CREATED',
      summary: `Created project ${project.name}`,
      target: project.repository.url,
      projectId: project.projectId,
      detail: { files: files.length, branch: project.repository.defaultBranch },
    });
    // A separate entry, because "a credential was stored for this project" is
    // the fact an auditor looks for and it should not be buried in a creation
    // detail. The prefix is what the UI already shows; the token is never here.
    record(req, {
      action: 'TOKEN_STORED',
      summary: 'Stored a repository access token in Secret Manager',
      target: project.repository.credential?.displayPrefix ?? 'github-pat',
      projectId: project.projectId,
    });
    if (files.length > 0) {
      record(req, {
        action: 'FILES_UPLOADED',
        summary: `Uploaded ${files.length} context file${files.length === 1 ? '' : 's'}`,
        projectId: project.projectId,
        detail: { count: files.length },
      });
    }
    record(req, {
      action: 'DISCOVERY_STARTED',
      summary: 'Started discovery',
      projectId: project.projectId,
    });

    startDiscovery?.(project);
    return reply.status(201).send(present(project));
  });

  /** The landing list. One query — `summary` is the tile. */
  app.get('/projects', async (req) => {
    const user = currentUser(req);
    const projects = await repos.projects.listForOwner(user.uid);
    return {
      count: projects.length,
      awaitingApproval: projects.filter((p) => p.stage === 'AWAITING_APPROVAL').length,
      needsHumanAction: projects.filter((p) => p.actionRequired).length,
      // `rail` is derived here rather than stored, so a label cannot drift from
      // the stage it describes.
      projects: projects.map((p) => ({ ...present(p), rail: railProgress(p.stage) })),
    };
  });

  app.get<{ Params: Params }>('/projects/:id', async (req) =>
    present(await loadOwnedProject(repos, req, req.params.id)),
  );

  app.get<{ Params: Params }>('/projects/:id/files', async (req) => {
    await loadOwnedProject(repos, req, req.params.id);
    return { files: await repos.projectFiles.find({ projectId: req.params.id } as never) };
  });

  app.post<{ Params: Params; Body: { kind: string; originalName: string; mimeType: string; contentBase64: string } }>(
    '/projects/:id/files',
    async (req, reply) => {
      const user = currentUser(req);
      await loadOwnedProject(repos, req, req.params.id);
      const kind = FileKind.safeParse(req.body.kind);
      if (!kind.success) throw ApiError.badRequest(`Unknown file kind: ${req.body.kind}`);

      const file = await service.attachFile(req.params.id, user.uid, {
        kind: kind.data,
        originalName: req.body.originalName,
        mimeType: req.body.mimeType,
        data: Buffer.from(req.body.contentBase64, 'base64'),
      });
      record(req, {
        action: 'FILES_UPLOADED',
        summary: `Uploaded ${req.body.originalName}`,
        target: req.body.originalName,
        projectId: req.params.id,
        detail: { kind: kind.data },
      });
      return reply.status(201).send(file);
    },
  );

  /**
   * Edit an existing project.
   *
   * The repository URL is not editable — see `UpdateProjectInput`. Nothing here
   * touches discovery: editing the instructions changes what the *next* run
   * reasons over, and re-running is a separate, explicit act.
   */
  app.patch<{ Params: Params; Body: unknown }>('/projects/:id', async (req) => {
    const project = await loadOwnedProject(repos, req, req.params.id);

    const parsed = UpdateProjectInput.safeParse(req.body);
    if (!parsed.success) {
      // Names the field, never the value: a validation error on githubToken
      // must not put the token in a response.
      throw ApiError.badRequest(
        `Invalid update: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`,
      );
    }

    const { project: updated, changed } = await service.update(project.projectId, parsed.data);
    if (changed.length > 0) {
      record(req, {
        action: 'PROJECT_UPDATED',
        summary: `Updated ${project.name} — ${changed.join(', ')}`,
        projectId: project.projectId,
        detail: { fields: changed.join(',') },
      });
      // A credential change is the entry an auditor looks for, so it is its own
      // row rather than a field name inside another one.
      if (changed.includes('githubToken')) {
        record(req, {
          action: 'TOKEN_REPLACED',
          summary: 'Replaced the repository access token',
          target: updated.repository.credential?.displayPrefix ?? 'github-pat',
          projectId: project.projectId,
          detail: { version: updated.repository.credential?.secretVersion ?? '' },
        });
      }
    }
    return present(updated);
  });

  /**
   * Runs discovery again, over the edited context.
   *
   * Separate from the edit because they are separate decisions: changing the
   * instructions is cheap and reversible, re-reading the repository is neither.
   */
  app.post<{ Params: Params }>('/projects/:id/rediscover', async (req, reply) => {
    const project = await loadOwnedProject(repos, req, req.params.id);
    if (!startDiscovery) throw ApiError.badRequest('Discovery is not configured.');

    if (!(REDISCOVERABLE_STAGES as readonly string[]).includes(project.stage)) {
      throw ApiError.conflict(
        `A project in ${project.stage} cannot be re-analysed. The migration's baseline was `
        + 'captured against the findings that exist now, and replacing them underneath it '
        + 'would leave it executing a plan its evidence no longer supports.',
      );
    }

    await repos.projects.collection.updateOne({ projectId: project.projectId } as never, {
      $set: {
        stage: 'ANALYZING', stageEnteredAt: new Date(), actionRequired: false,
        'summary.discoveryComplete': false,
        'summary.lastActivityAt': new Date(),
        'summary.lastActivityText': 'Re-analysing the repository',
      } as never,
      $inc: { version: 1 } as never,
    });

    record(req, {
      action: 'DISCOVERY_STARTED',
      summary: `Re-ran discovery for ${project.name}`,
      projectId: project.projectId,
      detail: { from: project.stage },
    });

    startDiscovery((await repos.projects.byId(project.projectId))!);
    return reply.status(202).send({ status: 'ANALYZING' });
  });

  /**
   * Archive — the owner's action, and irreversible from here.
   *
   * The sandbox goes with it: an archived project offers no link to review one,
   * so retaining it would hold a public URL and a platform slot for nothing.
   */
  app.post<{ Params: Params; Body: { confirm?: string } }>(
    '/projects/:id/archive',
    async (req) => {
      const project = await loadOwnedProject(repos, req, req.params.id);
      if (!lifecycle) throw ApiError.badRequest('Archiving is not configured.');

      const archived = await asApiError(() =>
        lifecycle.archive(project, currentUser(req).uid, req.body?.confirm ?? ''),
      );
      req.log.info({ projectId: project.projectId }, 'project archived, sandbox released');
      record(req, {
        action: 'PROJECT_ARCHIVED',
        summary: `Archived ${project.name} — read-only from here`,
        projectId: project.projectId,
        detail: { stage: project.stage },
      });
      return present(archived);
    },
  );

  /** What a delete would do. Platform admin only, and changes nothing. */
  app.get<{ Params: Params }>('/projects/:id/deletion-preview', async (req) => {
    // Not `loadOwnedProject`: delete exists to clear other people's test
    // projects, so the role replaces the ownership check rather than adding to it.
    const project = await loadProjectAsAdmin(repos, req, req.params.id);
    if (!lifecycle) throw ApiError.badRequest('Deletion is not configured.');
    return lifecycle.preview(project);
  });

  /**
   * Delete — a soft delete, platform admins only.
   *
   * Nothing is removed. The project becomes invisible, which every other route
   * inherits from `byId` excluding it, so no route needs a check of its own.
   */
  app.delete<{ Params: Params; Body: { confirm?: string } }>(
    '/projects/:id',
    async (req, reply) => {
      const project = await loadProjectAsAdmin(repos, req, req.params.id);
      if (!lifecycle) throw ApiError.badRequest('Deletion is not configured.');

      // Recorded before the project disappears, and never deleted afterwards:
      // this row is the only remaining record of who removed it.
      record(req, {
        action: 'PROJECT_DELETED',
        summary: `Deleted ${project.name} (${project.projectId})`,
        projectId: project.projectId,
        detail: { stage: project.stage, lifecycle: project.lifecycle },
      });

      await asApiError(() =>
        lifecycle.softDelete(project, currentUser(req).uid, req.body?.confirm ?? ''),
      );
      req.log.warn(
        { projectId: project.projectId, by: currentUser(req).uid },
        'project soft-deleted, credential destroyed, sandbox released',
      );
      return reply.status(204).send();
    },
  );
}

/** Turns a lifecycle refusal into the HTTP answer it deserves. */
async function asApiError<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof LifecycleError) {
      // A typed-confirmation mismatch is the caller's mistake to fix; a busy
      // project and an already-archived one are both conflicts.
      throw e.code === 'CONFIRM'
        ? ApiError.badRequest(e.message)
        : ApiError.conflict(e.message);
    }
    throw e;
  }
}
