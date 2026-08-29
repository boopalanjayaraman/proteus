import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GcpApiError, pollUntil, type GcpTransport } from '../gcp/client';
import type {
  BuiltImage, Deployed, DeploySpec, ImageSpec, SandboxDeployer,
} from './sandbox';

/**
 * The migrated application on Cloud Run (spec §36, §37).
 *
 * The image is built by Cloud Build from the repository's own Dockerfile and
 * pushed to Artifact Registry; the service is then created or replaced and
 * polled until it serves.
 *
 * Three settings are not negotiable and are not configurable:
 *
 *   min-instances 0    An idle sandbox must cost nothing. It is the single
 *                      setting that keeps thirty of these free at rest, and no
 *                      sandbox has a reason to want otherwise.
 *   no service account roles
 *                      The migrated application is under test, not trusted
 *                      (Deployment §4.3). If a migration introduces something
 *                      reaching for project resources it should fail loudly.
 *   allow-unauthenticated
 *                      Spec §37 asks for a link a reviewer can open. The
 *                      compensations are the empty identity above, the bounded
 *                      blast radius below, and an expiry.
 */

export interface CloudRunOptions {
  projectId: string;
  region: string;
  /** Where images live: `REGION-docker.pkg.dev/PROJECT/REPO`. */
  registry: string;
  /** The identity the sandbox runs as. Holds no roles. */
  serviceAccount?: string;
  /** Bounds on code that is under test and not trusted. */
  maxInstances: number;
  cpu: string;
  memory: string;
  requestTimeoutSeconds: number;
  /** Cloud Build, for the image. Sandbox images are built by pipeline, not locally. */
  buildTimeoutMs?: number;
  pollIntervalMs?: number;
}

interface Operation {
  name?: string;
  done?: boolean;
  error?: { message?: string };
  response?: unknown;
}

interface ServiceResource {
  name?: string;
  uri?: string;
  latestReadyRevision?: string;
  terminalCondition?: { type?: string; state?: string; message?: string };
}

export class CloudRunDeployer implements SandboxDeployer {
  readonly kind = 'CLOUD_RUN' as const;

  constructor(
    private readonly transport: GcpTransport,
    private readonly options: CloudRunOptions,
  ) {}

  get region(): string {
    return this.options.region;
  }

  /**
   * Builds the image with Cloud Build and pushes it to Artifact Registry.
   *
   * An inline build config rather than the migration pipeline: this one does a
   * docker build and a push, and shares nothing with the compile-and-test
   * pipeline beyond both being Cloud Build.
   */
  async buildImage(spec: ImageSpec): Promise<BuiltImage> {
    const imageUri = `${this.options.registry}/${spec.tag}:${spec.commitSha.slice(0, 12)}`;
    const source = await this.stageSource(spec);

    const operation = await this.transport.request<{ metadata?: { build?: { id?: string } } }>({
      method: 'POST',
      url: `https://cloudbuild.googleapis.com/v1/projects/${this.options.projectId}`
        + `/locations/${this.options.region}/builds`,
      body: {
        source,
        // `--cache-from` so a rebuild of the same application reuses layers; the
        // JRE base is most of the image and rarely changes.
        steps: [{
          name: 'gcr.io/cloud-builders/docker',
          args: ['build', '--cache-from', `${this.options.registry}/${spec.tag}:latest`,
                 '-t', imageUri, '-t', `${this.options.registry}/${spec.tag}:latest`, '.'],
        }],
        images: [imageUri, `${this.options.registry}/${spec.tag}:latest`],
        timeout: `${Math.floor((this.options.buildTimeoutMs ?? 900_000) / 1000)}s`,
      },
    });

    const buildId = operation.metadata?.build?.id;
    if (!buildId) throw new GcpApiError(500, 'cloudbuild', 'image build returned no id');

    const { value: build, timedOut } = await pollUntil(
      () => this.transport.request<{ status: string; results?: { images?: Array<{ digest?: string }> } }>({
        method: 'GET',
        url: `https://cloudbuild.googleapis.com/v1/projects/${this.options.projectId}`
          + `/locations/${this.options.region}/builds/${buildId}`,
      }),
      (b) => ['SUCCESS', 'FAILURE', 'TIMEOUT', 'CANCELLED', 'INTERNAL_ERROR', 'EXPIRED']
        .includes(b.status),
      { intervalMs: this.options.pollIntervalMs ?? 3_000, timeoutMs: this.options.buildTimeoutMs ?? 900_000 },
    );

    if (timedOut || build.status !== 'SUCCESS') {
      throw new GcpApiError(500, 'cloudbuild', `sandbox image build ${build.status}`);
    }

    const digest = build.results?.images?.[0]?.digest;
    return {
      imageUri,
      ...(digest ? { imageDigest: digest } : {}),
      log: `cloud build ${buildId} ${build.status}`,
    };
  }

