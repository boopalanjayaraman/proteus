import { createHash } from 'node:crypto';
import { Storage } from '@google-cloud/storage';

/**
 * Blob storage.
 *
 * Everything unbounded goes here — uploaded specifications, extracted text,
 * build logs, diffs, reports — while Mongo keeps structured extracts and
 * pointers (data model §0 rule 6). Paths come from the `gcsPath` helper so the
 * bucket stays navigable by hand during a demo.
 */
export interface StoredBlob {
  gcsUri: string;
  sizeBytes: number;
  sha256: string;
}

export interface BlobStore {
  put(path: string, data: Buffer, contentType: string): Promise<StoredBlob>;
  get(path: string): Promise<Buffer>;
  delete(path: string): Promise<void>;
  /** Removes every object under a prefix — used when a project is deleted. */
  deletePrefix(prefix: string): Promise<number>;
}

export class BlobStoreError extends Error {}

export const sha256 = (data: Buffer): string =>
  createHash('sha256').update(data).digest('hex');

export class GcsBlobStore implements BlobStore {
  private readonly storage: Storage;

  /**
   * `projectId` is the billing project for every request, and it has to be set
   * here rather than inherited.
   *
   * Google's client libraries take the `x-goog-user-project` header from the
   * `quota_project_id` in the application-default credentials file — whatever
   * project happened to be current the last time someone ran `gcloud auth
   * application-default login`. If that is a different project, GCS answers
   * "User project specified in the request is invalid", which names neither the
   * project it objected to nor where it got it from.
   *
   * Neither `new Storage({ projectId })` nor `clientOptions.quotaProjectId`
   * overrides it; only the environment variable does. So the app states its own
   * project instead of depending on a machine's gcloud state — which is also
   * what makes a developer's laptop behave like Cloud Run.
   */
  constructor(private readonly bucketName: string, projectId?: string) {
    if (projectId && !process.env['GOOGLE_CLOUD_QUOTA_PROJECT']) {
      process.env['GOOGLE_CLOUD_QUOTA_PROJECT'] = projectId;
    }
    this.storage = new Storage(projectId ? { projectId } : {});
  }

  private file(path: string) {
    return this.storage.bucket(this.bucketName).file(path);
  }

  async put(path: string, data: Buffer, contentType: string): Promise<StoredBlob> {
    try {
      await this.file(path).save(data, { contentType, resumable: false });
    } catch (e) {
      throw new BlobStoreError(`could not write ${path}: ${(e as Error).message}`);
    }
    return { gcsUri: `gs://${this.bucketName}/${path}`, sizeBytes: data.length, sha256: sha256(data) };
  }

  async get(path: string): Promise<Buffer> {
    const [contents] = await this.file(path).download();
    return contents;
  }

  async delete(path: string): Promise<void> {
    await this.file(path).delete({ ignoreNotFound: true });
  }

  async deletePrefix(prefix: string): Promise<number> {
    const [files] = await this.storage.bucket(this.bucketName).getFiles({ prefix });
    await Promise.all(files.map((f) => f.delete({ ignoreNotFound: true })));
    return files.length;
  }
}

/** For tests and local development without a bucket. */
export class InMemoryBlobStore implements BlobStore {
  private readonly blobs = new Map<string, Buffer>();

  constructor(private readonly bucketName = 'test-bucket') {}

  async put(path: string, data: Buffer): Promise<StoredBlob> {
    this.blobs.set(path, data);
    return { gcsUri: `gs://${this.bucketName}/${path}`, sizeBytes: data.length, sha256: sha256(data) };
  }

  async get(path: string): Promise<Buffer> {
    const b = this.blobs.get(path);
    if (!b) throw new BlobStoreError(`no such blob ${path}`);
    return b;
  }

  async delete(path: string): Promise<void> {
    this.blobs.delete(path);
  }

  async deletePrefix(prefix: string): Promise<number> {
    const doomed = [...this.blobs.keys()].filter((k) => k.startsWith(prefix));
    doomed.forEach((k) => this.blobs.delete(k));
    return doomed.length;
  }

  get paths(): string[] {
    return [...this.blobs.keys()];
  }

  /** Test-only, for the same reason as InMemorySecretVault.clear(). */
  clear(): void {
    this.blobs.clear();
  }
}
