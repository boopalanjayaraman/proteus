import type { BehavioralInvariant, StructuredFailure } from '@proteus/schema';
import type { ModelClient } from '../model';
import { DiagnosisInput } from '../tools/registry';
import { DIAGNOSIS_SYSTEM_INSTRUCTION } from '../prompts/diagnosis';

/**
 * A4 — the Diagnostic Agent.
 *
 * Runs only on the residue: twelve deterministic classifiers evaluate first, and
 * A4 is asked only when none of them matched. It holds no write tool and it did
 * not author the patch it is judging, which is the whole point — spec §26
 * forbids weakening a test to get a pass, and an agent adjudicating its own work
 * is motivated to conclude the test is wrong.
 *
 * What it returns is still not the last word. The repair authorisation rules
 * decide what may be done about a classification, and a low-confidence answer
 * becomes a gate rather than an action (`EXEC-DIAG-008`).
 */

/** Below this, the answer is not acted on — it is escalated. */
export const MIN_ACTIONABLE_CONFIDENCE = 0.6;

export interface DiagnosisContext {
  failure: StructuredFailure;
  invariants: BehavioralInvariant[];
  /** The diff, so A4 can see what changed without being told why. */
  changedFiles: Array<{ path: string; diff: string }>;
  attemptNumber: number;
}

export class DiagnosticAgent {
  constructor(private readonly model: ModelClient) {}

  async diagnose(ctx: DiagnosisContext) {
    const result = await this.model.generate({
      system: DIAGNOSIS_SYSTEM_INSTRUCTION,
      purpose: 'failure-diagnosis',
      schema: DiagnosisInput,
      prompt: [
        `Attempt ${ctx.attemptNumber}.`,
        '',
        'The failure:',
        `  phase: ${ctx.failure.phase}`,
        `  command: ${ctx.failure.command}`,
        `  exit code: ${ctx.failure.exitCode}`,
        `  error: ${ctx.failure.error}`,
        ...ctx.failure.failedTests.map(
          (t) => `  failed test: ${t.name}\n    ${t.message}`
            + (t.stackHead ? `\n    ${t.stackHead}` : ''),
        ),
        '',
        'Relevant log lines:',
        ...ctx.failure.relevantLogs.map((l) => `  ${l}`),
        '',
        'The baseline contract, captured before anything was modified:',
        ...ctx.invariants.map(
          (i) => `  [${i.disposition}] ${i.kind} — ${i.description}\n      ${i.assertion}`,
        ),
        '',
        'What this attempt changed:',
        ...ctx.changedFiles.map((f) => `--- ${f.path}\n${f.diff.slice(0, 4000)}`),
        '',
        'The deterministic classifiers did not match this failure. Say what broke, how',
        'confident you are, and whether fixing it is possible from inside the migration',
        'branch alone.',
      ].join('\n'),
    });

    return {
      ...result.output,
      /** Below the floor the system escalates rather than acting. */
      actionable: result.output.confidence >= MIN_ACTIONABLE_CONFIDENCE,
      model: result.model,
    };
  }
}
