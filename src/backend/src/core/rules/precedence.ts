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
    'EXEC-DIAG-005', // MUST_PRESERVE invariant failing -> regression, gate
    // Immediately after 005 and mutually exclusive with it: one covers the
    // invariant that had to survive, the other the one that had to change. If a
    // single assertion somehow carried both dispositions, the regression reading
    // must win.
    'EXEC-DIAG-013', // EXPECTED_TO_CHANGE invariant failing -> authorised update
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
   *
   * EXEC-DISP-010 sits immediately before it and is mutually exclusive with it —
   * 009 requires a determined usage, 010 requires an undetermined one — so the
   * order between them is belt and braces rather than load-bearing. It is stated
   * anyway: relying on two `when` clauses staying disjoint is how an ambiguous
   * usage would eventually be migrated autonomously.
   */
  DISPOSITION: [
    'EXEC-DISP-001', // not quantum-vulnerable
    'EXEC-DISP-003', // firmware-fixed algorithm set
    'EXEC-DISP-004', // hardware capability not declared
    'EXEC-DISP-005', // vendor-supplied software
    // Before 002, which also matches CERTIFICATE_VALIDATION. 008 is the more
    // specific rule — a node type AND a usage — and it is the only one that
    // raises the PKI recommendation, so letting 002 claim certificates first
    // would silently delete an item the ruleset says it produces.
    'EXEC-DISP-008', // certificate / PKI
    'EXEC-DISP-002', // signature usage — out of scope
    'EXEC-DISP-006', // protocol-managed / unconfirmed peer
    'EXEC-DISP-007', // test or mock code
    'EXEC-DISP-012', // provider capability unestablished — investigate
    'EXEC-DISP-011', // provider predates the target — autonomous upgrade
    'EXEC-DISP-010', // undetermined usage — investigate, never migrate
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
