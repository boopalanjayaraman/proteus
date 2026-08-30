import { execFile } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { parseRepositoryUrl, RepositoryAccessError } from './client';

const run = promisify(execFile);

/**
 * Write access to the repository, and only after a human said so.
 *
 * A separate class from `GitHubReader` rather than methods added to it, because
 * the reader's guarantee is structural: before approval the system may only
 * read, and the cheapest way to guarantee that is for the writing capability not
 * to exist on the object discovery holds.
 *
 * Two invariants hold here regardless of what the agent asks for:
 *
 *   NEVER THE BASE   every write happens on `agent/pqc/{projectId}`. The branch
 *                    name is fixed at construction and checked before each
 *                    commit, so "the original branch remains untouched" (spec
 *                    §23) does not depend on the caller getting it right.
 *   NEVER OUTSIDE    a path that escapes the working copy is refused. A patch
 *                    naming `../../etc/something` is a path traversal wearing a
 *                    diff, and the agent proposes these paths.
 */

export interface CommitResult {
  commitSha: string;
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
}

export class GitWriter {
  constructor(
    /** The checked-out tree. Must already be at the base commit. */
    readonly dir: string,
    readonly branchName: string,
    private readonly authorName = 'Proteus PQC Agent',
    private readonly authorEmail = 'proteus@users.noreply.github.com',
  ) {}

