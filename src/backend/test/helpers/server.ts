import type { FastifyInstance } from 'fastify';
import pino from 'pino';
import { buildServer } from '../../src/api/server';
import type { AuthenticatedUser, TokenVerifier } from '../../src/api/middleware/auth';
import type { Repositories } from '../../src/core/repositories';
import { ApprovalService } from '../../src/core/services/approval';
import { AssessmentService } from '../../src/core/services/assessment';
import { GraphService } from '../../src/core/services/graph';
import { ProjectService } from '../../src/core/services/projects';
import { InMemorySecretVault } from '../../src/integrations/secrets/vault';
import { LifecycleService } from '../../src/core/services/lifecycle';
import { ScriptedDeployer } from '../../src/integrations/cloudrun/sandbox';
import { InMemoryBlobStore } from '../../src/integrations/storage/blobs';

/**
 * A real server on a real port.
 *
 * `inject()` would be faster but cannot exercise SSE — the whole point of these
 * tests is that a stream survives a disconnect, which needs an actual socket.
 */

/** Accepts `test-token:<uid>`; rejects everything else, including malformed. */
export class StubVerifier implements TokenVerifier {
  async verify(idToken: string): Promise<AuthenticatedUser> {
    const m = /^test-token:(.+)$/.exec(idToken);
    if (!m?.[1]) throw new Error('malformed test token');
    return { uid: m[1], email: `${m[1]}@example.test`, displayName: 'Amara Osei' };
  }
}

export interface TestServer {
  url: string;
  app: FastifyInstance;
  /** Exposed so a test can assert what actually reached the vault and the bucket. */
  vault: InMemorySecretVault;
  blobs: InMemoryBlobStore;
  projects: ProjectService;
  graph: GraphService;
  assessments: AssessmentService;
  approvals: ApprovalService;
  projectLifecycle: LifecycleService;
  /** Exposed so a test can assert the sandbox was actually torn down. */
  deployer: ScriptedDeployer;
  /** Projects handed to discovery. Recorded rather than run — the job is heavy. */
  discoveryStarts: string[];
  stop: () => Promise<void>;
}

export async function startTestServer(
  repos: Repositories,
  /** CORS is off by default: an in-process fetch has no origin to check. */
  opts: { allowedOrigins?: string[] } = {},
): Promise<TestServer> {
  const vault = new InMemorySecretVault();
  const blobs = new InMemoryBlobStore();
  const projects = new ProjectService(repos, vault, blobs);
  const graph = new GraphService(repos);
  const assessments = new AssessmentService(repos);
  const approvals = new ApprovalService(repos);
  const deployer = new ScriptedDeployer('https://sandbox.test');
  const discoveryStarts: string[] = [];
  const projectLifecycle = new LifecycleService(repos, vault, () => deployer);

  const app = await buildServer({
    repos,
    projects,
    graph,
    assessments,
    approvals,
    blobs,
    verifier: new StubVerifier(),
    logger: pino({ level: 'silent' }),
    projectLifecycle,
    startDiscovery: (project) => { discoveryStarts.push(project.projectId); },
    ...(opts.allowedOrigins ? { allowedOrigins: opts.allowedOrigins } : {}),
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    app, vault, blobs, projects, graph, assessments, approvals,
    projectLifecycle, deployer, discoveryStarts,
    stop: () => app.close(),
  };
}

export const authFor = (uid: string) => ({ authorization: `Bearer test-token:${uid}` });

/**
 * Reads SSE frames until `want` have arrived or the timeout expires, then aborts.
 * Returns the parsed events and the raw text, so a test can assert on frame
 * structure (`id:`) as well as payloads.
 */
export async function readStream(
  url: string,
  headers: Record<string, string>,
  want: number,
  timeoutMs = 5_000,
): Promise<{ events: Array<Record<string, unknown>>; raw: string; abort: () => void }> {
  const controller = new AbortController();
  const res = await fetch(url, { headers, signal: controller.signal });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();

  let raw = '';
  const events: Array<Record<string, unknown>> = [];
  const deadline = Date.now() + timeoutMs;

  while (events.length < want && Date.now() < deadline) {
    const read = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>((r) =>
        setTimeout(() => r({ done: true, value: undefined }), 300),
      ),
    ]);
    if (read.value) {
      raw += decoder.decode(read.value, { stream: true });
      for (const frame of raw.split('\n\n')) {
        const line = frame.split('\n').find((l) => l.startsWith('data: '));
        if (line) {
          const parsed = JSON.parse(line.slice(6)) as Record<string, unknown>;
          if (!events.some((e) => e['seq'] === parsed['seq'])) events.push(parsed);
        }
      }
    }
  }
  controller.abort();
  return { events, raw, abort: () => controller.abort() };
}
