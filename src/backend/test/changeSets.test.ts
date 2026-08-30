import { describe, expect, it } from 'vitest';
import type { Finding, PlanItem } from '@proteus/schema';
import { changeSetsOf } from '../src/core/migration/changeSets';

/**
 * The grouping that stops the loop asking an impossible question.
 *
 * `payments-api` is the case these are written against: four files, one
 * primitive, and no order in which the suite is green after each single file.
 */

const item = (over: Partial<PlanItem> = {}): PlanItem => ({
  planItemId: 'plan_1', targetName: 'CryptoService', targetNodeIds: [], findingIds: ['fnd_1'],
  mode: 'AUTONOMOUS_MIGRATION',
  action: 'Replace RSA key transport with ML-KEM-768',
  rationale: 'CNSA 2.0',
  expectedChanges: [{ changeType: 'SOURCE', paths: ['a.java'], description: 'swap' }],
  conditions: [], risk: 'MEDIUM', order: 0,
  ...over,
});

const finding = (id: string, usage: string): Finding => ({
  findingId: id,
  crypto: { usage },
} as unknown as Finding);

const ids = (sets: PlanItem[][]) => sets.map((s) => s.map((i) => i.planItemId));

describe('a primitive swap is one change, however many files', () => {
  it('groups every key-transport item into a single set', () => {
    const items = [
      item({ planItemId: 'p1', findingIds: ['f1'], order: 0 }),
      item({ planItemId: 'p2', findingIds: ['f2'], order: 1 }),
      item({ planItemId: 'p3', findingIds: ['f3'], order: 2 }),
      item({ planItemId: 'p4', findingIds: ['f4'], order: 3 }),
    ];
    const findings = [
      finding('f1', 'KEY_TRANSPORT'), finding('f2', 'KEY_TRANSPORT'),
      finding('f3', 'KEY_TRANSPORT'), finding('f4', 'KEY_TRANSPORT'),
    ];
    expect(ids(changeSetsOf(items, findings))).toEqual([['p1', 'p2', 'p3', 'p4']]);
  });

  it('keeps an unrelated usage in its own set', () => {
    const items = [
      item({ planItemId: 'p1', findingIds: ['f1'], order: 0 }),
      item({ planItemId: 'p2', findingIds: ['f2'], order: 1 }),
    ];
    const findings = [
      finding('f1', 'KEY_TRANSPORT'),
      finding('f2', 'HASHING'),
    ];
    expect(ids(changeSetsOf(items, findings))).toEqual([['p1'], ['p2']]);
  });

  it('joins key establishment to key transport through a shared item', () => {
    const items = [
      item({ planItemId: 'p1', findingIds: ['f1'], order: 0 }),
      item({ planItemId: 'p2', findingIds: ['f1', 'f2'], order: 1 }),
      item({ planItemId: 'p3', findingIds: ['f2'], order: 2 }),
    ];
    const findings = [
      finding('f1', 'KEY_TRANSPORT'),
      finding('f2', 'KEY_ESTABLISHMENT'),
    ];
    expect(ids(changeSetsOf(items, findings))).toEqual([['p1', 'p2', 'p3']]);
  });

  it('never groups an item the plan does not authorise it to change', () => {
    const items = [
      item({ planItemId: 'p1', findingIds: ['f1'], order: 0 }),
      item({ planItemId: 'p2', findingIds: ['f2'], order: 1, mode: 'NO_AUTONOMOUS_CHANGE' }),
    ];
    const findings = [
      finding('f1', 'KEY_TRANSPORT'), finding('f2', 'KEY_TRANSPORT'),
    ];
    expect(ids(changeSetsOf(items, findings))).toEqual([['p1'], ['p2']]);
  });

  it('preserves the plan ordering across and within sets', () => {
    const items = [
      item({ planItemId: 'late', findingIds: ['f2'], order: 9 }),
      item({ planItemId: 'early', findingIds: ['f1'], order: 1 }),
    ];
    const findings = [finding('f1', 'HASHING'), finding('f2', 'MAC')];
    expect(ids(changeSetsOf(items, findings))).toEqual([['early'], ['late']]);
  });

  it('leaves a finding it has never heard of ungrouped rather than guessing', () => {
    const items = [
      item({ planItemId: 'p1', findingIds: ['missing'], order: 0 }),
      item({ planItemId: 'p2', findingIds: ['f2'], order: 1 }),
    ];
    const findings = [finding('f2', 'KEY_TRANSPORT')];
    expect(ids(changeSetsOf(items, findings))).toEqual([['p1'], ['p2']]);
  });
});
