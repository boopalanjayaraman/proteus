import type { PlanItem } from '@proteus/schema';

/**
 * The parameter set the approved plan names.
 *
 * One definition, used by both the loop (which tells the patch agent what to
 * migrate to) and the job (which tells test generation what to assert and
 * decides whether a round-trip probe can be built).
 *
 * It lived only in the loop, and `buildMigrationContext` never set
 * `MigrationContext.target` at all. So the field was permanently undefined:
 * test generation had been inferring the target from the plan item's prose, and
 * the round-trip probe — guarded on that field — was silently skipped on every
 * run while logging a warning nobody reads.
 */
export interface ApprovedTarget {
  target: string;
  parameterSet?: string;
}

const PARAMETER_SET = /ML-KEM-(512|768|1024)/i;

export function targetOfItem(item: PlanItem): ApprovedTarget | undefined {
  const m = PARAMETER_SET.exec(`${item.action} ${item.rationale}`);
  return m ? { target: 'ML-KEM', parameterSet: m[0].toUpperCase() } : undefined;
}

/** The first target the approved items name. */
export function approvedTargetOf(items: PlanItem[]): ApprovedTarget | undefined {
  for (const item of items) {
    const t = targetOfItem(item);
    if (t) return t;
  }
  return undefined;
}
