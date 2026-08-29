import { spawn } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Where tools establish truth.
 *
 * Everything the migration later claims — the baseline, the known failures, the
 * verification verdict — rests on a command that actually ran and an exit code
 * that actually came back. So this is an interface with real implementations
 * rather than anything the model can reach: an agent that could report its own
 * build result would be reporting an opinion.
 *
 * `ProcessExecutor` runs the command, optionally inside a container image, which
 * is how a Java 17 Maven build runs on a machine that has neither. Cloud Build
 * uses the same shape and the same pipeline file
 * (`deployment/cloudbuild/migration-build.yaml`); wiring the submission client
 * belongs with the deployment increment.
 */

export interface ExecutionSpec {
  /** The checked-out tree the command runs against. */
  workdir: string;
  command: string;
  commitSha: string;
  timeoutMs?: number;
  /**
   * Called for every line the build writes, while it is still running.
   *
   * The reason the executor streams at all. Maven reports each test class as it
   * starts and again when it finishes, and names every failing method with its
   * assertion message — all of it minutes before the JUnit XML exists on a Cloud
   * Build round trip. Buffering the run throws that away and leaves the feed
   * still for the whole execution.
   *
   * Never throws into the run: a listener that fails must not fail the build it
   * is only watching.
   */
  onLine?: (line: string) => void;
}

export interface TestReportFile {
  path: string;
  xml: string;
}

export interface ExecutionOutcome {
  exitCode: number;
  status: 'SUCCESS' | 'FAILURE' | 'TIMEOUT';
  /** Capped. The full log goes to blob storage; this is what reasoning sees. */
  logExcerpt: string[];
  log: string;
  durationMs: number;
  /** JUnit XML found after the run. The only source of the test inventory. */
  reports: TestReportFile[];
  provider: { cloudBuildId?: string; logUrl?: string; region?: string };
}

export interface BuildExecutor {
  readonly environment: 'CLOUD_BUILD' | 'CLOUD_RUN_SANDBOX';
  run(spec: ExecutionSpec): Promise<ExecutionOutcome>;
}

const DEFAULT_TIMEOUT_MS = 15 * 60_000;
const MAX_EXCERPT_LINES = 50;

/** Where Maven and Gradle leave their JUnit XML. */
const REPORT_DIRS = [
  'target/surefire-reports',
  'target/failsafe-reports',
  'build/test-results/test',
];

export class ProcessExecutor implements BuildExecutor {
  readonly environment = 'CLOUD_BUILD' as const;

  /**
   * @param containerImage when set, the command runs inside it with the working
   *        copy bind-mounted. The fixture is built in
   *        `maven:3.9-eclipse-temurin-17`, and reproducing the baseline in a
   *        different toolchain than the one the code was written against would
   *        produce failures that belong to the machine, not the migration.
   */
  constructor(private readonly containerImage?: string) {}

  async run(spec: ExecutionSpec): Promise<ExecutionOutcome> {
    const started = Date.now();
    const [file, args] = this.commandLine(spec);
    const { exitCode, log, timedOut } = await this.spawn(file, args, spec);

    // Reports are collected whether or not the command succeeded. A failing
    // build still produces test results, and those results are the evidence.
    const reports = await collectReports(spec.workdir);

    return {
      exitCode,
      status: timedOut ? 'TIMEOUT' : exitCode === 0 ? 'SUCCESS' : 'FAILURE',
      log,
      logExcerpt: excerpt(log),
      durationMs: Date.now() - started,
      reports,
      provider: {},
    };
  }

