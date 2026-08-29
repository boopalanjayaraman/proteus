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
  /**
   * The version the code is compiled and run against.
   *
   * Load-bearing, not decoration. A migration proposed against a runtime that
   * cannot provide the API is unrepairable: `javax.crypto.KEM` arrived in Java
   * 21, so on a Java 17 repository every attempt to reach ML-KEM through it
   * fails with `NoSuchAlgorithmException` no matter which provider is
   * registered — which is exactly how one run spent its entire repair budget.
   */
  languageVersion?: string;
  framework?: string;
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
  /** The stack, so a repair cannot re-propose an API the runtime lacks. */
  language: string;
  languageVersion?: string;
  buildSystem: string;
  framework?: string;
}

/** `Java 17, Maven, Spring Boot 3.2` — everything discovery established. */
function stackLine(ctx: { language: string; languageVersion?: string;
                         buildSystem: string; framework?: string }): string {
  return [
    ctx.languageVersion ? `${ctx.language} ${ctx.languageVersion}` : ctx.language,
    ctx.buildSystem,
    ctx.framework,
  ].filter(Boolean).join(', ');
}

/**
 * APIs that exist only above a given language version.
 *
 * Stated as a constraint rather than left for the model to remember, because
 * getting it wrong is not a compile error the loop can repair: the code builds,
 * the algorithm is simply never found at runtime, and every repair attempt goes
 * into registering providers that were never the problem.
 *
 * Kept deliberately short. This is not a compatibility database — it names the
 * traps this product walks into, and each entry earned its place by costing a
 * real run its repair budget.
 */
const VERSION_GATED_APIS: Array<{ language: string; minVersion: number; note: string }> = [
  {
    language: 'java',
    minVersion: 21,
    note: '`javax.crypto.KEM` requires Java 21+. Below that, reach ML-KEM through '
      + "Bouncy Castle's own API (MLKEMGenerator / MLKEMExtractor, or "
      + 'KeyPairGenerator/Cipher via BouncyCastlePQCProvider) — no provider '
      + 'registration makes `KEM.getInstance` resolve on an older runtime.',
  },
];

function runtimeConstraint(ctx: { language: string; languageVersion?: string }): string[] {
  const major = Number.parseInt(ctx.languageVersion ?? '', 10);
  if (!Number.isFinite(major)) return [];

  const gated = VERSION_GATED_APIS.filter(
    (g) => g.language === ctx.language.toLowerCase() && major < g.minVersion,
  );
  if (gated.length === 0) return [];

  return [
    '',
    `RUNTIME CONSTRAINT — this repository targets ${ctx.language} ${ctx.languageVersion}:`,
    ...gated.map((g) => `  ${g.note}`),
  ];
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
        `Stack: ${stackLine(ctx)}`,
        ...runtimeConstraint(ctx),
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
        `Stack: ${stackLine(ctx)}`,
        // The constraint belongs here more than anywhere: this is the prompt
        // that ran four times against an API the runtime could never provide.
        ...runtimeConstraint(ctx),
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
