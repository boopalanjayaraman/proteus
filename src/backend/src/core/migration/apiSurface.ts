import type { WorkingCopy } from '../discovery/workingCopy';

/**
 * The public constructors and methods of every class in the repository.
 *
 * Both agent defects that reached a demo had one cause: **the agent wrote code
 * against files it could not see.**
 *
 * `PatchContext.files` and `MigrationContext.sources` deliberately carry only
 * the paths the plan authorises — A3 is never handed the repository. That is
 * right for what it may *edit*, and wrong for what it must *compile against*:
 *
 *  - Rewriting `CryptoUtils` for key transport, it dropped `sha256Hex`, `b64`
 *    and `unb64`, because nothing in its context showed `IdempotencyStore`
 *    calling them.
 *  - Asked to characterize an invariant about the settlement signer, it wrote
 *    `new SettlementSigner()` — the real constructor takes a
 *    `SigningKeyProvider`, and it had never been shown the class.
 *
 * Neither is a reasoning failure. Both are the model doing the best possible
 * job with a context missing the fact it needed. So the fact is supplied.
 *
 * Signatures only, never bodies: the agent needs to know what exists and how to
 * call it, and a body would both blow the context budget and invite editing a
 * file outside the approved scope.
 */

export interface ApiMember {
  /** `pay.security.SettlementSigner` */
  className: string;
  path: string;
  /** `SettlementSigner(SigningKeyProvider keys)`, `byte[] sign(byte[] canonicalAdvice)` */
  members: string[];
}

/** `public class Foo`, `public interface Bar`, `public enum Baz`. */
const CLASS = /^\s*public\s+(?:final\s+|abstract\s+)?(?:class|interface|enum|record)\s+(\w+)/;

/** A public constructor or method declaration, captured up to the paren list. */
const MEMBER =
  /^\s*public\s+(?:static\s+|final\s+|synchronized\s+)*([\w<>,[\]\s.?]+\s+)?(\w+)\s*\(([^)]*)\)/;

const PACKAGE = /^\s*package\s+([\w.]+)\s*;/;

/**
 * Reads signatures out of the repository's main sources.
 *
 * A regex rather than a parser because the output is a prompt, not a decision.
 * Nothing downstream branches on it: a missed member costs the agent one fact,
 * where a parser dependency would cost a build. Rules never read this.
 */
export async function apiSurfaceOf(
  wc: WorkingCopy,
  options: { maxFiles?: number; maxMembersPerClass?: number } = {},
): Promise<ApiMember[]> {
  const maxFiles = options.maxFiles ?? 60;
  const maxMembers = options.maxMembersPerClass ?? 20;

  const files = (await wc.files()).filter(
    (f) => f.kind === 'SOURCE' && /\.(java|kt)$/.test(f.path),
  );

  const out: ApiMember[] = [];
  for (const file of files.slice(0, maxFiles)) {
    const content = await wc.read(file.path).catch(() => '');
    if (!content) continue;

    let pkg = '';
    let className = '';
    const members: string[] = [];

    for (const raw of content.split('\n')) {
      const line = raw.replace(/\/\/.*$/, '');

      const p = PACKAGE.exec(line);
      if (p) { pkg = p[1]!; continue; }

      const c = CLASS.exec(line);
      if (c && !className) { className = c[1]!; continue; }

      if (!className || members.length >= maxMembers) continue;

      const m = MEMBER.exec(line);
      if (!m) continue;
      const returnType = (m[1] ?? '').trim();
      const name = m[2]!;
      const args = m[3]!.trim();

      // A constructor has no return type and matches the class name; anything
      // else without one is a modifier the regex mis-split, so it is skipped
      // rather than reported as a member that does not exist.
      const isConstructor = !returnType && name === className;
      if (!isConstructor && !returnType) continue;

      members.push(isConstructor ? `${name}(${args})` : `${returnType} ${name}(${args})`);
    }

    if (className && members.length > 0) {
      out.push({ className: pkg ? `${pkg}.${className}` : className, path: file.path, members });
    }
  }

  return out;
}

/** The prompt block. Empty when nothing was read, so no heading appears alone. */
export function apiSurfaceLines(surface: ApiMember[]): string[] {
  if (surface.length === 0) return [];
  return [
    '',
    'THE REPOSITORY\'S PUBLIC API, as it exists right now.',
    '',
    'You are shown this so you can CALL these types correctly and so you can see',
    'which members other files depend on. Two rules follow from it:',
    '',
    '  - Do not invent a constructor or method. If you need one that is not listed,',
    '    the design is wrong — say so in your rationale rather than guessing.',
    '  - When you rewrite a file listed here, every public member it already has',
    '    must still exist afterwards unless the plan explicitly removes it. Callers',
    '    you cannot see depend on them, and deleting one breaks a file you were',
    '    never authorised to fix.',
    '',
    ...surface.map((c) => `  ${c.className}\n${c.members.map((m) => `      ${m}`).join('\n')}`),
  ];
}