  private git(...args: string[]) {
    return run('git', ['-C', this.dir, ...args], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' },
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
    });
  }

  /**
   * Creates the migration branch at the recorded base commit.
   *
   * `git checkout -b` from an explicit sha rather than from HEAD: the approval
   * pinned a commit, and branching from wherever the clone happens to be would
   * silently migrate a different tree than the one that was assessed.
   */
  async createBranch(baseCommitSha: string): Promise<{ branch: string; baseCommitSha: string }> {
    await this.git('config', 'user.name', this.authorName);
    await this.git('config', 'user.email', this.authorEmail);

    // A shallow clone may not contain the commit. Fetching it by sha is cheaper
    // than re-cloning and fails loudly if the assessment's commit is gone.
    const { stdout: head } = await this.git('rev-parse', 'HEAD');
    if (head.trim() !== baseCommitSha) {
      await this.git('fetch', '--depth', '1', 'origin', baseCommitSha).catch(() => undefined);
    }

    try {
      await this.git('checkout', '-b', this.branchName, baseCommitSha);
    } catch {
      // Fall back to HEAD only when the clone genuinely cannot reach the sha,
      // and say so rather than pretending the base was honoured.
      throw new RepositoryAccessError(
        `cannot branch from ${baseCommitSha.slice(0, 7)}: the commit is not in the working copy`,
        'NOT_FOUND',
      );
    }

    const { stdout: sha } = await this.git('rev-parse', 'HEAD');
    return { branch: this.branchName, baseCommitSha: sha.trim() };
  }

  /** The branch currently checked out. Read before every commit. */
  async currentBranch(): Promise<string> {
    const { stdout } = await this.git('rev-parse', '--abbrev-ref', 'HEAD');
    return stdout.trim();
  }

  /**
   * Writes a file into the working copy.
   *
   * @throws when the path escapes the tree. The agent chooses these paths, and
   *         a relative path that climbs out of the repository is the one input
   *         that turns a code change into an arbitrary write.
   */
  async writeFile(relativePath: string, content: string): Promise<void> {
    const full = safeJoin(this.dir, relativePath);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, 'utf8');
  }

  /**
   * Removes a file from the working copy.
   *
   * For an artifact the rules have already refused after it was committed. A
   * generated test that fails on the base commit is not merely uninformative —
   * if it fails because it does not compile, it fails `testCompile` for every
   * build that follows it, and the run never recovers.
   *
   * Same path check as `writeFile`, for the same reason.
   */
  async removeFile(relativePath: string): Promise<void> {
    await rm(safeJoin(this.dir, relativePath), { force: true });
  }

  /**
   * Commits everything staged, refusing if the branch is not the migration one.
   *
   * The check is here rather than at the call site because there is exactly one
   * place a commit can happen and one guarantee that must hold at it.
   */
  async commit(message: string, paths: string[]): Promise<CommitResult> {
    const branch = await this.currentBranch();
    if (branch !== this.branchName) {
      throw new RepositoryAccessError(
        `refusing to commit on ${branch}: writes are confined to ${this.branchName}`,
        'TRANSPORT',
      );
    }

    for (const p of paths) safeJoin(this.dir, p); // Validate before staging.
    await this.git('add', '--', ...paths);

    const { stdout: staged } = await this.git('diff', '--cached', '--numstat');
    if (!staged.trim()) {
      throw new RepositoryAccessError('nothing to commit — the patch changed no bytes');
    }

    await this.git('commit', '-m', message, '--no-verify');
    const { stdout: sha } = await this.git('rev-parse', 'HEAD');

    let added = 0;
    let removed = 0;
    for (const line of staged.trim().split('\n')) {
      const [a, r] = line.split('\t');
      added += Number(a) || 0;
      removed += Number(r) || 0;
    }

    return {
      commitSha: sha.trim(),
      filesChanged: staged.trim().split('\n').length,
      linesAdded: added,
      linesRemoved: removed,
    };
  }

  /** The unified diff for one commit — stored in blob storage, not Mongo. */
  async diffOf(commitSha: string): Promise<string> {
    const { stdout } = await this.git('show', '--patch', '--format=', commitSha);
    return stdout;
  }

  async commitCount(baseCommitSha: string): Promise<number> {
    const { stdout } = await this.git('rev-list', '--count', `${baseCommitSha}..HEAD`);
    return Number(stdout.trim()) || 0;
  }

  /**
   * Undoes the last commit, in the working copy as well as the record.
   *
   * `git revert` rather than `reset --hard`: EXEC-REP-003 exists so the diff
   * stays reviewable, and a branch that silently loses a commit is less
   * reviewable, not more. The revert is itself a commit, so the reader can see
   * that an attempt was made and withdrawn.
   */
  async revertLastCommit(reason: string): Promise<void> {
    await this.git('revert', '--no-edit', '--no-gpg-sign', 'HEAD', '-m', '1')
      .catch(async () => {
        // A merge-free branch rejects `-m 1`; retry without it before giving up.
        await this.git('revert', '--no-edit', '--no-gpg-sign', 'HEAD');
      });
    await this.git('commit', '--amend', '--no-edit', '--no-gpg-sign', '-m',
      `Revert: ${reason}`).catch(() => undefined);
  }

  /**
   * Pushes the migration branch. The token lives for the duration of the call.
   *
   * Forced, with a lease. A retry rebuilds the branch from the base commit, so
   * its history is not a fast-forward of the previous attempt's and a plain push
   * is rejected with "fetch first" — which is what happened, leaving the work
   * committed locally and invisible.
   *
   * `--force-with-lease` rather than `--force`: it refuses if the remote moved
   * for a reason this process does not know about. The branch is the agent's own
   * — `agent/pqc/{projectId}`, rewritten by every run — so overwriting the
   * previous attempt is the intent, but overwriting somebody's edit is not.
   */
  async push(repositoryUrl: string, token: string): Promise<void> {
    const ref = parseRepositoryUrl(repositoryUrl);
    const authenticated =
      `https://x-access-token:${token}@github.com/${ref.owner}/${ref.repo}.git`;
    try {
      await this.git(
        'push', '--force-with-lease', '--set-upstream', authenticated, this.branchName,
      );
    } catch (e) {
      const raw = String((e as { stderr?: string }).stderr ?? (e as Error).message);
      throw new RepositoryAccessError(
        `push failed: ${raw.replace(/x-access-token:[^@]+@/g, 'x-access-token:[REDACTED]@').slice(0, 200)}`,
      );
    }
  }
}

/**
 * Joins and refuses to leave the tree.
 *
 * Exported because it is the security-relevant half of this file and deserves a
 * test of its own rather than only being exercised through a git call.
 */
export function safeJoin(root: string, relativePath: string): string {
  if (relativePath.startsWith('/') || /^[a-zA-Z]:/.test(relativePath)) {
    throw new RepositoryAccessError(`absolute path refused: ${relativePath}`);
  }
  const full = resolve(root, relativePath);
  const rootResolved = resolve(root);
  if (full !== rootResolved && !full.startsWith(rootResolved + sep)) {
    throw new RepositoryAccessError(`path escapes the working copy: ${relativePath}`);
  }
  if (full.split(sep).includes('.git')) {
    throw new RepositoryAccessError(`refusing to write inside .git: ${relativePath}`);
  }
  return full;
}

/** A fresh working copy for a migration, cloned deep enough to reach the base. */
export function migrationBranchName(projectId: string): string {
  return `agent/pqc/${projectId}`;
}

export const repoPath = (dir: string, p: string): string => join(dir, p);
