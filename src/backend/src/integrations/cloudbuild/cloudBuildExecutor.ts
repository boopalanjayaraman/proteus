import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import {
  GcpApiError, pollUntil, type GcpTransport,
} from '../gcp/client';
import { excerpt, type BuildExecutor, type ExecutionOutcome, type ExecutionSpec, type TestReportFile } from './executor';

/**
 * The migration's build and tests, on Cloud Build (spec §32).
 *
 * Spec §32 names Cloud Build as the environment for compiling, running unit and
 * integration tests, running mocks and collecting execution evidence.
 * `ProcessExecutor` was always the local stand-in for it, and a Cloud Run
 * container — which cannot start another container — has no alternative.
 *
 * Two properties are worth stating because they are the reason this is more than
 * a submit-and-wait:
 *
 *   STREAMS   The log object is polled while the build runs, and every new line
 *             is handed to `onLine`. That is what keeps the feed moving through
 *             a round trip that takes minutes rather than seconds.
 *   READS THE Reports come back through the same `ExecutionOutcome` shape the
 *   SAME XML  local executor returns, so every check downstream — the baseline
 *             inventory, the regression subset, the invariant matching — reads
 *             exactly what it reads today.
 */

export interface CloudBuildOptions {
  projectId: string;
  region: string;
  /** Where the pipeline writes logs and JUnit XML. */
  resultsBucket: string;
  /** The pipeline file. Read once at construction so a bad path fails early. */
  pipelinePath: string;
  buildImage: string;
  cacheUri?: string;
  serviceAccount?: string;
  /** Secret Manager version holding the repository token for this build. */
  tokenSecretVersion?: string;
  repoUrl?: string;
  pollIntervalMs?: number;
}

interface BuildResource {
  id: string;
  status: 'STATUS_UNKNOWN' | 'QUEUED' | 'WORKING' | 'SUCCESS' | 'FAILURE'
    | 'INTERNAL_ERROR' | 'TIMEOUT' | 'CANCELLED' | 'EXPIRED';
  logUrl?: string;
  logsBucket?: string;
  steps?: Array<{ id?: string; status?: string }>;
  results?: unknown;
}

const TERMINAL = new Set(['SUCCESS', 'FAILURE', 'INTERNAL_ERROR', 'TIMEOUT', 'CANCELLED', 'EXPIRED']);

export class CloudBuildExecutor implements BuildExecutor {
  readonly environment = 'CLOUD_BUILD' as const;

  constructor(
    private readonly transport: GcpTransport,
    private readonly options: CloudBuildOptions,
  ) {}

  async run(spec: ExecutionSpec): Promise<ExecutionOutcome> {
    const started = Date.now();
    const build = await this.submit(spec);

    let delivered = 0;
    let log = '';
    /** Steps already announced, so a poll does not repeat them. */
    const announced = new Set<string>();

    const { value: final, timedOut } = await pollUntil(
      () => this.get(build.id),
      (b) => TERMINAL.has(b.status),
      {
        intervalMs: this.options.pollIntervalMs ?? 3_000,
        timeoutMs: spec.timeoutMs ?? 30 * 60_000,
        onPoll: async (b) => {
          // Step boundaries first — they arrive in the build resource, before
          // any log line does, and they are what tells a viewer the run has
          // actually started rather than sitting in a queue.
          for (const step of b.steps ?? []) {
            const key = `${step.id}:${step.status}`;
            if (!step.id || announced.has(key)) continue;
            announced.add(key);
            if (step.status === 'WORKING') spec.onLine?.(`[cloudbuild] step ${step.id} started`);
          }

          log = await this.log(b).catch(() => log);
          if (log.length > delivered && spec.onLine) {
            // Only whole lines, and only the ones not seen before. The log
            // object grows by append, so the tail is the new part.
            const fresh = log.slice(delivered);
            const lines = fresh.split('\n');
            // Keep the last, possibly partial, line for the next poll.
            const complete = lines.slice(0, -1);
            delivered += fresh.length - (lines.at(-1)?.length ?? 0);
            for (const line of complete) {
              try {
                spec.onLine(line);
              } catch {
                /* a listener must not fail the build it is watching */
              }
            }
          }
        },
      },
    );

    log = await this.log(final).catch(() => log);
    const reports = await this.reports(build.id);

    return {
      exitCode: final.status === 'SUCCESS' ? 0 : 1,
      status: timedOut || final.status === 'TIMEOUT'
        ? 'TIMEOUT'
        : final.status === 'SUCCESS' ? 'SUCCESS' : 'FAILURE',
      log,
      logExcerpt: excerpt(log),
      durationMs: Date.now() - started,
      reports,
      provider: {
        cloudBuildId: build.id,
        region: this.options.region,
        ...(final.logUrl ? { logUrl: final.logUrl } : {}),
      },
    };
  }

