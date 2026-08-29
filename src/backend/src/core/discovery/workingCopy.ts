import { readFile, readdir, stat } from 'node:fs/promises';
import { extname, join, relative, sep } from 'node:path';

/**
 * A checked-out tree, as discovery sees it.
 *
 * Deliberately an abstraction over "a directory" rather than over GitHub: the
 * detection pass has no business knowing where the files came from, and tests
 * can point it straight at the fixture rather than cloning.
 */

export type FileKindHint = 'SOURCE' | 'CONFIG' | 'MANIFEST' | 'TEST' | 'CERTIFICATE' | 'OTHER';

export interface RepoFile {
  /** Repository-relative, forward-slashed regardless of platform. */
  path: string;
  kind: FileKindHint;
  sizeBytes: number;
}

const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'target', 'build', 'dist', '.idea', '.vscode', '.gradle',
]);

/** Files worth reading. Binaries and build output are noise, not evidence. */
const READABLE = new Set([
  '.java', '.kt', '.scala', '.groovy', '.xml', '.yml', '.yaml', '.properties',
  '.json', '.sarif', '.md', '.txt', '.gradle', '.pem', '.crt', '.cer', '.conf',
]);

const MAX_FILE_BYTES = 512 * 1024;

export class WorkingCopy {
  private cache: RepoFile[] | null = null;

  constructor(readonly root: string) {}

  /** Every readable file in the tree, classified. */
  async files(): Promise<RepoFile[]> {
    if (this.cache) return this.cache;
    const out: RepoFile[] = [];

    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.') && entry.name !== '.gitignore') {
          if (SKIP_DIRS.has(entry.name)) continue;
        }
        if (SKIP_DIRS.has(entry.name)) continue;

        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
          continue;
        }
        if (!READABLE.has(extname(entry.name).toLowerCase())) continue;

        const info = await stat(full);
        if (info.size > MAX_FILE_BYTES) continue;

        const path = relative(this.root, full).split(sep).join('/');
        out.push({ path, kind: classify(path), sizeBytes: info.size });
      }
    };

    await walk(this.root);
    this.cache = out.sort((a, b) => a.path.localeCompare(b.path));
    return this.cache;
  }

  async read(path: string): Promise<string> {
    return readFile(join(this.root, path), 'utf8');
  }

  /** Total file count for the discovery progress tile, build output excluded. */
  async fileCount(): Promise<number> {
    return (await this.files()).length;
  }
}

/**
 * Classifies a path.
 *
 * `TEST` is checked before `SOURCE` because a Java test is also a `.java` file,
 * and the distinction decides whether a finding is a migration target or a mock
 * incompatibility — `EXEC-DIAG-004` turns on exactly this.
 */
export function classify(path: string): FileKindHint {
  const p = path.toLowerCase();
  if (/(^|\/)(src\/test|test|tests)\//.test(p) || /test\.java$|tests\.java$|mock\.java$/.test(p)) {
    return 'TEST';
  }
  if (/(^|\/)(pom\.xml|build\.gradle|build\.gradle\.kts|package\.json)$/.test(p)) return 'MANIFEST';
  if (/\.(pem|crt|cer)$/.test(p) || /deploy\/tls\//.test(p)) return 'CERTIFICATE';
  if (/\.(ya?ml|properties|conf)$/.test(p) || /application[^/]*\.(ya?ml|properties)$/.test(p)) {
    return 'CONFIG';
  }
  if (/\.(java|kt|scala|groovy)$/.test(p)) return 'SOURCE';
  return 'OTHER';
}
