import { z } from 'zod';
import type { Baseline, PlanItem } from '@proteus/schema';
import type { ModelClient } from '../model';
import { apiSurfaceLines, type ApiMember } from '../../core/migration/apiSurface';
import {
  CoverageAssessmentInput, GeneratedTestInput, InvariantInput,
} from '../tools/registry';
import { TEST_ENGINEERING_SYSTEM_INSTRUCTION } from '../prompts/testEngineering';

/**
 * A3 — the Test Engineering Agent.
 *
 * Returns proposals. It writes nothing, commits nothing and runs nothing: the
 * caller passes every artifact through the guardrails and the base-commit
 * validation before any of it reaches the branch.
 *
 * The disposition of an invariant is never asked for, only proposed — the same
 * choice that keeps A2 out of the autonomy boundary keeps A3 out of the baseline
 * contract.
 */

export interface RepositoryContext {
  repositoryName: string;
  language: string;
  buildSystem: string;
  /** Suites the baseline run actually executed. Coverage is judged against these. */
  existingSuites: string[];
  /** Test files on disk, so the agent can extend rather than duplicate. */
  testPaths: string[];
  /**
   * The tests themselves — the actual baseline contract.
   *
   * `captureInvariants` was given test *counts* and suite *names* and asked what
   * behaviour the migration must not break. There was no truthful answer in that
   * context, so the model produced a plausible one: it invented
   * `decapsulateSecret`, `getEncapsulationKeyBytes` and a `SettlementService`
   * that does not exist in the repository, and reported `POST /settlements` as
   * returning 200 where it returns 201.
   *
   * The invented contract then propagated — `generateTests` was told not to
   * weaken it and wrote characterization tests implementing it, which failed on
   * the base commit because the methods were never there.
   *
   * The baseline contract is not something to infer. It is already written down,
   * in tests that already pass.
   */
  testSources: Array<{ path: string; content: string }>;
}

export interface MigrationContext {
  /**
   * Signatures of every public class in the repository.
   *
   * `sources` carries only the paths the plan authorises, which is right for
   * what may be edited and wrong for what a test has to CALL. Without this the
   * agent wrote `new SettlementSigner()` against a constructor taking a
   * `SigningKeyProvider` — a class it had never been shown.
   */
  apiSurface?: ApiMember[];
  planItems: PlanItem[];
  /** The target the plan approved — the sizes to assert follow from it. */
  target?: { target: string; parameterSet?: string };
  /** Source files the approved plan expects to touch. */
  targetPaths: string[];
  /** Excerpts of the components under migration, so tests can reference real names. */
  sources: Array<{ path: string; excerpt: string }>;
}

export class TestEngineeringAgent {
  constructor(private readonly model: ModelClient) {}

  /**
   * Captures the baseline contract.
   *
   * Asked before any test is written, because an invariant is an observation
   * about the system as it is, and once the agent has written tests it is
   * observing its own work.
   */
  async captureInvariants(
    repo: RepositoryContext,
    migration: MigrationContext,
    inventory: { total: number; passed: number; failed: number; suites: string[] },
  ): Promise<InvariantInput[]> {
    const result = await this.model.generate({
      system: TEST_ENGINEERING_SYSTEM_INSTRUCTION,
      purpose: 'baseline-invariants',
      schema: z.object({ invariants: z.array(InvariantInput) }),
      prompt: [
        `Repository: ${repo.repositoryName} — ${repo.language}, ${repo.buildSystem}`,
        '',
        `Baseline test run: ${inventory.total} tests, ${inventory.passed} passed, `
          + `${inventory.failed} failed.`,
        '',
        // The contract, verbatim. Naming the suites and asking the model to
        // recall what they assert is how a fabricated baseline gets written.
        'THE TESTS THAT PASS TODAY. This is the behaviour, exactly as recorded:',
        ...repo.testSources.map((t) => `--- ${t.path}\n${t.content}`),
        '',
        'The production code these exercise:',
        ...migration.sources.map((s) => `--- ${s.path}\n${s.excerpt}`),
        '',
        // Deliberately NOT told what the migration changes to. An invariant is
        // an observation about the system as it is; shown the destination, the
        // model described the destination — inventing ML-KEM method names and
        // asserting 1088-byte ciphertexts about an RSA codebase.
        'These files are the only evidence. Capture the externally observable',
        'behaviour a change to this code could break.',
        '',
        'Every invariant must come from an assertion above. Do not invent a method,',
        'a class or a status code — if it does not appear in the sources, it does not',
        'exist. An invariant you cannot point at is worse than one you did not write:',
        'it is checked, reported as preserved, and means nothing.',
        '',
        'Every assertion must be executable. Prose will be discarded.',
      ].filter(Boolean).join('\n'),
    });
    return result.output.invariants;
  }

