import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import {
  ExecutionRuleset,
  StandardsRuleset,
  type ExecutionRule,
  type StandardsRule,
} from '@proteus/schema';

/**
 * Loads and validates the rule files.
 *
 * Validation happens here rather than at first use, so a malformed or
 * discipline-violating rule is a startup failure with a path — not a rule that
 * quietly never matches. The Zod refinements in @proteus/schema enforce the gating
 * discipline (no ENGINEERING rule gates, no INFERRED rule gates, STANDARDS_DERIVED
 * must name its source), so those cannot be bypassed by editing YAML.
 */

export interface LoadedRulesets {
  standards: StandardsRule[];
  execution: ExecutionRule[];
  subtypes: Record<string, string[]>;
  policy: {
    maxMeaningfulAutonomousAttempts: number;
    autonomyBoundary: string;
    originalBranch: string;
    productionAccess: string;
  };
}

export class RulesetLoadError extends Error {}

function readYaml(path: string): unknown {
  try {
    return parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new RulesetLoadError(`could not read ${path}: ${(e as Error).message}`);
  }
}

export function loadRulesets(standardsPath: string, executionPath: string): LoadedRulesets {
  const s = StandardsRuleset.safeParse(readYaml(standardsPath));
  if (!s.success) {
    throw new RulesetLoadError(
      `${standardsPath} failed validation:\n` +
        s.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n'),
    );
  }
  const e = ExecutionRuleset.safeParse(readYaml(executionPath));
  if (!e.success) {
    throw new RulesetLoadError(
      `${executionPath} failed validation:\n` +
        e.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n'),
    );
  }

  // Cross-file integrity: a STANDARDS_DERIVED rule that names a rule which does not
  // exist is asserting something the standards do not establish.
  const known = new Set(s.data.rules.map((r) => r.ruleId));
  const dangling = e.data.rules.flatMap((r) =>
    r.derivedFrom.filter((d) => !known.has(d)).map((d) => `${r.ruleId} -> ${d}`),
  );
  if (dangling.length) {
    throw new RulesetLoadError(`derivedFrom does not resolve:\n  ${dangling.join('\n  ')}`);
  }

  // Every subtype used must be declared in the taxonomy.
  const declared = new Set(Object.values(e.data.subtypes).flat());
  const undeclared = e.data.rules
    .map((r) => [r.ruleId, r.then?.['subtype']] as const)
    .filter(([, st]) => typeof st === 'string' && !declared.has(st))
    .map(([id, st]) => `${id}: ${String(st)}`);
  if (undeclared.length) {
    throw new RulesetLoadError(`undeclared subtypes:\n  ${undeclared.join('\n  ')}`);
  }

  return {
    standards: s.data.rules,
    execution: e.data.rules,
    subtypes: e.data.subtypes,
    policy: e.data.policy,
  };
}