  /**
   * Runs the command, delivering complete lines as they arrive.
   *
   * `spawn` rather than `execFile` because `execFile` buffers until exit. The
   * partial-line carry matters: a chunk boundary lands mid-line often enough
   * that emitting raw chunks would split `Tests run: 4, Fail…` across two
   * events and defeat the parser reading them.
   */
  private spawn(
    file: string,
    args: string[],
    spec: ExecutionSpec,
  ): Promise<{ exitCode: number; log: string; timedOut: boolean }> {
    return new Promise((resolve) => {
      const child = spawn(file, args, {
        cwd: spec.workdir,
        env: { ...process.env, MAVEN_OPTS: '-Dstyle.color=never' },
      });

      const chunks: string[] = [];
      let carry = '';
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, spec.timeoutMs ?? DEFAULT_TIMEOUT_MS);

      const consume = (buf: Buffer): void => {
        const text = buf.toString('utf8');
        chunks.push(text);
        carry += text;
        const lines = carry.split('\n');
        carry = lines.pop() ?? '';
        for (const line of lines) {
          if (!spec.onLine) continue;
          // A listener that throws must not take the build with it — it is
          // watching, not participating.
          try {
            spec.onLine(line);
          } catch {
            /* ignore */
          }
        }
      };

      child.stdout?.on('data', consume);
      child.stderr?.on('data', consume);

      const finish = (code: number): void => {
        clearTimeout(timer);
        if (carry && spec.onLine) {
          try {
            spec.onLine(carry);
          } catch {
            /* ignore */
          }
        }
        resolve({ exitCode: code, log: chunks.join(''), timedOut });
      };

      child.on('error', (e) => finish(chunks.push(String(e.message)) && 1));
      child.on('close', (code) => finish(timedOut ? 124 : code ?? 1));
    });
  }

  private commandLine(spec: ExecutionSpec): [string, string[]] {
    if (!this.containerImage) return ['sh', ['-lc', spec.command]];
    return [
      'docker',
      [
        'run', '--rm',
        '-v', `${spec.workdir}:/workspace`,
        // A warm dependency cache is the difference between a 30-second
        // baseline and a four-minute one, and the demo runs the loop repeatedly.
        '-v', 'proteus-m2:/root/.m2',
        '-w', '/workspace',
        this.containerImage,
        'sh', '-lc', spec.command,
      ],
    ];
  }
}

/**
 * An executor that answers from a script.
 *
 * Not a mock of the thing under test: the parsing, the classification and every
 * guardrail run for real against real JUnit XML. Only the minutes of Maven are
 * replaced, which is the one part an assertion could not say anything about.
 */
export class ScriptedExecutor implements BuildExecutor {
  readonly environment = 'CLOUD_BUILD' as const;
  readonly calls: ExecutionSpec[] = [];

  constructor(private readonly answers: Array<Partial<ExecutionOutcome> & { match?: RegExp }>) {}

  async run(spec: ExecutionSpec): Promise<ExecutionOutcome> {
    this.calls.push(spec);
    const answer = this.answers.find((a) => !a.match || a.match.test(spec.command))
      ?? this.answers[Math.min(this.calls.length - 1, this.answers.length - 1)];
    if (!answer) throw new Error(`no scripted execution for ${spec.command}`);

    return {
      exitCode: answer.exitCode ?? 0,
      status: answer.status ?? ((answer.exitCode ?? 0) === 0 ? 'SUCCESS' : 'FAILURE'),
      log: answer.log ?? '',
      logExcerpt: answer.logExcerpt ?? excerpt(answer.log ?? ''),
      durationMs: answer.durationMs ?? 1000,
      reports: answer.reports ?? [],
      provider: answer.provider ?? {},
    };
  }
}

/** Reads every JUnit XML the run produced, from wherever the build system put it. */
export async function collectReports(workdir: string): Promise<TestReportFile[]> {
  const out: TestReportFile[] = [];
  for (const dir of REPORT_DIRS) {
    let entries: string[];
    try {
      entries = await readdir(join(workdir, dir));
    } catch {
      continue; // The build system in use did not write here.
    }
    for (const name of entries) {
      if (!name.endsWith('.xml') || !name.startsWith('TEST-')) continue;
      out.push({ path: `${dir}/${name}`, xml: await readFile(join(workdir, dir, name), 'utf8') });
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * The lines worth reasoning about.
 *
 * Maven prints thousands of lines and about twenty of them matter. Selecting
 * deterministically here is what keeps the model's input a bounded, stable
 * extract rather than a log dump that changes shape with every run.
 */
export function excerpt(log: string): string[] {
  const lines = log.split('\n').map((l) => l.trimEnd()).filter(Boolean);
  const interesting = lines.filter((l) =>
    /\[ERROR\]|\[WARNING\]|BUILD (FAILURE|SUCCESS)|Tests run:|FAIL|Exception|Caused by:/i.test(l));
  const chosen = interesting.length > 0 ? interesting : lines.slice(-MAX_EXCERPT_LINES);
  return chosen.slice(0, MAX_EXCERPT_LINES);
}
