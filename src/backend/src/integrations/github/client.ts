import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Read-only repository access.
 *
 * This class deliberately exposes no way to branch, commit or push. Before
 * approval the system may only read (spec §6), and the cheapest way to guarantee
 * that is for the capability not to exist. PRD-11 adds a separate writing client.
 *
 * The token is passed per call and never held on the instance — it is fetched
 * from the vault at the moment of use and dropped when the call returns.
 */

export interface RepositoryRef {
  owner: string;
  repo: string;
}

export interface CheckedOut {
  /** Local path to the working copy. */
  dir: string;
  commitSha: string;
  defaultBranch: string;
  /** Removes the working copy. Always call it. */
  dispose: () => Promise<void>;
}

export class RepositoryAccessError extends Error {
  constructor(message: string, readonly kind: 'AUTH' | 'NOT_FOUND' | 'TRANSPORT' = 'TRANSPORT') {
    super(message);
    this.name = 'RepositoryAccessError';
  }
}

/** `https://github.com/northwind-pay/payments-api` -> `{owner, repo}` */
export function parseRepositoryUrl(url: string): RepositoryRef {
  const m = /github\.com[/:]([^/]+)\/([^/.]+)/.exec(url.trim());
  if (!m?.[1] || !m[2]) throw new RepositoryAccessError(`not a GitHub URL: ${url}`, 'NOT_FOUND');
  return { owner: m[1], repo: m[2] };
}

/** A permanent link to a line, for evidence the user can click. */
export function permalink(ref: RepositoryRef, commitSha: string, path: string, line?: number): string {
  const base = `https://github.com/${ref.owner}/${ref.repo}/blob/${commitSha}/${path}`;
  return line ? `${base}#L${line}` : base;
}

export class GitHubReader {
  /**
   * Clones at the default branch head.
   *
   * `--depth 1` because discovery reads the tree, not the history. The token
   * appears in the remote URL for the duration of the call and is stripped from
   * the stored remote immediately afterwards, so it cannot be recovered from
   * `.git/config` by anything that later reads the working copy.
   */
  async checkout(url: string, token: string): Promise<CheckedOut> {
    const ref = parseRepositoryUrl(url);
    const dir = await mkdtemp(join(tmpdir(), 'proteus-'));
    const authenticated = `https://x-access-token:${token}@github.com/${ref.owner}/${ref.repo}.git`;

    try {
      await run('git', ['clone', '--depth', '1', '--quiet', authenticated, dir], {
        // Never let git prompt; an unauthenticated clone should fail, not hang.
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' },
        timeout: 120_000,
      });
    } catch (e) {
      await rm(dir, { recursive: true, force: true });
      throw classify(e, url);
    }

    // The credential must not survive in the working copy.
    await run('git', ['-C', dir, 'remote', 'set-url', 'origin',
      `https://github.com/${ref.owner}/${ref.repo}.git`]).catch(() => undefined);

    const { stdout: sha } = await run('git', ['-C', dir, 'rev-parse', 'HEAD']);
    const { stdout: branch } = await run('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD']);

    return {
      dir,
      commitSha: sha.trim(),
      defaultBranch: branch.trim(),
      dispose: () => rm(dir, { recursive: true, force: true }),
    };
  }

  /**
   * Confirms the token can read the repository.
   *
   * Used to move `credential.status` to `INVALID` as a finding rather than
   * discovering it as a crash halfway through discovery (FR-2).
   */
  async verify(url: string, token: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    const ref = parseRepositoryUrl(url);
    try {
      await run('git', ['ls-remote', '--exit-code', '-h',
        `https://x-access-token:${token}@github.com/${ref.owner}/${ref.repo}.git`, 'HEAD'], {
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' },
        timeout: 30_000,
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: classify(e, url).message };
    }
  }
}

/**
 * Turns git's stderr into something actionable — and strips the token, which
 * git happily echoes back inside the failing URL.
 */
function classify(e: unknown, url: string): RepositoryAccessError {
  const raw = String((e as { stderr?: string })?.stderr ?? (e as Error)?.message ?? e);
  const safe = raw.replace(/x-access-token:[^@]+@/g, 'x-access-token:[REDACTED]@');

  if (/Authentication failed|could not read Username|invalid credentials|403/i.test(safe)) {
    return new RepositoryAccessError(`authentication failed for ${url}`, 'AUTH');
  }
  if (/not found|does not exist|Repository not found|404/i.test(safe)) {
    return new RepositoryAccessError(`repository not found or not visible: ${url}`, 'NOT_FOUND');
  }
  return new RepositoryAccessError(`could not reach ${url}: ${safe.slice(0, 200)}`, 'TRANSPORT');
}
