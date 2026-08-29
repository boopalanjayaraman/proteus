import { CreateProjectInput, FileKind, REQUIRED_GITHUB_SCOPES, railProgress } from '@proteus/schema';
import type { FastifyInstance } from 'fastify';
import type { ProjectService, UploadedFile } from '../../core/services/projects';
import type { Repositories } from '../../core/repositories';
import { ApiError } from '../errors';
import { currentUser } from '../middleware/auth';
import { loadOwnedProject } from '../middleware/ownership';

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
): void {
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
      return reply.status(201).send(file);
    },
  );

  app.delete<{ Params: Params }>('/projects/:id', async (req, reply) => {
    await loadOwnedProject(repos, req, req.params.id);
    await service.delete(req.params.id);
    req.log.info({ projectId: req.params.id }, 'project deleted, credential destroyed');
    return reply.status(204).send();
  });
}
