import { z } from 'zod';
import type { BehavioralInvariant, PlanItem, StructuredFailure } from '@proteus/schema';
import type { ModelClient } from '../model';
import { PatchInput, RepairInput } from '../tools/registry';
import { MIGRATION_SYSTEM_INSTRUCTION } from '../prompts/migration';

/**
 * A3 — the Migration Engineer, in its patching role.
 *
 * Invoked once per patch. It does not iterate: the loop lives in the
 * orchestrator, because a loop the model drives cannot be checkpointed, cannot
 * be resumed after an eviction, and cannot be bounded by a retry budget.
 *
 * Returns proposals. Whether they land is decided elsewhere — scope against the
 * approved plan, mocks against `EXEC-MOCK-004`, test edits against the baseline
 * contract.
 */

export interface PatchContext {
  planItem: PlanItem;
  /** Only the files this plan item declared. A3 is never shown the repository. */
  files: Array<{ path: string; content: string }>;
  target?: { target: string; parameterSet?: string };
  /** The tests already written, which this patch has to satisfy. */
  acceptanceTests: Array<{ path: string; content: string }>;
  invariants: BehavioralInvariant[];
  buildSystem: string;
  language: string;
}

export interface RepairContext {
  failure: StructuredFailure;
  /** Decided by rules before A3 was asked. Not open to negotiation. */
  classification: string;
  classificationRuleId: string;
  classificationRationale: string;
  authorisedRuleIds: string[];
  /** Files the failure implicates, with their current contents. */
  files: Array<{ path: string; content: string }>;
  invariants: BehavioralInvariant[];
  /** What was tried before on this same problem, so attempt N+1 differs. */
  priorAttempts: Array<{ summary: string; outcome: string }>;
}

export class MigrationAgent {
  constructor(private readonly model: ModelClient) {}

  /** The patch for one approved plan item. */
  async produce(ctx: PatchContext): Promise<z.infer<typeof PatchInput>> {
    const result = await this.model.generate({
      system: MIGRATION_SYSTEM_INSTRUCTION,
      purpose: 'migration-patch',
      schema: PatchInput,
      prompt: [
        `Plan item ${ctx.planItem.planItemId} — ${ctx.planItem.targetName}`,
        `Action: ${ctx.planItem.action}`,
        `Rationale: ${ctx.planItem.rationale}`,
        ctx.target ? `Approved target: ${ctx.target.parameterSet ?? ctx.target.target}` : '',
        `Stack: ${ctx.language}, ${ctx.buildSystem}`,
        '',
        'The approved scope — verification compares your diff against this:',
        ...ctx.planItem.expectedChanges.map(
          (c) => `  ${c.changeType}: ${c.paths.join(', ')} — ${c.description}`,
        ),
        ...ctx.planItem.conditions.map((c) => `  ONLY IF: ${c}`),
        '',
        'The baseline contract:',
        ...ctx.invariants.map(
          (i) => `  [${i.disposition}] ${i.description}\n      ${i.assertion}`,
        ),
        '',
        'The tests that must pass when you are done — they currently fail:',
        ...ctx.acceptanceTests.map((t) => `--- ${t.path}\n${t.content}`),
        '',
        'The files to change:',
        ...ctx.files.map((f) => `--- ${f.path}\n${f.content}`),
        '',
        'Return the complete new content of every file you change.',
      ].filter(Boolean).join('\n'),
    });
    return result.output;
  }

  /**
   * The repair for a classified failure.
   *
   * The classification and the authorisation are given, not asked for. The
   * prompt says what each classification permits, and the guardrails refuse
   * anything else — an agent that could pick its own classification could pick
   * the one that authorised the edit it wanted.
   */
  async repair(ctx: RepairContext): Promise<z.infer<typeof RepairInput>> {
    const result = await this.model.generate({
      system: MIGRATION_SYSTEM_INSTRUCTION,
      purpose: 'migration-repair',
      schema: RepairInput,
      prompt: [
        'A build or test run failed. The failure has already been classified, by rules,',
        'before you were asked. You cannot change the classification.',
        '',
        `Classification: ${ctx.classification}`,
        `Assigned by: ${ctx.classificationRuleId}`,
        `Why: ${ctx.classificationRationale}`,
        `Repair authorised by: ${ctx.authorisedRuleIds.join(', ')}`,
        '',
        'The failure:',
        `  phase: ${ctx.failure.phase}`,
        `  command: ${ctx.failure.command} (exit ${ctx.failure.exitCode})`,
        `  error: ${ctx.failure.error}`,
        ...ctx.failure.failedTests.map((t) => `  failed: ${t.name} — ${t.message}`),
        '',
        'Relevant log lines:',
        ...ctx.failure.relevantLogs.map((l) => `  ${l}`),
        '',
        'The baseline contract. An assertion marked MUST_PRESERVE is not yours to soften:',
        ...ctx.invariants.map(
          (i) => `  [${i.disposition}] ${i.description}\n      ${i.assertion}`,
        ),
        '',
        ctx.priorAttempts.length > 0
          ? ['Already tried on this same problem, and did not work. Do something different:',
             ...ctx.priorAttempts.map((a) => `  - ${a.summary} → ${a.outcome}`)].join('\n')
          : '',
        '',
        'The files:',
        ...ctx.files.map((f) => `--- ${f.path}\n${f.content}`),
        '',
        'Return the complete new content of every file you change, and — for any test,',
        'mock or fixture — the integrity record justifying the edit.',
      ].filter(Boolean).join('\n'),
    });
    return result.output;
  }
}
