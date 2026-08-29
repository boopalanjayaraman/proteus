import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * The sandbox, behind an interface.
 *
 * Spec §36 wants a Cloud Run service; a demo needs something that starts in
 * seconds on the machine in front of you. Both are the same three operations —
 * build an image, run it somewhere, get a URL back — so they are one interface
 * with two implementations, exactly as the build executor is.
 *
 * The one thing neither implementation may do is claim the deployment is
 * production. `isProduction` is a literal `false` on the document, and every
 * surface labels from that field rather than from a hardcoded caption.
 */

export interface ImageSpec {
  /** The checked-out tree, containing the Dockerfile. */
  workdir: string;
  tag: string;
  commitSha: string;
}

export interface BuiltImage {
  imageUri: string;
  imageDigest?: string;
  log: string;
}

export interface DeploySpec {
  serviceName: string;
  imageUri: string;
  region: string;
  /** Cloud Run needs to know; the local runner needs to publish it. */
  containerPort: number;
  env?: Record<string, string>;
}

export interface Deployed {
  url: string;
  revision?: string;
  /** Frees whatever the deployment holds. Always call it for a local run. */
  dispose: () => Promise<void>;
}

export interface SandboxDeployer {
  readonly kind: 'CLOUD_RUN' | 'LOCAL_DOCKER' | 'SCRIPTED';
  readonly region: string;
  buildImage(spec: ImageSpec): Promise<BuiltImage>;
  deploy(spec: DeploySpec): Promise<Deployed>;
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000;

/**
 * Builds with Docker and runs the container locally on a mapped port.
 *
 * What makes this a faithful stand-in rather than a shortcut: it builds the
 * repository's own `Dockerfile` and starts the same image Cloud Run would, so a
 * startup failure caused by the migration surfaces here exactly as it would
 * there. What it does not reproduce is the network boundary, which is why the
 * URL it returns is a loopback address and is labelled as such.
 */
export class LocalDockerDeployer implements SandboxDeployer {
  readonly kind = 'LOCAL_DOCKER' as const;
  readonly region = 'local';

  constructor(private readonly hostPort = 0) {}

  async buildImage(spec: ImageSpec): Promise<BuiltImage> {
    const imageUri = `proteus-sandbox/${spec.tag}:${spec.commitSha.slice(0, 12)}`;
    const { stdout, stderr } = await run(
      'docker',
      ['build', '--quiet', '-t', imageUri, '.'],
      { cwd: spec.workdir, timeout: DEFAULT_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 },
    );
    const digest = stdout.trim().startsWith('sha256:') ? stdout.trim() : undefined;
    return { imageUri, ...(digest ? { imageDigest: digest } : {}), log: `${stdout}${stderr}` };
  }

  async deploy(spec: DeploySpec): Promise<Deployed> {
    const port = this.hostPort || (await freePort());
    const env = Object.entries(spec.env ?? {}).flatMap(([k, v]) => ['-e', `${k}=${v}`]);

    const { stdout } = await run('docker', [
      'run', '--rm', '--detach',
      '--name', spec.serviceName,
      '-p', `${port}:${spec.containerPort}`,
      ...env,
      spec.imageUri,
    ], { timeout: 60_000 });

    const containerId = stdout.trim();
    return {
      url: `http://127.0.0.1:${port}`,
      revision: containerId.slice(0, 12),
      dispose: async () => {
        await run('docker', ['rm', '-f', spec.serviceName]).catch(() => undefined);
      },
    };
  }
}

/**
 * A deployer that answers from a script.
 *
 * The startup probe and the end-to-end scenario still run for real against
 * whatever URL this returns, so a test can point it at a local stub server and
 * exercise the whole verification path without Docker.
 */
export class ScriptedDeployer implements SandboxDeployer {
  readonly kind = 'SCRIPTED' as const;
  readonly region = 'test';
  readonly built: ImageSpec[] = [];
  readonly deployed: DeploySpec[] = [];

  constructor(
    private readonly url: string,
    private readonly failures: { build?: string; deploy?: string } = {},
  ) {}

  async buildImage(spec: ImageSpec): Promise<BuiltImage> {
    this.built.push(spec);
    if (this.failures.build) throw new Error(this.failures.build);
    return {
      imageUri: `scripted/${spec.tag}:${spec.commitSha.slice(0, 12)}`,
      imageDigest: `sha256:${'0'.repeat(64)}`,
      log: 'scripted image build',
    };
  }

  async deploy(spec: DeploySpec): Promise<Deployed> {
    this.deployed.push(spec);
    if (this.failures.deploy) throw new Error(this.failures.deploy);
    return { url: this.url, revision: 'scripted-0001', dispose: async () => undefined };
  }
}

/** An unused loopback port, so parallel sandboxes do not collide. */
async function freePort(): Promise<number> {
  const { createServer } = await import('node:net');
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** `PQC-0184` → a DNS-safe service name Cloud Run and Docker both accept. */
export const sandboxServiceName = (projectId: string): string =>
  `proteus-sandbox-${projectId.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
