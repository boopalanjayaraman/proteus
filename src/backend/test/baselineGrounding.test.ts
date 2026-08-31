import { describe, expect, it } from 'vitest';
import { guardTestArtifact } from '../src/core/migration/testGuard';

/**
 * The failure these cover was not a bug in any one function.
 *
 * `captureInvariants` was asked what behaviour the migration must not break,
 * and given test *counts* and suite *names* — no test source. There was no
 * truthful answer available, so the model produced a plausible one: it invented
 * `decapsulateSecret` and `getEncapsulationKeyBytes`, referenced a
 * `SettlementService` absent from the repository, and reported `POST
 * /settlements` as returning 200 where it returns 201. Shown the approved
 * ML-KEM target, it also asserted 1088-byte ciphertexts about an RSA codebase.
 *
 * `generateTests` was then told not to weaken that contract, and wrote
 * characterization tests implementing it at the conventional paths — which is
 * where the real tests already lived. They failed on the base commit, were
 * withdrawn, and the withdrawal deleted the repository's own suite with them.
 */

const artifact = (path: string) => ({
  path,
  changeType: 'TEST' as const,
  testKind: 'CHARACTERIZATION' as const,
  content: 'package pay;\nclass X { @Test void t() { assertTrue(true); } }\n',
  testIntegrity: {
    failureClassification: 'MOCK_INCOMPATIBILITY' as const,
    reason: 'r', baselineRequirementChanged: false, safeAutonomousModification: true,
  },
});

describe('a generated test may not replace one that already passes', () => {
  const baseline = [
    'src/test/java/pay/security/KeyTransportServiceTest.java',
    'src/test/java/pay/SettlementControllerTest.java',
  ];

  it('refuses the exact collision that destroyed the baseline suite', () => {
    const verdict = guardTestArtifact(
      artifact('src/test/java/pay/security/KeyTransportServiceTest.java'),
      { baselineTestPaths: baseline },
    );
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) return;
    expect(verdict.refusals.map((r) => r.ruleId)).toContain('EXEC-TEST-009');
    expect(verdict.refusals.find((r) => r.ruleId === 'EXEC-TEST-009')!.reason)
      .toContain('already passes on the base commit');
  });

  it('allows a new file beside it', () => {
    const verdict = guardTestArtifact(
      artifact('src/test/java/pay/security/KeyTransportCharacterizationTest.java'),
      { baselineTestPaths: baseline },
    );
    expect(verdict.allowed).toBe(true);
  });

  it('is inert when no baseline paths are supplied, rather than refusing everything', () => {
    expect(guardTestArtifact(artifact('src/test/java/pay/AnyTest.java'), {}).allowed).toBe(true);
  });
});

describe('withdrawing an overwrite restores rather than deletes', () => {
  it('puts back the base version, and deletes only what the agent created', async () => {
    const { makeTestRepo } = await import('./helpers/repo');
    const { GitWriter } = await import('../src/integrations/github/writer');
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { existsSync } = await import('node:fs');

    const repo = await makeTestRepo();
    try {
      // Committed at the base commit by the helper — the repository's own test.
      const existing = 'src/test/java/pay/security/SettlementSignerTest.java';
      const invented = 'src/test/java/pay/security/MadeUpTest.java';
      const base = repo.baseCommitSha;
      const original = await readFile(join(repo.dir, existing), 'utf8');

      const git = new GitWriter(repo.dir, 'agent/pqc/PQC-0001');
      await git.createBranch(base);

      // Exactly what happened: the agent writes over one file and creates another.
      await git.writeFile(existing, 'package pay.security;\n// the agent\'s version\n');
      await git.writeFile(invented, 'package pay.security;\nclass MadeUpTest {}\n');
      await git.commit('test(pqc): generated', [existing, invented]);

      expect(await git.restoreFromBase(existing, base)).toBe(true);
      expect(await git.restoreFromBase(invented, base)).toBe(false);
      await git.removeFile(invented);

      // The repository's own test is back, byte for byte.
      expect(await readFile(join(repo.dir, existing), 'utf8')).toBe(original);
      // And the invented one is gone.
      expect(existsSync(join(repo.dir, invented))).toBe(false);
    } finally {
      await repo.dispose();
    }
  }, 30_000);
});

describe('an acceptance test is not a regression', () => {
  /**
   * `ProteusKeyTransportRoundTripTest` asserts the peer key names ML-KEM. That
   * is false until the migration lands — deliberately, or `EXEC-TEST-002` would
   * call it vacuous. A run that had upgraded the provider but not yet migrated
   * the transport was marked FAILED for `expected ML-KEM-768, found RSA`, which
   * was simply the truth at that moment.
   */
  it('separates suites asserting the destination from those guarding the baseline', async () => {
    const { suiteOf } = await import('../src/worker/migrationJob');

    const kinds = new Map<string, string>([
      ['src/test/java/pay/ProteusKeyTransportRoundTripTest.java', 'MIGRATION_ACCEPTANCE_TEST'],
      ['src/test/java/pay/security/KeyTransportServiceTest.java', 'CHARACTERIZATION'],
    ]);
    const acceptance = [...kinds.entries()]
      .filter(([, k]) => k === 'MIGRATION_ACCEPTANCE_TEST')
      .map(([p]) => suiteOf(p));

    expect(acceptance).toEqual(['pay.ProteusKeyTransportRoundTripTest']);
    // The baseline suite stays in the regression surface, where a failure is real.
    expect(acceptance).not.toContain('pay.security.KeyTransportServiceTest');
  });

  it('maps a nested test path to the suite name surefire reports', async () => {
    const { suiteOf } = await import('../src/worker/migrationJob');
    expect(suiteOf('src/test/java/pay/security/KeyTransportServiceTest.java'))
      .toBe('pay.security.KeyTransportServiceTest');
  });
});

