import type { CryptoUsage, Finding, PlanItem } from '@proteus/schema';

/**
 * Which approved plan items have to land together.
 *
 * The loop applies one plan item, builds, and treats a failing suite as a
 * defect to be diagnosed and repaired. That is right for an item that stands on
 * its own and wrong for a cryptographic primitive swap, because a primitive
 * cannot be half-replaced across a call graph and still produce a green suite.
 *
 * `payments-api` is the case in miniature. `PartnerKeyProvider` generates the
 * acquirer key pair; `CryptoService.wrapSessionKey` and `CryptoUtils.wrapKey`
 * both wrap under it. Migrate the provider to ML-KEM first and the two wrappers
 * are handed a key type their RSA transform rejects. Migrate a wrapper first and
 * it is handed an RSA key its KEM cannot use. There is **no order** in which the
 * suite is green after each single file — the four changes are one change.
 *
 * Judged item by item, every one of those intermediate states looks like a
 * defect. The repair agent is then asked to make a correct-in-progress build
 * green with the rest of the change set still unapplied, and the only edit that
 * does that is undoing the migration. That is where the RSA fallbacks came from:
 * not a confused model, but a loop asking an impossible question.
 *
 * So the grouping is by usage, and it is deliberately coarse. Two unrelated
 * key-transport systems in one repository would be grouped together and their
 * failures attributed a little later than they might be. Nothing is admitted
 * that would otherwise be caught — the group's final build still has to pass —
 * and the alternative error is the expensive one.
 *
 * The sharper version is per-key-material, which is what the unused
 * `REQUIRES_MIGRATION_WITH` relationship in the schema is for. That needs the
 * graph to carry which findings share a key, and it is a strictly narrower
 * grouping than this one, so it can replace this without changing the contract.
 */

/** Usages where every site moves at once or none of them works. */
const ATOMIC_USAGES = new Set<CryptoUsage>(['KEY_TRANSPORT', 'KEY_ESTABLISHMENT']);

export function changeSetsOf(items: PlanItem[], findings: Finding[]): PlanItem[][] {
  const usageOf = new Map(
    findings.map((f) => [f.findingId, f.crypto?.usage]),
  );

  const ordered = [...items].sort((a, b) => a.order - b.order);

  /** The atomic usages one item touches. */
  const atomicUsages = (item: PlanItem): CryptoUsage[] => {
    if (item.mode !== 'AUTONOMOUS_MIGRATION') return [];
    return [...new Set(
      item.findingIds
        .map((id) => usageOf.get(id))
        .filter((u): u is CryptoUsage => u !== undefined && ATOMIC_USAGES.has(u)),
    )];
  };

  // Union-find over item indices, joined through the usages they share.
  const parent = ordered.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const union = (a: number, b: number): void => { parent[find(a)] = find(b); };

  const firstWithUsage = new Map<CryptoUsage, number>();
  ordered.forEach((item, i) => {
    for (const usage of atomicUsages(item)) {
      const seen = firstWithUsage.get(usage);
      if (seen === undefined) firstWithUsage.set(usage, i);
      else union(i, seen);
    }
  });

  // Emit groups in the order their first item appears, so the plan's own
  // ordering still decides what is attempted first.
  const groups = new Map<number, PlanItem[]>();
  ordered.forEach((item, i) => {
    const root = find(i);
    const existing = groups.get(root);
    if (existing) existing.push(item);
    else groups.set(root, [item]);
  });

  return [...groups.values()];
}
