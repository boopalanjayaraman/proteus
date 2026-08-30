import type { ApiMember } from './apiSurface';

/**
 * The round-trip probe: Proteus's own test, not the agent's.
 *
 * `REQUIRED_PQC_PRESENT` is the claim the product exists to make — that the
 * migrated code really performs post-quantum key establishment. It was
 * established by `establishRoundTrip` filtering the test inventory with
 * `/kem|encaps|decaps|roundtrip|sharedsecret/i` and requiring the matches to
 * pass. That is a match on a **name**, and the name is chosen by the agent whose
 * work is being judged.
 *
 * It failed exactly as you would expect. One run produced:
 *
 *     public byte[] wrapSessionKey(SecretKey sessionKey, PublicKey peer) {
 *         ...
 *         return sent.getEncapsulation();     // sessionKey is never used
 *     }
 *
 * — the caller's session key silently discarded — together with a
 * `MlKemMigrationAcceptanceTest` asserting the algorithm *string*, the key-type
 * *string*, and the ciphertext *length*. All three passed. The suite name
 * matched `kem`. Verification duly reported "round trip executed; shared secrets
 * match" about code that transports nothing.
 *
 * `SETTLEMENT_SCENARIOS` already states the principle for the E2E suite: named
 * here rather than generated, "because a model-authored end-to-end suite would
 * be judging the migration against criteria the migration's author chose". The
 * same reasoning applies to the round trip and had not been applied.
 *
 * So this test is generated mechanically from the repository's own API surface —
 * no model involved — and it asserts the one thing the others could not:
 * a key put in comes back out.
 */

export const PROBE_PATH = 'src/test/java/pay/ProteusKeyTransportRoundTripTest.java';
export const PROBE_SUITE = 'pay.ProteusKeyTransportRoundTripTest';

export interface ProbeShape {
  /** e.g. `pay.security.CryptoService` */
  transportClass: string;
  wrapMethod: string;
  unwrapMethod: string;
  /** e.g. `pay.security.PartnerKeyProvider` */
  providerClass: string;
  publicKeyMethod: string;
  privateKeyMethod: string;
}

const simple = (fq: string): string => fq.split('.').pop() ?? fq;

/** `byte[] wrapSessionKey(SecretKey sessionKey, PublicKey peer)` → the name. */
const WRAP = /^byte\[\]\s+(\w+)\s*\(\s*[\w.]*SecretKey\s+\w+\s*,\s*[\w.]*PublicKey\s+\w+\s*\)/;
const UNWRAP = /^[\w.]*SecretKey\s+(\w+)\s*\(\s*byte\[\]\s+\w+\s*,\s*[\w.]*PrivateKey\s+\w+\s*\)/;
const PUBLIC_KEY = /^[\w.]*PublicKey\s+(\w+)\s*\(\s*\)/;
const PRIVATE_KEY = /^[\w.]*PrivateKey\s+(\w+)\s*\(\s*\)/;

/**
 * Finds the wrap/unwrap pair and the key provider, from signatures alone.
 *
 * Returns null when the repository has no such shape rather than guessing. A
 * probe that cannot be built is reported as "not established", which is the
 * honest answer — the alternative is the one this module exists to prevent.
 */
export function probeShapeOf(surface: ApiMember[]): ProbeShape | null {
  let transport: { cls: string; wrap: string; unwrap: string } | null = null;
  for (const c of surface) {
    const wrap = c.members.map((m) => WRAP.exec(m)?.[1]).find(Boolean);
    const unwrap = c.members.map((m) => UNWRAP.exec(m)?.[1]).find(Boolean);
    if (wrap && unwrap) { transport = { cls: c.className, wrap, unwrap }; break; }
  }
  if (!transport) return null;

  let provider: { cls: string; pub: string; priv: string } | null = null;
  for (const c of surface) {
    if (c.className === transport.cls) continue;
    const pub = c.members.map((m) => PUBLIC_KEY.exec(m)?.[1]).find(Boolean);
    const priv = c.members.map((m) => PRIVATE_KEY.exec(m)?.[1]).find(Boolean);
    if (pub && priv) { provider = { cls: c.className, pub, priv }; break; }
  }
  if (!provider) return null;

  return {
    transportClass: transport.cls,
    wrapMethod: transport.wrap,
    unwrapMethod: transport.unwrap,
    providerClass: provider.cls,
    publicKeyMethod: provider.pub,
    privateKeyMethod: provider.priv,
  };
}

/**
 * The test source.
 *
 * Two assertions, and the second is the point:
 *
 *   1. the peer key names the approved algorithm — so this fails on the
 *      unmigrated build and is not vacuous under `EXEC-TEST-002`;
 *   2. a session key wrapped for the peer is recovered byte-for-byte — which no
 *      assertion about an algorithm string, a key type or a ciphertext length
 *      can stand in for.
 */
export function probeSource(shape: ProbeShape, target: string): string {
  const t = simple(shape.transportClass);
  const p = simple(shape.providerClass);
  const algorithm = target.split('-').slice(0, 2).join('-'); // ML-KEM-768 → ML-KEM

  return `package pay;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import javax.crypto.SecretKey;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import ${shape.transportClass};
import ${shape.providerClass};

/**
 * Written by Proteus, not by the migration agent.
 *
 * Every other check of the key establishment can be satisfied without the
 * primitive working: an algorithm identifier is a string, a key type is a
 * string, and a ciphertext length is an integer. This asserts the property they
 * stand in for — a session key handed to ${shape.wrapMethod} is the session key
 * ${shape.unwrapMethod} gives back.
 */
@SpringBootTest
class ProteusKeyTransportRoundTripTest {

    @Autowired ${t} transport;
    @Autowired ${p} keys;

    @Test
    void peerKeyUsesTheApprovedAlgorithm() {
        assertNotNull(keys.${shape.publicKeyMethod}(), "no peer public key");
        assertTrue(
                keys.${shape.publicKeyMethod}().getAlgorithm().toUpperCase().contains("${algorithm}"),
                "expected ${target}, found " + keys.${shape.publicKeyMethod}().getAlgorithm());
    }

    @Test
    void sessionKeyEncapsulatesAndDecapsulatesToTheSameSecret() throws Exception {
        SecretKey sessionKey = transport.newSessionKey();
        assertNotNull(sessionKey, "no session key was generated");

        byte[] onTheWire = transport.${shape.wrapMethod}(sessionKey, keys.${shape.publicKeyMethod}());
        assertNotNull(onTheWire, "nothing was placed on the wire");

        SecretKey recovered = transport.${shape.unwrapMethod}(onTheWire, keys.${shape.privateKeyMethod}());
        assertNotNull(recovered, "the peer recovered nothing");

        // The assertion the generated suites could not make. A wrap that
        // discards its argument passes every other check and fails this one.
        assertArrayEquals(
                sessionKey.getEncoded(), recovered.getEncoded(),
                "the session key the peer recovered is not the one that was sent");
    }
}
`;
}
