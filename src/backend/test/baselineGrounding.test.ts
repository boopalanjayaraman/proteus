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
