import { z } from 'zod';
import type { Baseline, PlanItem } from '@proteus/schema';
import type { ModelClient } from '../model';
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
}

export interface MigrationContext {
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
        `Suites: ${inventory.suites.join(', ') || 'none'}`,
        '',
        'The approved migration will change:',
        ...migration.planItems.map(
          (p) => `  - ${p.targetName}: ${p.action}`
            + (p.expectedChanges.length
              ? ` (${p.expectedChanges.flatMap((c) => c.paths).join(', ')})`
              : ''),
        ),
        migration.target
          ? `Approved target: ${migration.target.parameterSet ?? migration.target.target}`
          : '',
        '',
        'The components under migration:',
        ...migration.sources.map((s) => `--- ${s.path}\n${s.excerpt}`),
        '',
        'Capture the externally observable behaviour this migration could plausibly break.',
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
        `Test files on disk: ${repo.testPaths.join(', ') || 'none'}`,
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
        `Existing test files: ${repo.testPaths.join(', ') || 'none'}`,
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
        'Write the characterization tests, the migration acceptance tests, and any mock',
        'changes the approved scope requires. Label each accurately — they are run against',
        'the base commit and a mislabelled test is discarded.',
      ].filter(Boolean).join('\n'),
    });
    return result.output.artifacts;
  }
}