  /**
   * Judges which components under migration have no covering test.
   *
   * `EXEC-TEST-001` turns on this answer. The executed suite list is supplied
   * rather than the file listing, because a `CryptoServiceTest` that exists but
   * exercises nothing about key transport is a coverage gap, and only a reader
   * of the tests can tell those apart.
   */
  async assessCoverage(
    repo: RepositoryContext,
    migration: MigrationContext,
  ): Promise<CoverageAssessmentInput[]> {
    if (migration.targetPaths.length === 0) return [];
    const result = await this.model.generate({
      system: TEST_ENGINEERING_SYSTEM_INSTRUCTION,
      purpose: 'coverage-assessment',
      schema: z.object({ components: z.array(CoverageAssessmentInput) }),
      prompt: [
        'Components the approved migration will modify:',
        ...migration.targetPaths.map((p) => `  - ${p}`),
        '',
        `Test suites that ran at baseline: ${repo.existingSuites.join(', ') || 'none'}`,
        '',
        // Coverage decided from what the tests assert, not from whether a file
        // called FooTest.java exists beside Foo.java.
        'The tests, in full:',
        ...repo.testSources.map((t) => `--- ${t.path}\n${t.content}`),
        '',
        'The components under migration:',
        ...migration.sources.map((s) => `--- ${s.path}\n${s.excerpt}`),
        '',
        'For each component, say whether an existing test actually exercises the behaviour',
        'this migration will change. A test class that exists but never calls the affected',
        'method is not coverage.',
      ].join('\n'),
    });
    return result.output.components;
  }

  /**
   * Proposes the tests and mocks.
   *
   * Every proposal is checked afterwards. The prompt names the traps and the
   * guard enforces them, so a model that ignores the instruction produces a
   * refusal rather than a bad test.
   */
  async generateTests(
    repo: RepositoryContext,
    migration: MigrationContext,
    baseline: Pick<Baseline, 'invariants'>,
    uncovered: CoverageAssessmentInput[],
  ): Promise<GeneratedTestInput[]> {
    const result = await this.model.generate({
      system: TEST_ENGINEERING_SYSTEM_INSTRUCTION,
      purpose: 'generate-tests',
      schema: z.object({ artifacts: z.array(GeneratedTestInput) }),
      prompt: [
        `Repository: ${repo.repositoryName} — ${repo.language}, ${repo.buildSystem}`,
        'EXISTING TESTS. These pass today and are the contract being preserved.',
        'You may not write to any of these paths: replacing a test that judges the',
        'migration is how a red suite is made green without fixing anything. If one',
        'needs new cases, add a new file with a different name.',
        ...repo.testSources.map((t) => `--- ${t.path}\n${t.content}`),
        '',
        'The baseline contract you must not weaken:',
        ...baseline.invariants.map(
          (i) => `  [${i.disposition}] ${i.kind} — ${i.description}\n      ${i.assertion}`,
        ),
        '',
        uncovered.length > 0
          ? ['Components with no covering test — write CHARACTERIZATION tests for these,',
             'which must pass against the code as it stands today AND still pass after',
             'the approved migration below has been applied:',
             ...uncovered.map((c) => `  - ${c.component} (${c.path}): ${c.reasoning}`)].join('\n')
          : 'Every component under migration already has covering tests.',
        '',
        'The approved migration:',
        ...migration.planItems.map((p) => `  - ${p.targetName}: ${p.action}`),
        migration.target
          ? `Approved target: ${migration.target.parameterSet ?? migration.target.target}`
          : '',
        '',
        'The components under migration:',
        ...migration.sources.map((s) => `--- ${s.path}\n${s.excerpt}`),
        ...apiSurfaceLines(migration.apiSurface ?? []),
        '',
        'A CHARACTERIZATION TEST PINS BEHAVIOUR THE MIGRATION MUST PRESERVE.',
        '  It must never assert the current value of something the approved plan changes.',
        '  A test asserting `bcprov-jdk18on` is at its pre-migration version passes today,',
        '  fails the moment the approved dependency upgrade lands, and is a tripwire you',
        '  set for yourself — it spends the repair budget on a problem you created.',
        '  Before writing each assertion, check it against the approved plan above: if a',
        '  plan item changes the thing you are about to assert, do not assert it.',
        '  Characterize what the migration must keep true — the settlement envelope still',
        '  round-trips, the signature still verifies — not the state it is about to leave.',
        '',
        'A MIGRATION ACCEPTANCE TEST ASSERTS THE MIGRATION HAPPENED — BEHAVIOURALLY.',
        '  Assert the algorithm in use, and that the operation still round-trips. Do NOT',
        '  assert an exact byte length on the wire.',
        '',
        '  A KEM agrees a shared secret; it does not transport a key the caller chose. So',
        '  where the method being migrated takes a caller-supplied key — a signature like',
        '  `wrapSessionKey(SecretKey, PublicKey)` — the correct construction is',
        '  KEM-then-wrap: the encapsulation FOLLOWED BY the caller\'s key wrapped under the',
        '  agreed secret. For ML-KEM-768 that is 1088 + 40 = 1128 bytes on the wire, not',
        '  1088. Where the method derives its own key, it is 1088.',
        '',
        '  You cannot tell which from the standard, only from the code — so do not assert',
        '  either number. An acceptance test asserting 1088 against a correct KEM-then-wrap',
        '  migration fails permanently, and it is your own test refusing your own work.',
        '  `assertTrue(wire.length > 0)` plus an algorithm assertion proves the migration',
        '  landed without pinning an implementation detail you had to guess.',
        '',
        'Use the algorithm identifier exactly as the approved target names it, and assert',
        'it consistently across every test you write. `ML-KEM-768` and `ML_KEM_768_PUBLIC_KEY`',
        'are not the same string, and a test comparing one to the other fails on spelling.',
        '',
        'Write the characterization tests, the migration acceptance tests, and any mock',
        'changes the approved scope requires. Label each accurately — they are run against',
        'the base commit and a mislabelled test is discarded.',
      ].filter(Boolean).join('\n'),
    });
    return result.output.artifacts;
  }
}
