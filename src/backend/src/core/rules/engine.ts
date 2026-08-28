import {
  isExecutionRule,
  type AnyRule,
  type ExecutionFamily,
  type ExecutionRule,
  type StandardsFamily,
  type StandardsRule,
} from '@proteus/schema';
import { evaluate, type Facts, type MatchResult } from './predicates';
import { assertPrecedenceCoverage, byPrecedence } from './precedence';
import { loadRulesets, type LoadedRulesets } from './loader';

/**
 * The deterministic rule engine.
 *
 * Nothing here calls a model. Discovery, assessment, diagnosis and verification all
 * consult this; the agents supply judgment only where no rule matches.
 */

export interface RuleMatch<R extends AnyRule = AnyRule> {
  rule: R;
  /** The rule's `then` block — the outcome the caller applies. */
  outcome: Record<string, unknown>;
  gating: boolean;
}

export interface Explanation {
  ruleId: string;
  matched: boolean;
  failedOn: string[];
  missingFacts: string[];
}

export class RuleEngine {
  private readonly byStandardsFamily = new Map<string, StandardsRule[]>();
  private readonly byExecutionFamily = new Map<string, ExecutionRule[]>();

  private constructor(private readonly loaded: LoadedRulesets) {
    for (const r of loaded.standards) {
      const list = this.byStandardsFamily.get(r.family) ?? [];
      list.push(r);
      this.byStandardsFamily.set(r.family, list);
    }
    for (const r of loaded.execution) {
      const list = this.byExecutionFamily.get(r.family) ?? [];
      list.push(r);
      this.byExecutionFamily.set(r.family, list);
    }
    // A rule joining an ordered family without a precedence decision is a startup error.
    assertPrecedenceCoverage(this.byExecutionFamily);
  }

  static fromFiles(standardsPath: string, executionPath: string): RuleEngine {
    return new RuleEngine(loadRulesets(standardsPath, executionPath));
  }

  static fromLoaded(loaded: LoadedRulesets): RuleEngine {
    return new RuleEngine(loaded);
  }

  get policy() {
    return this.loaded.policy;
  }
  get subtypes() {
    return this.loaded.subtypes;
  }

  /** All matching rules in a standards family, file order. */
  matchStandards(family: StandardsFamily, facts: Facts): RuleMatch<StandardsRule>[] {
    return (this.byStandardsFamily.get(family) ?? [])
      .filter((r) => r.machineEvaluable && evaluate(r.when, facts).matched)
      .map((rule) => ({ rule, outcome: rule.then, gating: rule.gating }));
  }

  /** All matching rules in an execution family, ordered by precedence. */
  matchExecution(family: ExecutionFamily, facts: Facts): RuleMatch<ExecutionRule>[] {
    const matched = (this.byExecutionFamily.get(family) ?? []).filter(
      (r) => evaluate(r.when, facts).matched,
    );
    return byPrecedence(matched).map((rule) => ({
      rule,
      outcome: rule.then,
      gating: rule.gating,
    }));
  }

  /** Highest-precedence match, or null. */
  firstExecution(family: ExecutionFamily, facts: Facts): RuleMatch<ExecutionRule> | null {
    return this.matchExecution(family, facts)[0] ?? null;
  }

  /**
   * Union of prohibited actions across every rule that matches, in either file.
   * A prohibition anywhere wins — the engine must always be able to refuse.
   */
  prohibitedActions(facts: Facts): Set<string> {
    const out = new Set<string>();
    const all: AnyRule[] = [...this.loaded.standards, ...this.loaded.execution];
    for (const r of all) {
      // `machineEvaluable: false` means compliance cannot be VERIFIED statically — not
      // that the condition cannot be MATCHED. For a prohibition those come apart, and
      // erring toward refusing is the safe direction: a rail that declines to fire
      // because verification is hard is not a rail.
      const isProhibition = !isExecutionRule(r) && r.family === 'PROHIBITION';
      if (isExecutionRule(r) || r.machineEvaluable || isProhibition) {
        if (evaluate(r.when, facts).matched) r.prohibitedActions.forEach((a) => out.add(a));
      }
    }
    return out;
  }

  /** Why each rule in a family did or did not fire — for the audit trail. */
  explain(family: string, facts: Facts): Explanation[] {
    const rules: AnyRule[] = [
      ...(this.byStandardsFamily.get(family) ?? []),
      ...(this.byExecutionFamily.get(family) ?? []),
    ];
    return rules.map((r) => {
      const m: MatchResult = evaluate(r.when, facts);
      return {
        ruleId: r.ruleId,
        matched: m.matched,
        failedOn: m.failedOn,
        missingFacts: m.missingFacts,
      };
    });
  }

  ruleById(id: string): AnyRule | undefined {
    return (
      this.loaded.standards.find((r) => r.ruleId === id) ??
      this.loaded.execution.find((r) => r.ruleId === id)
    );
  }

  get counts() {
    return { standards: this.loaded.standards.length, execution: this.loaded.execution.length };
  }
}