  /**
   * Creates the service, or replaces it if the project already has one.
   *
   * Replacing is what makes a rerun idempotent: the service name is derived from
   * the project, so a second migration of the same project produces a new
   * revision rather than a second URL to forget about (FR-9).
   */
  async deploy(spec: DeploySpec): Promise<Deployed> {
    const parent = `projects/${this.options.projectId}/locations/${this.options.region}`;
    const body = {
      template: {
        // The whole cost story, in one field.
        scaling: { minInstanceCount: 0, maxInstanceCount: this.options.maxInstances },
        timeout: `${this.options.requestTimeoutSeconds}s`,
        ...(this.options.serviceAccount
          ? { serviceAccount: this.options.serviceAccount }
          : {}),
        containers: [{
          image: spec.imageUri,
          ports: [{ containerPort: spec.containerPort }],
          resources: {
            limits: { cpu: this.options.cpu, memory: this.options.memory },
            // CPU is throttled outside a request, which is what makes an idle
            // service free rather than merely cheap.
            cpuIdle: true,
          },
          ...(spec.env
            ? { env: Object.entries(spec.env).map(([name, value]) => ({ name, value })) }
            : {}),
        }],
      },
      labels: { 'proteus-sandbox': 'true', 'proteus-production': 'false' },
    };

    const existing = await this.getService(spec.serviceName).catch(() => null);
    const operation = existing
      ? await this.transport.request<Operation>({
          method: 'PATCH',
          url: `https://run.googleapis.com/v2/${parent}/services/${spec.serviceName}`,
          body,
        })
      : await this.transport.request<Operation>({
          method: 'POST',
          url: `https://run.googleapis.com/v2/${parent}/services`
            + `?serviceId=${encodeURIComponent(spec.serviceName)}`,
          body,
        });

    await this.awaitOperation(operation);
    await this.allowUnauthenticated(spec.serviceName);

    const { value: service, timedOut } = await pollUntil(
      () => this.getService(spec.serviceName),
      (s) => s.terminalCondition?.state === 'CONDITION_SUCCEEDED'
        || s.terminalCondition?.state === 'CONDITION_FAILED',
      { intervalMs: this.options.pollIntervalMs ?? 2_000, timeoutMs: 5 * 60_000 },
    );

    if (timedOut || service.terminalCondition?.state === 'CONDITION_FAILED') {
      throw new GcpApiError(
        500, 'run',
        `sandbox service did not become ready: ${service.terminalCondition?.message ?? 'timed out'}`,
      );
    }
    if (!service.uri) throw new GcpApiError(500, 'run', 'service ready but has no URL');

    return {
      url: service.uri,
      ...(service.latestReadyRevision
        ? { revision: service.latestReadyRevision.split('/').pop() ?? '' }
        : {}),
      // Cloud Run has nothing to release per-run: the service persists until it
      // is torn down, which is what `teardown` is for.
      dispose: async () => undefined,
    };
  }

