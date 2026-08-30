import { z } from 'zod';
import type { BehavioralInvariant, PlanItem, StructuredFailure } from '@proteus/schema';
import type { ModelClient } from '../model';
import { PatchInput, RepairInput } from '../tools/registry';
import { MIGRATION_SYSTEM_INSTRUCTION, ML_KEM_REFERENCE } from '../prompts/migration';

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

/**
 * Where a library's API and its version are coupled, and getting it wrong
 * produces a compile error the loop cannot reason its way out of.
 *
 * These are not general documentation. Each entry is a trap a real run fell
 * into: the dependency upgrade and the imports are usually two different files,
 * often two different plan items, and nothing checks that the version chosen
 * actually contains the package that was imported.
 */
const LIBRARY_API_NOTES: Array<{ language: string; note: string }> = [
  {
    language: 'java',
    note: ML_KEM_REFERENCE,
  },
  {
    language: 'java',
    note: 'Bouncy Castle ML-KEM, verified against the published jars. Use '
      + 'bcprov-jdk18on 1.80 and these exact packages:\n'
      + '    - JCA keys:  org.bouncycastle.jcajce.interfaces.MLKEMPublicKey / '
      + 'MLKEMPrivateKey / MLKEMKey\n'
      + '    - JCA specs: org.bouncycastle.jcajce.spec.MLKEMParameterSpec\n'
      + '    - low level: org.bouncycastle.pqc.crypto.mlkem.MLKEMGenerator / '
      + 'MLKEMExtractor / MLKEMParameters\n'
      + '    ML-KEM is NOT under `pqc.jcajce` — that package holds Dilithium, Falcon, '
      + 'BIKE and CMCE only, and has no MLKEM types in any version. The low-level '
      + 'primitives are under `pqc.crypto.mlkem`, but the JCA layer is not.\n'
      + '    Version gate: the mlkem packages exist only from 1.79. bcprov 1.78.1 has '
      + 'none of them — its equivalents are `pqc.crypto.crystals.kyber` '
      + '(KyberKEMGenerator, KyberParameters). Importing an mlkem package without '
      + 'setting bcprov-jdk18on to >= 1.79 in the same change does not compile.',
  },
];

/**
 * The rule that stops an in-scope change breaking an out-of-scope file.
 *
 * A migration is given a small set of paths and may edit nothing else. If it
 * changes the signature of a method that something outside those paths calls,
 * the module stops compiling — and the caller cannot be fixed, because fixing it
 * would breach the approved scope.
 *
 * That is not hypothetical. `CryptoUtils.wrapKey(SecretKey, PublicKey)` was
 * replaced with a KEM-shaped API while `pay/legacy/LegacySettlementExporter`,
 * outside the approved paths, still called the old one. The build failed on a
 * file the agent was forbidden to touch, and no repair could reach it.
 *
 * ML-KEM makes this especially likely: a KEM *derives* a shared secret rather
 * than wrapping a key you already hold, so the natural migration changes the
 * shape of the method, not just its body.
 */
export const SCOPE_COMPATIBILITY: string[] = [
  'SOURCE COMPATIBILITY — the rest of the repository must still compile:',
  '  Files outside the approved paths are not yours to edit, and they are not',
  '  rewritten for you. So any public method, constructor or field you change',
  '  must remain callable exactly as it is called today by code you cannot see.',
  '',
  '  If the migration needs a different shape — and a KEM does, because it',
  '  derives a secret rather than wrapping one you already hold — then ADD the',
  '  new method and KEEP the old signature working. Do not repurpose or delete',
  '  a public signature that callers outside your scope may depend on.',
  '',
  '  SIGNATURE, NOT ALGORITHM. Keeping a method callable does NOT mean keeping',
  '  the old primitive reachable. A branch like',
  '',
  '      if ("RSA".equalsIgnoreCase(recipient.getAlgorithm())) { ...old RSA wrap... }',
  '',
  '  leaves quantum-vulnerable cryptography in an in-scope file, and',
  '  PROHIBITED_CRYPTO_ABSENT fails the migration for exactly that. The whole',
  '  point is that the classical path is gone. Same signature, one',
  '  implementation, and it is the new one — no compatibility fallback, no',
  '  algorithm switch on the key type.',
  '',
  '  If the old signature genuinely cannot keep working, say so in `refusal`',
  '  rather than changing it. A build that does not compile helps nobody, and a',
  '  refusal naming the caller is something a person can act on.',
];

/** Both constraint blocks, exported so their content can be asserted on. */
export function migrationConstraints(
  ctx: { language: string; languageVersion?: string },
): string[] {
  return [...runtimeConstraint(ctx), ...libraryNotes(ctx)];
}

function libraryNotes(ctx: { language: string }): string[] {
  const notes = LIBRARY_API_NOTES.filter(
    (n) => n.language === ctx.language.toLowerCase(),
  );
  if (notes.length === 0) return [];
  return ['', 'LIBRARY CONSTRAINTS — version and API are coupled:',
    ...notes.map((n) => `  ${n.note}`)];
}

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
        ...libraryNotes(ctx),
        '',
        'The approved scope — verification compares your diff against this.',
        'These are the ONLY files you may edit. Every other file in the repository',
        'stays exactly as it is, and must still compile against what you write:',
        ...ctx.planItem.expectedChanges.map(
          (c) => `  ${c.changeType}: ${c.paths.join(', ')} — ${c.description}`,
        ),
        ...ctx.planItem.conditions.map((c) => `  ONLY IF: ${c}`),
        '',
        ...SCOPE_COMPATIBILITY,
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
        // These belong here more than anywhere: this is the prompt that runs
        // after a compile error, and every trap so far produces exactly that.
        ...runtimeConstraint(ctx),
        ...libraryNotes(ctx),
        '',
        // A "cannot find symbol" in a file you may not edit is this rule being
        // broken upstream — the fix is to restore the signature, not to chase
        // the caller.
        ...SCOPE_COMPATIBILITY,
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
