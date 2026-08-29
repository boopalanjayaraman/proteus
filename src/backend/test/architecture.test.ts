import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The import boundary, enforced.
 *
 * `docs/pqc_migration_folder_structure_v1.md` §4 states the rule that makes
 * "Gemini reasons, tools establish truth" structural rather than aspirational:
 *
 *     FORBIDDEN:  core/         -> agent/
 *     FORBIDDEN:  verification/ -> agent/
 *     FORBIDDEN:  agent/        -> direct MongoDB driver access
 *
 * A rule nobody checks gets broken, and PRD-07 is the increment where the
 * temptation arrives — it is the first one with agent code in the tree.
 */

const SRC = fileURLToPath(new URL('../src', import.meta.url));

async function tsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await tsFiles(full)));
    else if (e.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

const IMPORT = /^\s*import\s[^'"]*['"]([^'"]+)['"]/gm;

async function importsOf(file: string): Promise<string[]> {
  const text = await readFile(file, 'utf8');
  return [...text.matchAll(IMPORT)].map((m) => m[1]!);
}

describe('architectural boundaries', () => {
  it('core/ never imports agent/', async () => {
    const offenders: string[] = [];
    for (const f of await tsFiles(join(SRC, 'core'))) {
      for (const spec of await importsOf(f)) {
        if (/(^|\/)agent\//.test(spec)) offenders.push(`${relative(SRC, f)} -> ${spec}`);
      }
    }
    expect(offenders, 'core/ must not depend on the agent layer').toEqual([]);
  });

  it('verification/ never imports agent/ — the verifier cannot consult the model', async () => {
    const dir = join(SRC, 'verification');
    let files: string[];
    try { files = await tsFiles(dir); } catch { return; } // not built yet

    const offenders: string[] = [];
    for (const f of files) {
      for (const spec of await importsOf(f)) {
        if (/(^|\/)agent\//.test(spec)) offenders.push(`${relative(SRC, f)} -> ${spec}`);
      }
    }
    expect(offenders, 'spec §34: only tool evidence marks a migration verified').toEqual([]);
  });

  it('agent/ never touches the MongoDB driver directly', async () => {
    const dir = join(SRC, 'agent');
    let files: string[];
    try { files = await tsFiles(dir); } catch { return; }

    const offenders: string[] = [];
    for (const f of files) {
      for (const spec of await importsOf(f)) {
        if (spec === 'mongodb' || spec.startsWith('mongodb/')) {
          offenders.push(`${relative(SRC, f)} -> ${spec}`);
        }
        if (/core\/db\//.test(spec)) offenders.push(`${relative(SRC, f)} -> ${spec}`);
      }
    }
    expect(
      offenders,
      'the agent reaches the database only through core/repositories, so it stays extractable',
    ).toEqual([]);
  });

  it('the api layer does not reach into the database driver either', async () => {
    const offenders: string[] = [];
    for (const f of await tsFiles(join(SRC, 'api'))) {
      for (const spec of await importsOf(f)) {
        if (spec === 'mongodb') offenders.push(`${relative(SRC, f)} -> ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('only worker/ and server.ts join the deterministic and reasoning halves', async () => {
    // The orchestration has to see both, and exactly one place should. If a
    // route or a repository starts importing the agent, the boundary that makes
    // `agent/` extractable has quietly gone.
    const allowed = /^(worker\/|server\.ts$)/;
    const offenders: string[] = [];

    for (const dir of ['api', 'core', 'integrations', 'verification', 'reports']) {
      let files: string[];
      try { files = await tsFiles(join(SRC, dir)); } catch { continue; }
      for (const f of files) {
        const rel = relative(SRC, f);
        if (allowed.test(rel)) continue;
        for (const spec of await importsOf(f)) {
          if (/(^|\/)agent\//.test(spec)) offenders.push(`${rel} -> ${spec}`);
        }
      }
    }
    expect(offenders, 'the agent is reachable from worker/ and server.ts only').toEqual([]);
  });

  it('has no compiled JavaScript shadowing the shared schema source', async () => {
    // Vite resolves `.js` before `.ts`, so a `migration.js` emitted beside
    // `migration.ts` silently becomes what every workspace imports — including
    // the tests, which then pass against a schema nobody edited. Found the hard
    // way in PRD-10: a new export was invisible until the artefacts were deleted.
    const schemaSrc = fileURLToPath(new URL('../../../schema/src', import.meta.url));
    const shadows = (await readdir(schemaSrc)).filter((f) => f.endsWith('.js'));
    expect(shadows, 'delete these; they are build output, not source').toEqual([]);
  });
});
