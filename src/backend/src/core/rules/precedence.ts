import type { ExecutionFamily } from '@proteus/schema';

/**
 * Explicit precedence for families where more than one rule can match the same facts.
 *
 * The rulesets document precedence in prose ("evaluated LAST", "outranks
 * EXEC-DIAG-004"). Prose does not execute. This table is the executable form, and
 * `assertPrecedenceCoverage` fails if a rule joins one of these families without a
 * precedence decision — so adding a classifier forces someone to say where it sits
 * rather than having order fall out of file position.
 *
 * Lower index wins.
 */
export const PRECEDENCE: Partial<Record<ExecutionFamily, string[]>> = {
  /**
   * A failing baseline invariant is never a test defect (EXEC-DIAG-005), so it is
   * evaluated before the mock and fixture classifiers that would otherwise claim it.
   * The two "not the agent's fault" classifiers come next, because they exempt the
   * failure from the retry budget and must not be shadowed.
   */
  FAILURE_CLASSIFICATION: [
    'EXEC-DIAG-005', // baseline invariant failing -> EXPECTED_BEHAVIOR_CHANGE, gate
    'EXEC-DIAG-012', // originates outside the boundary -> not repairable, no budget
    'EXEC-DIAG-007', // environment failure -> free retry, no budget
    'EXEC-DIAG-003', // dependency resolution
    'EXEC-DIAG-002', // compile error in changed file
    'EXEC-DIAG-009', // build failure outside changed set
    'EXEC-DIAG-010', // configuration defect
    'EXEC-DIAG-004', // mock incompatibility
    'EXEC-DIAG-011', // fixture outdated
    'EXEC-DIAG-006', // coverage gap
    'EXEC-DIAG-001', // procedural: classify deterministically first
    'EXEC-DIAG-008', // nothing matched -> UNKNOWN, gate
  ],

  /**
   * AUTONOMOUS_MIGRATION (EXEC-DISP-009) is evaluated LAST: every rule that could
   * place the finding outside the autonomy boundary gets first refusal. Anything
   * that reaches the end is genuinely in scope.
   */
  DISPOSITION: [
    'EXEC-DISP-001', // not quantum-vulnerable
    'EXEC-DISP-002', // signature usage — out of scope
    'EXEC-DISP-003', // firmware-fixed algorithm set
    'EXEC-DISP-004', // hardware capability not declared
    'EXEC-DISP-005', // vendor-supplied software
    'EXEC-DISP-006', // protocol-managed / unconfirmed peer
    'EXEC-DISP-008', // certificate / PKI
    'EXEC-DISP-007', // test or mock code
    'EXEC-DISP-009', // autonomous migration — last
  ],
};

export class PrecedenceGapError extends Error {}

/**
 * Every rule in an ordered family must appear in the table, and every id in the
 * table must exist. Called at load: a precedence gap is a startup failure, not a
 * surprise at evaluation time.
 */
export function assertPrecedenceCoverage(
  rulesByFamily: Map<string, { ruleId: string }[]>,
): void {
  const problems: string[] = [];
  for (const [family, order] of Object.entries(PRECEDENCE)) {
    const rules = rulesByFamily.get(family) ?? [];
    const present = new Set(rules.map((r) => r.ruleId));
    const ordered = new Set(order);
    for (const r of rules) {
      if (!ordered.has(r.ruleId)) {
        problems.push(`${family}: ${r.ruleId} has no precedence decision`);
      }
    }
    for (const id of order) {
      if (!present.has(id)) problems.push(`${family}: precedence names unknown rule ${id}`);
    }
  }
  if (problems.length) throw new PrecedenceGapError(problems.join('\n'));
}

/** Sorts matched rules by the family's precedence; unordered families keep file order. */
export function byPrecedence<T extends { ruleId: string; family: string }>(rules: T[]): T[] {
  return [...rules].sort((a, b) => {
    const order = PRECEDENCE[a.family as ExecutionFamily];
    if (!order || a.family !== b.family) return 0;
    const ia = order.indexOf(a.ruleId);
    const ib = order.indexOf(b.ruleId);
    return (ia < 0 ? Number.MAX_SAFE_INTEGER : ia) - (ib < 0 ? Number.MAX_SAFE_INTEGER : ib);
  });
}
