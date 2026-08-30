import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { WorkingCopy } from '../src/core/discovery/workingCopy';
import { apiSurfaceOf } from '../src/core/migration/apiSurface';
import {
  PROBE_SUITE, probeShapeOf, probeSource,
} from '../src/core/migration/roundTripProbe';

/**
 * The probe exists because `REQUIRED_PQC_PRESENT` was satisfiable by a suite
 * name. A run produced a `wrapSessionKey` that discarded its argument, plus an
 * acceptance test asserting the algorithm string, the key type string and the
 * ciphertext length. All three passed; the suite matched `/kem/i`; verification
 * reported "round trip executed; shared secrets match".
 */

const FIXTURE = fileURLToPath(new URL('../../../fixtures/payments-api', import.meta.url));

describe('the round trip is established by our test, not a name match', () => {
  it('derives the wrap/unwrap pair from the repository, with no model involved', async () => {
    const shape = probeShapeOf(await apiSurfaceOf(new WorkingCopy(FIXTURE)));
    expect(shape).not.toBeNull();
    expect(shape!.transportClass).toBe('pay.security.CryptoService');
    expect(shape!.wrapMethod).toBe('wrapSessionKey');
    expect(shape!.unwrapMethod).toBe('unwrapSessionKey');
    expect(shape!.providerClass).toBe('pay.security.PartnerKeyProvider');
    expect(shape!.publicKeyMethod).toBe('acquirerPublicKey');
    expect(shape!.privateKeyMethod).toBe('acquirerPrivateKey');
  });

  it('asserts the key that comes back is the key that went in', async () => {
    const shape = probeShapeOf(await apiSurfaceOf(new WorkingCopy(FIXTURE)))!;
    const src = probeSource(shape, 'ML-KEM-768');

    // The assertion no algorithm string, key type or ciphertext length can
    // stand in for. Without it a wrap that ignores its argument passes.
    expect(src).toContain('assertArrayEquals(');
    expect(src).toContain('sessionKey.getEncoded(), recovered.getEncoded()');
    expect(src).toContain('the session key the peer recovered is not the one that was sent');

    // And it must fail on the unmigrated build, or EXEC-TEST-002 calls it vacuous.
    expect(src).toContain('ML-KEM');
    expect(src).toContain('getAlgorithm()');
  });

  it('names the suite verification looks for, so the two cannot drift apart', async () => {
    const shape = probeShapeOf(await apiSurfaceOf(new WorkingCopy(FIXTURE)))!;
    const src = probeSource(shape, 'ML-KEM-768');
    const simple = PROBE_SUITE.split('.').pop();
    expect(src).toContain(`class ${simple} {`);
    expect(src).toContain(`package ${PROBE_SUITE.split('.').slice(0, -1).join('.')};`);
  });

  it('returns null rather than guessing when the repository has no such shape', () => {
    expect(probeShapeOf([])).toBeNull();
    expect(probeShapeOf([
      { className: 'pay.Thing', path: 'a.java', members: ['String name()'] },
    ])).toBeNull();
    // A transport class with no key provider beside it establishes nothing.
    expect(probeShapeOf([
      { className: 'pay.T', path: 'a.java', members: [
        'byte[] wrap(SecretKey k, PublicKey p)', 'SecretKey unwrap(byte[] b, PrivateKey q)',
      ] },
    ])).toBeNull();
  });
});
