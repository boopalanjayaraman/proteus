import { describe, expect, it } from 'vitest';
import { BehavioralInvariant } from '@proteus/schema';

/**
 * Decision D-003. The baseline observes two different kinds of thing, and giving
 * them one verdict either fails a correct migration or hides a material change.
 *
 * The reference scenario is the reason: RSA-2048 wraps a session key to 256 bytes,
 * ML-KEM-768 produces 1088. The fixture asserts `assertEquals(256, wrapped.length)`.
 * If that is treated as must-hold, verification raises a BASELINE_CONTRACT_CHANGE
 * gate and the run ends with one human engineering action instead of zero.
 */

const base = {
  invariantId: 'inv_1',
  assertion: 'PartnerHandshakeIntegrationTest#transportsASessionKeyToTheAcquirer',
  capturedFrom: 'EXISTING_TEST' as const,
  evidenceIds: [],
};

describe('a baseline invariant carries a disposition', () => {
  it('records behaviour the migration must preserve', () => {
    const r = BehavioralInvariant.safeParse({
      ...base,
      kind: 'API_BEHAVIOR',
      description: 'POST /settlements returns 201 for a valid advice',
      disposition: 'MUST_PRESERVE',
    });
    expect(r.success).toBe(true);
  });

  it('records behaviour the migration is expected to change', () => {
    const r = BehavioralInvariant.safeParse({
      ...base,
      kind: 'MESSAGE_FORMAT',
      description: 'wrapped session key is 256 bytes on the wire',
      disposition: 'EXPECTED_TO_CHANGE',
      observedAfter: 'wrapped session key is 1088 bytes on the wire',
    });
    expect(r.success).toBe(true);
    expect(r.data?.disposition).toBe('EXPECTED_TO_CHANGE');
  });

  it('requires a disposition — it cannot be left implicit', () => {
    const { disposition, ...withoutDisposition } = {
      ...base,
      kind: 'MESSAGE_FORMAT',
      description: 'wrapped session key is 256 bytes on the wire',
      disposition: 'MUST_PRESERVE',
    };
    expect(BehavioralInvariant.safeParse(withoutDisposition).success).toBe(false);
  });

  it('no longer accepts the mustHold field that forced every observation to be preserved', () => {
    const r = BehavioralInvariant.safeParse({
      ...base,
      kind: 'MESSAGE_FORMAT',
      description: 'wrapped session key is 256 bytes on the wire',
      mustHold: true,
    });
    expect(r.success).toBe(false);
  });
});

describe('only MUST_PRESERVE invariants gate verification', () => {
  // EXEC-VER-005: assert the preserve set, report the change set.
  const assertable = (i: { disposition: string }) => i.disposition === 'MUST_PRESERVE';

  const baseline = [
    { description: 'POST /settlements returns 201', disposition: 'MUST_PRESERVE' },
    { description: 'malformed peer key rejected with 400', disposition: 'MUST_PRESERVE' },
    { description: 'key establishment succeeds for a valid peer', disposition: 'MUST_PRESERVE' },
    { description: 'wrapped session key is 256 bytes', disposition: 'EXPECTED_TO_CHANGE' },
  ];

  it('asserts three and reports one, for the reference scenario', () => {
    expect(baseline.filter(assertable)).toHaveLength(3);
    expect(baseline.filter((i) => !assertable(i))).toHaveLength(1);
  });

  it('a changed wire format does not fail verification', () => {
    // The whole point: this is the migration working, not a regression.
    const wireFormat = baseline.find((i) => i.description.includes('256 bytes'))!;
    expect(assertable(wireFormat)).toBe(false);
  });
});
