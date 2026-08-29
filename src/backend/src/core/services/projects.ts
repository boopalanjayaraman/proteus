import {
  CREDENTIAL_ROTATION_DAYS, REQUIRED_GITHUB_SCOPES, gcsPath,
  type CreateProjectInput, type FileKind, type Project, type ProjectFile,
} from '@proteus/schema';
import { nextProjectId } from '../db/counters';
import type { BlobStore } from '../../integrations/storage/blobs';
import { githubSecretName, type SecretVault } from '../../integrations/secrets/vault';
import type { Repositories } from '../repositories';

/**
 * Project creation.
 *
 * The one place a repository token exists in this system. It arrives as an
 * argument, goes to the vault, and is never assigned to anything that outlives
 * this function — no field, no log, no event payload.
 */

export interface UploadedFile {
  kind: FileKind;
  originalName: string;
  mimeType: string;
  data: Buffer;
}

export class ProjectService {
  constructor(
    private readonly repos: Repositories,
    private readonly vault: SecretVault,
    private readonly blobs: BlobStore,
  ) {}

  /**
   * Creates a project and vaults its credential.
   *
   * Ordering is deliberate (decision D-009). There is no transaction across
   * MongoDB and Secret Manager, so one of them can succeed alone. The secret is
   * written first: a failure after that leaves an orphaned secret, which a sweep
   * cleans up, rather than an orphaned project, which is broken and visible to
   * the user. If the project write fails, the secret is removed on a best-effort
   * basis so the sweep has less to do.
   */
  async create(
    ownerId: string,
    input: CreateProjectInput,
    files: UploadedFile[] = [],
  ): Promise<Project> {
    const projectId = await nextProjectId(this.repos.db);
    const secretName = githubSecretName(projectId);

    const ref = await this.vault.store(secretName, input.githubToken);

    const now = new Date();
    const project: Project = {
      _schemaVersion: 1,
      createdAt: now,
      updatedAt: now,
      projectId,
      ownerId,
      name: input.name,
      repository: {
        url: input.repositoryUrl,
        provider: 'GITHUB',
        defaultBranch: input.defaultBranch ?? 'main',
        visibility: 'PREAUTHORIZED',
        credential: {
          secretName: ref.name,
          secretVersion: ref.version,
          // Enough to recognise the token in the UI, nowhere near enough to use it.
          displayPrefix: input.githubToken.slice(0, 12),
          declaredScopes: [...REQUIRED_GITHUB_SCOPES],
          status: 'STORED',
          storedAt: now,
          rotationDueAt: new Date(now.getTime() + CREDENTIAL_ROTATION_DAYS * 86_400_000),
        },
      },
      instructions: input.instructions,
      stage: 'CREATED',
      stageEnteredAt: now,
      actionRequired: false,
      summary: {
        lastActivityAt: now,
        lastActivityText: 'Project created',
        discoveryComplete: false, assessmentComplete: false, migrationApproved: false,
        migrationComplete: false, verificationComplete: false, sandboxDeployed: false,
        counts: {
          findings: 0, recommendations: 0, graphNodes: 0,
          graphEdges: 0, openGates: 0, migrationChanges: 0,
        },
        autonomy: {
          eligibleItems: 0, completedAutonomously: 0, completionPct: null,
          humanEngineeringActions: 0, approvals: 0,
        },
      },
      current: {},
      lastEventSeq: 0,
      graphVersion: 0,
      version: 0,
    };

    try {
      await this.repos.projects.insert(project);
    } catch (e) {
      await this.vault.destroy(secretName).catch(() => undefined);
      throw e;
    }

    await this.repos.events.emit(projectId, {
      type: 'PROJECT_CREATED', phase: 'SYSTEM', level: 'MILESTONE', severity: 'SUCCESS',
      title: `Project created for ${input.repositoryUrl}`, actor: 'USER', refs: {},
    });
    // The reference is recorded, never the token.
    await this.repos.events.emit(projectId, {
      type: 'CREDENTIAL_STORED', phase: 'SYSTEM', level: 'DETAIL', severity: 'INFO',
      title: 'Repository credential stored',
      message: `${ref.name}@${ref.version} · rotation due in ${CREDENTIAL_ROTATION_DAYS} days`,
      actor: 'SYSTEM', refs: {},
    });

    for (const f of files) await this.attachFile(projectId, ownerId, f);
    if (files.length) await this.recountFiles(projectId);

    return project;
  }

  /** Stores an upload in GCS and its metadata in Mongo. The bytes never go to Mongo. */
  async attachFile(projectId: string, uploadedBy: string, file: UploadedFile): Promise<ProjectFile> {
    const fileId = `f_${projectId}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const stored = await this.blobs.put(
      gcsPath.uploadedFile(projectId, fileId, file.originalName),
      file.data,
      file.mimeType,
    );

    const now = new Date();
    const doc: ProjectFile = {
      _schemaVersion: 1, createdAt: now, updatedAt: now,
      fileId, projectId, kind: file.kind,
      originalName: file.originalName, mimeType: file.mimeType,
      sizeBytes: stored.sizeBytes, gcsUri: stored.gcsUri, sha256: stored.sha256,
      // Extraction is queued rather than done here; PRD-06 owns it.
      extraction: { status: 'PENDING', sections: [] },
      uploadedBy,
    };
    await this.repos.projectFiles.insert(doc);
    return doc;
  }

  private async recountFiles(projectId: string): Promise<void> {
    await this.repos.projects.touchActivity(projectId, 'Supporting documents uploaded');
  }

  /**
   * Deletes a project and destroys its credential.
   *
   * The secret goes last but must go: an orphaned secret is a live credential
   * with nothing watching it.
   */
  async delete(projectId: string): Promise<void> {
    const project = await this.repos.projects.byId(projectId);
    if (!project) return;

    await this.blobs.deletePrefix(`projects/${projectId}/`);
    await Promise.all(
      Object.values({
        files: this.repos.projectFiles.collection.deleteMany({ projectId } as never),
        events: this.repos.events.collection.deleteMany({ projectId } as never),
        project: this.repos.projects.collection.deleteOne({ projectId } as never),
      }),
    );
    if (project.repository.credential) {
      await this.vault.destroy(project.repository.credential.secretName);
    }
  }

  /**
   * Fetches the token for a call, by pinned version.
   *
   * The only read path. Callers hold the value for the duration of one request
   * and never place it on a document or a run.
   */
  async credentialFor(projectId: string): Promise<string> {
    const project = await this.repos.projects.byId(projectId);
    const cred = project?.repository.credential;
    if (!cred) throw new Error(`${projectId} has no stored credential`);
    return this.vault.read({ name: cred.secretName, version: cred.secretVersion });
  }
}
