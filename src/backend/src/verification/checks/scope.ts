import type { MigrationChange, PlanItem, VerificationCheckResult } from '@proteus/schema';

/**
 * Scope conformance (`EXEC-VER-001`).
 *
 * `PlanItem.expectedChanges` is the autonomy contract the human approved. This
 * is what makes "you approve this scope, not a generic start button" checkable
 * after the fact rather than merely stated before it — a file touched outside
 * the approved scope is a breach even when every test passes.
 *
 * Checked here as well as before each commit, because the two catch different
 * things: the commit-time check stops one patch, and this one catches a scope
 * that drifted across several of them.
 */

export interface ScopeBreach {
  path: string;
  changeId: string;
  sequence: number;
}

/**
 * A declared path pattern, as a matcher.
 *
 * `*` stops at a directory boundary and `**` crosses one. Built by walking the
 * glob rather than by chained replaces, so a literal escaped in one pass cannot
 * be re-interpreted by the next.
 */
export function toPattern(glob: string): RegExp {
  const SPECIAL = '.+^${}()|[]\\?';
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i++;
      } else {
        out += '[^/]*';
      }
    } else if (SPECIAL.includes(c)) {
      out += `\\${c}`;
    } else {
      out += c;
    }
  }
  return new RegExp(`^${out}$`);
}

/**
 * Every path the run touched, against everything the approved plan declared.
 *
 * Test-engineering changes are exempt: the plan declares what the *migration*
 * will change, and the tests written to judge it are authorised by
 * `EXEC-TEST-001` rather than by a plan item's path list. Holding generated
 * tests to the migration's declared paths would make writing them a scope
 * breach.
 */
export function checkScope(
  changes: MigrationChange[],
  approvedItems: PlanItem[],
): { result: VerificationCheckResult; breaches: ScopeBreach[] } {
  const declared = approvedItems.flatMap((p) => p.expectedChanges.flatMap((c) => c.paths));
  const patterns = declared.map(toPattern);

  const breaches: ScopeBreach[] = [];
  for (const change of changes) {
    if (change.intent === 'TEST_ENGINEERING') continue;
    for (const file of change.files) {
      if (!patterns.some((re) => re.test(file.path))) {
        breaches.push({ path: file.path, changeId: change.changeId, sequence: change.sequence });
      }
    }
  }

  const migrationChanges = changes.filter((c) => c.intent !== 'TEST_ENGINEERING');

  return {
    breaches,
    result: {
      check: 'MIGRATION_POLICY_SATISFIED',
      status: breaches.length === 0 ? 'PASS' : 'FAIL',
      detail: breaches.length === 0
        ? `${migrationChanges.length} migration change${migrationChanges.length === 1 ? '' : 's'} `
          + `across ${new Set(migrationChanges.flatMap((c) => c.files.map((f) => f.path))).size} `
          + `file(s), all within the ${declared.length} path pattern(s) the approval declared`
        : `${breaches.length} file(s) changed outside the approved scope: `
          + `${breaches.map((b) => b.path).join(', ')}`,
      // The changes themselves are the evidence. Every one names a commit.
      evidenceIds: [],
      findings: breaches.map((b) => ({ path: b.path, match: `modification #${b.sequence}` })),
    },
  };
}
