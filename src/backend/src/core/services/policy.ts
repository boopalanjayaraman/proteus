import type { MigrationPolicy, MigrationPolicyRule } from '@proteus/schema';
import { resolveTarget } from '../rules/assess';
import type { RuleEngine } from '../rules/engine';
import type { Repositories } from '../repositories';

/**
 * What "migrated" means, as data.
 *
 * Derived from the ruleset rather than written by hand, so verification cannot
 * check against a different definition of success from the one the assessment
 * promised. Storing it makes `PROHIBITED_CRYPTO_ABSENT` a grep with a rule id
 * attached — re-runnable, diffable and citable — instead of a model opinion.
 *
 * Seeded once per ruleset version and referenced by every assessment, so the
 * scope a human approved keeps pointing at the policy that was in force.
 */

/** The usages this product migrates. Signature usage has its own timeline (PROHIB-001). */
const MIGRATABLE = ['KEY_TRANSPORT', 'KEY_ESTABLISHMENT'] as const;

/** Algorithm families a KEM migration replaces, as the classification rules name them. */
const CLASSICAL = [
  { pattern: '^RSA', literal: 'RSA' },
  { pattern: '^(ECDH|ECDHE)', literal: 'ECDH' },
  { pattern: '^(DH|DHE)$', literal: 'DH' },
];

export function buildPolicy(engine: RuleEngine, policyId: string): MigrationPolicy {
  const now = new Date();
  const rules: MigrationPolicyRule[] = [];

  for (const usage of MIGRATABLE) {
    for (const family of CLASSICAL) {
      const target = resolveTarget(engine, {
        algorithm: family.literal,
        usage,
        quantumVulnerable: true,
      });
      if (!target) continue;

      const parameterSet = target.parameterSet ?? target.target;
      rules.push({
        ruleId: `${policyId}:${family.literal}:${usage}`,
        when: { algorithmPattern: family.pattern, usage },
        target: parameterSet,
        // What must be gone. Deliberately the API call, not the algorithm name:
        // a comment mentioning RSA is not a migration failure, and a policy that
        // said so would make verification untrustworthy on its first false alarm.
        prohibitedPatterns: [
          `Cipher\\.getInstance\\(\\s*"${family.literal}`,
          `KeyPairGenerator\\.getInstance\\(\\s*"${family.literal}"`,
        ],
        // What must be present. A migration that removes the old call without
        // adding the new one passes an absence check and is still broken.
        requiredPatterns: [parameterSet.replace(/-/g, '[-_]?')],
        rationale:
          `${family.literal} used for ${usage.replace(/_/g, ' ').toLowerCase()} migrates to `
          + `${parameterSet}, established by ${target.ruleIds.join(', ')}.`,
      });
    }
  }

  return {
    _schemaVersion: 1, createdAt: now, updatedAt: now,
    policyId,
    name: 'ML-KEM key establishment migration',
    description:
      'Derived from the standards ruleset. Verification checks the migrated tree against '
      + 'these patterns; the assessment promises exactly this definition of success.',
    rules,
  };
}

/** Seeds the policy if absent and returns its id. Idempotent. */
export async function ensurePolicy(
  repos: Repositories,
  engine: RuleEngine,
  policyId = 'policy_mlkem_v1',
): Promise<string> {
  const existing = await repos.migrationPolicies.findOne({ policyId } as never);
  if (existing) return policyId;
  await repos.migrationPolicies.insert(buildPolicy(engine, policyId));
  return policyId;
}
