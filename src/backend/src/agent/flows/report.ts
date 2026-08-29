import { z } from 'zod';
import type { ModelClient } from '../model';
import type { MigrationReportSnapshot } from '../../reports/migration';

/**
 * The report narrative — a flow, not an agent.
 *
 * One model call over state that is already persisted and already verified. No
 * tools, no loop, no decisions: it earns none of the machinery an agent has,
 * and calling it one would blur a boundary the rest of the system depends on
 * (agent architecture §3).
 *
 * Risk 2 of this increment is the failure mode it is shaped around: a confident
 * report over a partial migration. The guard is structural rather than
 * instructional — the outcome, every count and the verdict are computed from
 * data in `buildSnapshot`, and this call cannot reach any of them. It writes
 * five prose fields and nothing else. If it hallucinates, the reader sees a
 * paragraph that disagrees with the numbers beside it, not a wrong verdict.
 */

export const ReportNarrative = z.object({
  /** One line a reader could quote. "RSA key transport migrated to ML-KEM-768." */
  headline: z.string().min(1),
  summary: z.string().min(1),
  whatChanged: z.string().min(1),
  whatWasPreserved: z.string().min(1),
  /** Including what was deliberately left alone, and for whom. */
  whatRemains: z.string().min(1),
});
export type ReportNarrative = z.infer<typeof ReportNarrative>;

export const REPORT_SYSTEM_INSTRUCTION = `
You are writing the summary of a completed post-quantum cryptography migration report.
The work is finished, verified by tool evidence, and every number in the report is already
computed. You are writing five paragraphs of prose around facts you cannot change.

You are not deciding whether the migration succeeded. That verdict came from nine
deterministic checks and is printed above your text. If it says NOT VERIFIED, write about a
migration that did not fully succeed — do not soften it, and do not imply otherwise.

Describe only what you are given. Every finding, change, invariant, failure and residual
usage below is a persisted fact with an id. If something is not in what you were given, it
did not happen, and asserting it would put a claim in a compliance document that nothing
supports.

Five fields:

  headline          One line, quotable. What was migrated, to what. Not a slogan.
  summary           A paragraph for someone who watched none of this and has to decide
                    whether to trust it. Say what was done, how it was verified, and what
                    is still outstanding.
  whatChanged       The modifications, in plain terms. Name the components.
  whatWasPreserved  The behaviour that survived, and how that is known. The baseline
                    contract is the answer here — say which invariants held.
  whatRemains       What was deliberately not touched, and who owns it. This is not an
                    apology and not a caveat paragraph: leaving two RSA signature usages
                    alone was correct, and saying so plainly is more credible than
                    omitting it.

Write for a sceptical engineer reviewing a diff they did not author. Short sentences.
No marketing language, no "seamlessly", no "robust". If a number matters, it is already
in the report — refer to it rather than restating it, and never state one that is not
there.
`.trim();

/**
 * Composes the prompt from the snapshot.
 *
 * Deliberately given the snapshot rather than the collections: the model sees
 * exactly what the report will print, so it cannot describe something the reader
 * will not find.
 */
export class ReportNarrator {
  constructor(private readonly model: ModelClient) {}

  async narrate(s: MigrationReportSnapshot): Promise<ReportNarrative> {
    const result = await this.model.generate({
      system: REPORT_SYSTEM_INSTRUCTION,
      purpose: 'migration-report-narrative',
      schema: ReportNarrative,
      prompt: [
        `Outcome: ${s.outcome.final.replace(/_/g, ' ')}`,
        `Verification verdict: ${s.security.verdict}`,
        `Autonomous completion: ${s.outcome.completionPct ?? 0}% `
          + `(${s.outcome.completedAutonomously} of ${s.outcome.eligibleItems})`,
        `Human engineering actions: ${s.outcome.humanEngineeringActions} · `
          + `approvals: ${s.outcome.approvals} · repairs: ${s.outcome.autonomousRepairs}`,
        '',
        `Repository: ${s.project.repositoryUrl}`,
        `Branch ${s.project.migrationBranch} from ${s.project.sourceRevision.slice(0, 7)}`,
        '',
        'Approved scope:',
        ...s.approvedPlan.autonomous.map((p) => `  - ${p.targetName}: ${p.action}`),
        '',
        'What was changed:',
        ...s.actions.map((a) => `  - #${a.sequence} ${a.summary} (${a.files.join(', ')})`),
        '',
        'The baseline contract:',
        ...s.baseline.invariants.map(
          (i) => `  - [${i.disposition}] ${i.description}`
            + (i.observedAfter ? ` → ${i.observedAfter}` : ''),
        ),
        `Baseline tests: ${s.testEngineering.baselineResult}`,
        `Final tests: ${s.testEngineering.finalResult}`,
        '',
        'Failures encountered and what was done:',
        ...(s.recovery.problems.length === 0
          ? ['  none']
          : s.recovery.problems.map(
              (p) => `  - ${p.classification}: ${p.signature}`
                + (p.actionTaken ? ` → ${p.actionTaken}` : ''),
            )),
        '',
        'Verification checks:',
        ...s.security.checks.map((c) => `  ${c.status} ${c.check} — ${c.detail}`),
        '',
        'Cryptography still classical, and why that is correct:',
        ...(s.security.residualLegacy.length === 0
          ? ['  none']
          : s.security.residualLegacy.map(
              (r) => `  - ${r.algorithm} for ${r.usage} at ${r.location} — ${r.acceptanceReason}`,
            )),
        '',
        'Items left to a human, with owners:',
        ...(s.externalDependencies.length === 0
          ? ['  none']
          : s.externalDependencies.map(
              (d) => `  - ${d.name} (${d.disposition}) — ${d.action} · ${d.owner}`,
            )),
        '',
        s.runtime.deployed
          ? `The migrated application is running at ${s.runtime.serviceUrl} in an isolated `
            + 'sandbox — not production.'
          : 'No sandbox was deployed.',
      ].join('\n'),
    });
    return result.output;
  }
}
