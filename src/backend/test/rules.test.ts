import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { RuleEngine } from '../src/core/rules/engine';
import {
  classifyAlgorithm,
  classifyFailure,
  resolveDisposition,
  resolveTarget,
} from '../src/core/rules/assess';
import { evaluate } from '../src/core/rules/predicates';
import { REFERENCE_FAILURES, REFERENCE_FINDINGS } from './fixtures/reference-scenario';

const p = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const engine = RuleEngine.fromFiles(
  p('../../../engine/rulesets/pqc-migration-rules.yaml'),
  p('../../../engine/rulesets/migration-execution-rules.yaml'),
);

describe('ruleset loading', () => {
  it('loads both files and enforces the gating discipline at load', () => {
    expect(engine.counts).toEqual({ standards: 40, execution: 74 });
  });

  it('exposes the retry budget from the policy block', () => {
    expect(engine.policy.maxMeaningfulAutonomousAttempts).toBe(4);
  });

  it('declares both subtype taxonomies', () => {
    expect(Object.keys(engine.subtypes).sort()).toEqual([
      'HARDWARE_REPLACEMENT',
      'VENDOR_DECISION',
    ]);
  });
});

describe('predicate evaluation', () => {
  it('matches a regex predicate against its stem fact', () => {
    expect(evaluate({ algorithmMatches: '^RSA($|-)' }, { algorithm: 'RSA-2048' }).matched).toBe(true);
    expect(evaluate({ algorithmMatches: '^RSA($|-)' }, { algorithm: 'AES-256' }).matched).toBe(false);
  });

  it('matches membership predicates', () => {
    expect(evaluate({ usageIn: ['KEY_TRANSPORT'] }, { usage: 'KEY_TRANSPORT' }).matched).toBe(true);
  });

  it('compares dotted versions numerically, not lexically', () => {
    // "1.72" < "1.8" lexically but not numerically — the naive comparison is wrong.
    expect(
      evaluate({ dependencyVersion: { op: 'lt', value: '1.8' } }, { dependencyVersion: '1.72' })
        .matched,
    ).toBe(true);
    expect(
      evaluate({ dependencyVersion: { op: 'lt', value: '1.72' } }, { dependencyVersion: '1.78' })
        .matched,
    ).toBe(false);
  });

  it('never matches on a fact the engine does not hold', () => {
    const r = evaluate({ algorithmMatches: '^RSA' }, {});
    expect(r.matched).toBe(false);
    expect(r.missingFacts).toEqual(['algorithmMatches']);
  });

  it('matches a scalar predicate against a multi-valued fact', () => {
    expect(evaluate({ nodeType: 'HSM' }, { nodeType: ['SERVICE', 'HSM'] }).matched).toBe(true);
  });
});

describe('reference scenario — the assessment the UX renders', () => {
  it.each(REFERENCE_FINDINGS)('$id · $label', (c) => {
    const d = resolveDisposition(engine, c.facts);
    expect(d, `no disposition rule matched ${c.id}`).not.toBeNull();
    expect(d!.disposition).toBe(c.expect.disposition);
    expect(d!.ruleId).toBe(c.expect.dispositionRuleId);

    if (c.expect.recommendation) {
      expect(d!.recommendation?.disposition).toBe(c.expect.recommendation.disposition);
      if (c.expect.recommendation.subtype) {
        expect(d!.recommendation?.subtype).toBe(c.expect.recommendation.subtype);
      }
      expect(d!.recommendation?.suggestedOwner).toBeTruthy();
    }

    if (c.expect.quantumVulnerable !== undefined) {
      const cls = classifyAlgorithm(engine, c.facts);
      if (cls) expect(cls.quantumVulnerable).toBe(c.expect.quantumVulnerable);
    }

    if (c.expect.target) {
      const t = resolveTarget(engine, c.facts);
      expect(t?.target).toBe(c.expect.target);
      if (c.expect.parameterSet) expect(t?.parameterSet).toBe(c.expect.parameterSet);
    }
  });

  it('produces exactly one AUTONOMOUS_MIGRATION disposition per in-scope source finding', () => {
    const autonomous = REFERENCE_FINDINGS.filter(
      (c) => resolveDisposition(engine, c.facts)?.disposition === 'AUTONOMOUS_MIGRATION',
    ).map((c) => c.id);
    expect(autonomous).toEqual(['f1', 'f2']);
  });

  it('raises three recommendations, each with a distinct disposition and an owner', () => {
    const recs = REFERENCE_FINDINGS.map((c) => resolveDisposition(engine, c.facts)?.recommendation)
      .filter(Boolean);
    const dispositions = recs.map((r) => r!.disposition);
    expect(new Set(dispositions).size).toBe(dispositions.length);
    expect(recs.every((r) => Boolean(r!.suggestedOwner))).toBe(true);
  });
});

describe('failure classification is deterministic', () => {
  it.each(REFERENCE_FAILURES)('$label', (c) => {
    const d = classifyFailure(engine, c.facts);
    expect(d, 'no classifier matched — this would fall through to the model').not.toBeNull();
    expect(d!.classification).toBe(c.expect.classification);
    expect(d!.ruleId).toBe(c.expect.ruleId);
    expect(d!.permitAutonomousRepair).toBe(c.expect.permitAutonomousRepair);
    expect(d!.countsTowardRetryBudget).toBe(c.expect.countsTowardRetryBudget);
  });

  it('gives the same classification for the same failure every time', () => {
    // Stability is the whole point: makeProblemKey() consumes this, and a drifting
    // classification silently disables the four-attempt retry budget.
    const facts = REFERENCE_FAILURES[0]!.facts;
    const runs = Array.from({ length: 20 }, () => classifyFailure(engine, facts)?.classification);
    expect(new Set(runs).size).toBe(1);
  });

  it('returns null when nothing matches, rather than guessing', () => {
    expect(classifyFailure(engine, { phase: 'BUILD', error: 'something entirely novel' }))
      .toBeNull();
  });
});

describe('prohibitions', () => {
  it('refuses to replace an algorithm in a signature usage', () => {
    const acts = engine.prohibitedActions({
      algorithm: 'RSA-2048',
      usage: 'DIGITAL_SIGNATURE',
    });
    expect(acts.has('REPLACE_ALGORITHM')).toBe(true);
  });

  it('does not prohibit key generation for an ML-KEM migration', () => {
    // PROHIB-003 once forbade GENERATE_KEY while requiring keys to come from KeyGen.
    const acts = engine.prohibitedActions({ algorithm: 'ML-KEM-768' });
    expect(acts.has('GENERATE_KEY')).toBe(false);
    expect(acts.has('REUSE_EXISTING_KEY_MATERIAL')).toBe(true);
  });

  it('refuses to rewrite protocol-managed cryptography', () => {
    const acts = engine.prohibitedActions({ protocolManaged: true });
    expect(acts.has('MODIFY_SOURCE')).toBe(true);
  });
});