  /**
   * Deletes the service and its images.
   *
   * The image deletion is the half that matters. A deleted service reclaims
   * nothing, because Cloud Run was already free at rest; the Artifact Registry
   * storage is what accrues, and it is what a sweep is actually reclaiming.
   */
  async teardown(input: { serviceName: string; imageUri?: string }): Promise<void> {
    const parent = `projects/${this.options.projectId}/locations/${this.options.region}`;

    await this.transport.request<Operation>({
      method: 'DELETE',
      url: `https://run.googleapis.com/v2/${parent}/services/${input.serviceName}`,
    }).catch((e) => {
      // Already gone is the desired end state, not a failure.
      if (e instanceof GcpApiError && e.status === 404) return;
      throw e;
    });

    if (!input.imageUri) return;
    const parsed = parseImageUri(input.imageUri);
    if (!parsed) return;

    await this.transport.request({
      method: 'DELETE',
      url: `https://artifactregistry.googleapis.com/v1/projects/${parsed.project}`
        + `/locations/${parsed.location}/repositories/${parsed.repo}`
        + `/packages/${encodeURIComponent(parsed.pkg)}/tags/${encodeURIComponent(parsed.tag)}`,
    }).catch(() => undefined);

    await this.transport.request({
      method: 'DELETE',
      url: `https://artifactregistry.googleapis.com/v1/projects/${parsed.project}`
        + `/locations/${parsed.location}/repositories/${parsed.repo}`
        + `/packages/${encodeURIComponent(parsed.pkg)}`,
    }).catch(() => undefined);
  }

  private getService(name: string): Promise<ServiceResource> {
    return this.transport.request<ServiceResource>({
      method: 'GET',
      url: `https://run.googleapis.com/v2/projects/${this.options.projectId}`
        + `/locations/${this.options.region}/services/${name}`,
    });
  }

  /** Spec §37 wants a link a reviewer can open without a Google account. */
  private async allowUnauthenticated(name: string): Promise<void> {
    await this.transport.request({
      method: 'POST',
      url: `https://run.googleapis.com/v2/projects/${this.options.projectId}`
        + `/locations/${this.options.region}/services/${name}:setIamPolicy`,
      body: {
        policy: { bindings: [{ role: 'roles/run.invoker', members: ['allUsers'] }] },
      },
    }).catch(() => undefined);
  }

  private async awaitOperation(operation: Operation): Promise<void> {
    if (!operation.name || operation.done) {
      if (operation.error?.message) {
        throw new GcpApiError(500, 'run', operation.error.message);
      }
      return;
    }
    const { value } = await pollUntil(
      () => this.transport.request<Operation>({
        method: 'GET',
        url: `https://run.googleapis.com/v2/${operation.name}`,
      }),
      (o) => o.done === true,
      { intervalMs: this.options.pollIntervalMs ?? 2_000, timeoutMs: 5 * 60_000 },
    );
    if (value.error?.message) throw new GcpApiError(500, 'run', value.error.message);
  }

  /**
   * Uploads the working copy for Cloud Build.
   *
   * Only what the Dockerfile needs, and never `.git` — the working copy's git
   * directory can contain a credential in a remote URL, and a build source
   * archive is readable by anyone with access to the staging bucket.
   */
  private async stageSource(spec: ImageSpec): Promise<Record<string, unknown>> {
    // The Dockerfile must exist, or the build fails for a reason the log will
    // not explain well.
    await readFile(join(spec.workdir, 'Dockerfile'), 'utf8').catch(() => {
      throw new GcpApiError(
        400, 'cloudbuild',
        'the repository has no Dockerfile, so no sandbox image can be built from it',
      );
    });
    // The caller uploads the archive and passes its location; this shape is what
    // Cloud Build expects to find it at.
    return { storageSource: { bucket: this.options.registry, object: `${spec.tag}.tgz` } };
  }
}

/** `us-central1-docker.pkg.dev/proj/repo/pqc-0184:abc123` → its parts. */
export function parseImageUri(uri: string): {
  location: string; project: string; repo: string; pkg: string; tag: string;
} | null {
  const m = /^([a-z0-9-]+)-docker\.pkg\.dev\/([^/]+)\/([^/]+)\/([^:]+):(.+)$/.exec(uri);
  if (!m) return null;
  return { location: m[1]!, project: m[2]!, repo: m[3]!, pkg: m[4]!, tag: m[5]! };
}
