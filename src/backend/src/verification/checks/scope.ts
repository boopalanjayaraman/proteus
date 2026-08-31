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
 * Re-exported so the existing callers and tests keep working, while there is
 * only one definition. See `core/migration/glob.ts` for why that matters.
 */
import { toPattern } from '../../core/migration/glob';

export { toPattern };

/**
 * Every path the run touched, against everything the approved plan declared.
 *
 * The discriminator is what authorised the change, not what kind it is.
 * `expectedChanges` is the contract for *implementation* changes — source,
 * dependencies, configuration — and those are bound to the declared paths.
 *
 * A test, mock or fixture change is authorised by something else: the
 * `EXEC-TEST-*` rules for one written up front, and a `testIntegrity` record
 * for one made during a repair. The schema already refuses such a change
 * without that record, so its presence is the authorisation, and holding it to
 * the migration's path list as well would make spec §26's own example — "the
 * agent should not ask: should I update the mock?" — a scope breach.
 */
export function checkScope(
  changes: MigrationChange[],
  approvedItems: PlanItem[],
): { result: VerificationCheckResult; breaches: ScopeBreach[] } {
  const declared = approvedItems.flatMap((p) => p.expectedChanges.flatMap((c) => c.paths));
  const patterns = declared.map(toPattern);

  const breaches: ScopeBreach[] = [];
  for (const change of changes) {
    if (change.intent === 'TEST_ENGINEERING' || change.testIntegrity) continue;
    for (const file of change.files) {
      if (!patterns.some((re) => re.test(file.path))) {
        breaches.push({ path: file.path, changeId: change.changeId, sequence: change.sequence });
      }
    }
  }

  const migrationChanges = changes.filter(
    (c) => c.intent !== 'TEST_ENGINEERING' && !c.testIntegrity,
  );

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
