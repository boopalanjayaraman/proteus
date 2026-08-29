import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { BuildExecutor } from '../cloudbuild/executor';
import { ProcessExecutor } from '../cloudbuild/executor';
import { CloudBuildExecutor } from '../cloudbuild/cloudBuildExecutor';
import type { SandboxDeployer } from '../cloudrun/sandbox';
import { LocalDockerDeployer } from '../cloudrun/sandbox';
import { CloudRunDeployer } from '../cloudrun/cloudRunDeployer';
import { GoogleApiTransport } from './client';

/**
 * Which implementation runs, decided from configuration.
 *
 * The point of doing this in one place: a Cloud Run container cannot start
 * another container — no daemon, no socket, no privileged mode — so a hosted
 * Proteus must use the GCP implementations for *both* the build and the sandbox.
 * Getting one right and the other wrong produces a service that verifies nothing
 * or hosts nothing, and does it at the first migration rather than at startup.
 *
 * So `assertRuntimeAvailable` checks at boot instead.
 */

const run = promisify(execFile);

export interface HostingSettings {
  buildExecutor: 'LOCAL' | 'CLOUD_BUILD';
  buildImage: string;
  cloudBuildCacheUri?: string;
  sandboxPlacement: 'LOCAL' | 'CLOUD_RUN';
  sandboxMaxInstances: number;
  sandboxCpu: string;
  sandboxMemory: string;
  sandboxRequestTimeoutSeconds: number;
}

export interface GcpSettings {
  projectId: string;
  region: string;
  bucket: string;
  artifactRegistryRepo: string;
  serviceAccount?: string;
}

const PIPELINE = fileURLToPath(
  new URL('../../../../../deployment/cloudbuild/migration-build.yaml', import.meta.url),
);

export function buildExecutorFor(
  hosting: HostingSettings,
  gcp: () => GcpSettings,
  repoUrl?: string,
): BuildExecutor {
  if (hosting.buildExecutor === 'LOCAL') return new ProcessExecutor(hosting.buildImage);

  const settings = gcp();
  return new CloudBuildExecutor(new GoogleApiTransport(), {
    projectId: settings.projectId,
    region: settings.region,
    resultsBucket: settings.bucket,
    pipelinePath: PIPELINE,
    buildImage: hosting.buildImage,
    ...(hosting.cloudBuildCacheUri ? { cacheUri: hosting.cloudBuildCacheUri } : {}),
    ...(settings.serviceAccount ? { serviceAccount: settings.serviceAccount } : {}),
    ...(repoUrl ? { repoUrl } : {}),
  });
}

export function sandboxDeployerFor(
  hosting: HostingSettings,
  gcp: () => GcpSettings,
): SandboxDeployer {
  if (hosting.sandboxPlacement === 'LOCAL') return new LocalDockerDeployer();

  const settings = gcp();
  return new CloudRunDeployer(new GoogleApiTransport(), {
    projectId: settings.projectId,
    region: settings.region,
    registry: `${settings.region}-docker.pkg.dev/${settings.projectId}`
      + `/${settings.artifactRegistryRepo}`,
    // Deployment §4.3: the migrated application is under test, not trusted, and
    // this identity holds no roles at all.
    serviceAccount: `proteus-sandbox@${settings.projectId}.iam.gserviceaccount.com`,
    maxInstances: hosting.sandboxMaxInstances,
    cpu: hosting.sandboxCpu,
    memory: hosting.sandboxMemory,
    requestTimeoutSeconds: hosting.sandboxRequestTimeoutSeconds,
  });
}

/**
 * Refuses a local setting where nothing local can run.
 *
 * Checked at boot rather than at the first migration, because the failure is a
 * configuration mistake and not a runtime one: a Cloud-Run-hosted Proteus set to
 * `LOCAL` will get through discovery, assessment and approval perfectly well and
 * then fail at the first `mvn` invocation, forty minutes into someone's demo.
 */
export async function assertRuntimeAvailable(
  hosting: HostingSettings,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const needsDocker = hosting.buildExecutor === 'LOCAL' || hosting.sandboxPlacement === 'LOCAL';
  if (!needsDocker) return { ok: true };

  try {
    await run('docker', ['info'], { timeout: 10_000 });
    return { ok: true };
  } catch {
    const wants = [
      hosting.buildExecutor === 'LOCAL' ? 'BUILD_EXECUTOR=LOCAL' : null,
      hosting.sandboxPlacement === 'LOCAL' ? 'SANDBOX_PLACEMENT=LOCAL' : null,
    ].filter(Boolean).join(' and ');
    return {
      ok: false,
      reason: `${wants} needs a container runtime and none is reachable. A Cloud Run `
        + 'container cannot start another container — set BUILD_EXECUTOR=CLOUD_BUILD and '
        + 'SANDBOX_PLACEMENT=CLOUD_RUN, or run Proteus somewhere with Docker.',
    };
  }
}