describe('the approved scope is a contract, and the glob has to read it correctly', () => {
  /**
   * `**\/pom.xml` compiled to `^.*\/pom\.xml$` — a pattern requiring a slash, so
   * it matched `a/pom.xml` and never the root `pom.xml`.
   *
   * A deployed run was lost to it. The assessment declared `**\/pom.xml` for the
   * Bouncy Castle upgrade, the agent edited the root `pom.xml`, and a change
   * squarely inside the approved scope was refused as a breach. That opened a
   * blocking gate, `NO_CRITICAL_BLOCKER` failed, and a correct migration was
   * reported unverified. The same plan phrased as a bare `pom.xml` had succeeded
   * an hour earlier, which is exactly what made it look environmental.
   */
  const item = { targetName: 'Dependency Upgrade' } as never;

  it('matches the root file, which is the case that cost a run', async () => {
    const { assertWithinScope } = await import('../src/worker/migrationLoop');
    expect(() => assertWithinScope(['pom.xml'], ['**/pom.xml'], item)).not.toThrow();
  });

  it('still matches at any depth', async () => {
    const { assertWithinScope } = await import('../src/worker/migrationLoop');
    expect(() => assertWithinScope(
      ['a/pom.xml', 'a/b/pom.xml'], ['**/pom.xml'], item)).not.toThrow();
    expect(() => assertWithinScope(
      ['src/main/java/pay/security/PartnerKeys.java'],
      ['**/PartnerKeys.java'], item)).not.toThrow();
  });

  it('has not become permissive — a single star stops at the boundary', async () => {
    const { assertWithinScope, PatchRefused } = await import('../src/worker/migrationLoop');
    expect(() => assertWithinScope(
      ['src/main/java/pay/security/x/Foo.java'],
      ['src/main/java/pay/security/*.java'], item)).toThrow(PatchRefused);
    // And a literal path is still literal.
    expect(() => assertWithinScope(['other/pom.xml'], ['pom.xml'], item)).toThrow(PatchRefused);
    // The suffix still has to match.
    expect(() => assertWithinScope(['pom.xml.bak'], ['**/pom.xml'], item)).toThrow(PatchRefused);
  });
});

describe('the loop and the verifier read the approved scope the same way', () => {
  /**
   * They had separate copies of `toPattern`. The zero-directory `**\/` case was
   * fixed in the loop's and not the verifier's, so PQC-0030 passed the loop's
   * scope check, migrated correctly, went green on all 40 tests — and was then
   * failed by `MIGRATION_POLICY_SATISFIED` for "3 file(s) changed outside the
   * approved scope", naming the three files the plan had explicitly authorised.
   *
   * The plan declared `src/main/java/pay/security/**\/*.java`; the flagged files
   * were exactly those with no directory between the `**` and the filename.
   */
  it('is the same function, not two that agree today', async () => {
    const loop = await import('../src/core/migration/glob');
    const verifier = await import('../src/verification/checks/scope');
    expect(verifier.toPattern).toBe(loop.toPattern);
  });

  it('matches a file sitting directly under the ** — the case that failed', async () => {
    const { toPattern } = await import('../src/core/migration/glob');
    const p = toPattern('src/main/java/pay/security/**/*.java');
    expect(p.test('src/main/java/pay/security/PartnerKeyProvider.java')).toBe(true);
    expect(p.test('src/main/java/pay/security/CryptoService.java')).toBe(true);
    // and still at depth
    expect(p.test('src/main/java/pay/security/inner/Thing.java')).toBe(true);
    // and still refuses what is genuinely outside
    expect(p.test('src/main/java/pay/util/CryptoUtils.java')).toBe(false);
  });

  it('accepts the exact PQC-0030 scope that was wrongly rejected', async () => {
    const { toPattern } = await import('../src/core/migration/glob');
    const declared = [
      'pom.xml',
      'src/main/java/pay/security/**/*.java',
      'src/main/java/pay/util/**/*.java',
      'src/test/java/**/*.java',
    ];
    const changed = [
      'pom.xml',
      'src/main/java/pay/security/PartnerKeyProvider.java',
      'src/main/java/pay/security/CryptoService.java',
      'src/main/java/pay/util/CryptoUtils.java',
      'src/test/java/pay/PartnerHandshakeMock.java',
    ];
    const outside = changed.filter((c) => !declared.some((d) => toPattern(d).test(c)));
    expect(outside).toEqual([]);
  });
});