  /**
   * Submits the pipeline with this execution's substitutions.
   *
   * The repository token is passed as a Secret Manager version rather than a
   * substitution: Cloud Build echoes substitutions into the build log, and a
   * credential there would be readable by anyone with log access.
   */
  private async submit(spec: ExecutionSpec): Promise<{ id: string }> {
    const pipeline = parseYaml(await readFile(this.options.pipelinePath, 'utf8')) as
      Record<string, unknown>;

    const resultsUri = `gs://${this.options.resultsBucket}/runs/${Date.now().toString(36)}`;
    const body = {
      ...pipeline,
      substitutions: {
        ...(pipeline.substitutions as Record<string, string> | undefined),
        _REPO_URL: (this.options.repoUrl ?? '').replace(/^https?:\/\//, ''),
        _COMMIT_SHA: spec.commitSha,
        _BUILD_IMAGE: this.options.buildImage,
        // One pipeline, two commands: the caller decides which half runs by
        // making the other a no-op, so build and test stay separate executions
        // and `EXEC-VER-002` keeps something of its own to read.
        _BUILD_CMD: spec.command,
        _TEST_CMD: spec.command,
        _RESULTS_URI: resultsUri,
        ...(this.options.cacheUri ? { _CACHE_URI: this.options.cacheUri } : {}),
        ...(this.options.tokenSecretVersion
          ? { _TOKEN_SECRET_VERSION: this.options.tokenSecretVersion }
          : {}),
      },
      ...(this.options.serviceAccount
        ? { serviceAccount: this.options.serviceAccount }
        : {}),
    };

    const operation = await this.transport.request<{
      metadata?: { build?: { id?: string } };
      name?: string;
    }>({
      method: 'POST',
      url: `https://cloudbuild.googleapis.com/v1/projects/${this.options.projectId}`
        + `/locations/${this.options.region}/builds`,
      body,
    });

    const id = operation.metadata?.build?.id;
    if (!id) {
      throw new GcpApiError(500, 'cloudbuild', 'build submitted but returned no id');
    }
    this.resultsUri = resultsUri;
    return { id };
  }

  private resultsUri = '';

  private get(id: string): Promise<BuildResource> {
    return this.transport.request<BuildResource>({
      method: 'GET',
      url: `https://cloudbuild.googleapis.com/v1/projects/${this.options.projectId}`
        + `/locations/${this.options.region}/builds/${id}`,
    });
  }

  /**
   * The build's log object, as it grows.
   *
   * A 404 while the build is queued is expected, not an error — the object does
   * not exist until the first step writes to it.
   */
  private async log(build: BuildResource): Promise<string> {
    const bucket = build.logsBucket?.replace(/^gs:\/\//, '');
    if (!bucket) return '';
    try {
      return await this.transport.request<string>({
        method: 'GET',
        url: `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}`
          + `/o/${encodeURIComponent(`log-${build.id}.txt`)}?alt=media`,
        text: true,
      });
    } catch (e) {
      if (e instanceof GcpApiError && e.status === 404) return '';
      throw e;
    }
  }

  /**
   * The JUnit XML the pipeline uploaded.
   *
   * The same files the local executor reads off disk, fetched from where the
   * `collect` step put them — so `parseReports` is unchanged and every check
   * built on it is measuring the same thing in both environments.
   */
  private async reports(buildId: string): Promise<TestReportFile[]> {
    void buildId;
    if (!this.resultsUri) return [];
    const [, bucket, prefix] = /^gs:\/\/([^/]+)\/(.*)$/.exec(this.resultsUri) ?? [];
    if (!bucket) return [];

    const listing = await this.transport.request<{ items?: Array<{ name: string }> }>({
      method: 'GET',
      url: `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o`
        + `?prefix=${encodeURIComponent(`${prefix}/reports/`)}`,
    }).catch(() => ({ items: [] as Array<{ name: string }> }));

    const out: TestReportFile[] = [];
    for (const item of listing.items ?? []) {
      if (!item.name.endsWith('.xml')) continue;
      const xml = await this.transport.request<string>({
        method: 'GET',
        url: `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}`
          + `/o/${encodeURIComponent(item.name)}?alt=media`,
        text: true,
      }).catch(() => '');
      if (xml) {
        // The path is what tells `parseReports` unit from integration, so the
        // plugin directory is preserved rather than flattened to a basename.
        const name = item.name.split('/').pop() ?? item.name;
        out.push({
          path: `target/${/IT\.xml$|IntegrationTest\.xml$/.test(name) ? 'failsafe' : 'surefire'}-reports/${name}`,
          xml,
        });
      }
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }
}
