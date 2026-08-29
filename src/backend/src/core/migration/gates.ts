import type {
  HumanGate, HumanGateType, MigrationRun, StructuredFailure,
} from '@proteus/schema';
import type { Repositories } from '../repositories';
import type { Classification } from './diagnosis';

/**
 * Mid-migration gates (spec §30, `EXEC-ESC-*`).
 *
 * The same `HumanGate` shape as the approval gate, resolved through the same
 * endpoint — that was the point of modelling approval as a gate in PRD-10, and
 * it is why nothing new is needed here to answer one.
 *
 * The property that matters is `blocking`. Spec §30 says the migration should
 * continue with unrelated eligible work wherever possible, so a gate that halts
 * one plan item must not halt the others. `RETRY_BUDGET_EXHAUSTED` in particular
 * is non-blocking by rule: four failed attempts on one problem says nothing
 * about the rest of the approved scope, and stopping everything would turn the
 * one-approval model back into an assistant asking permission.
 */

/** Whether a gate of this type stops the run or only the item that raised it. */
export const BLOCKING: Record<HumanGateType, boolean> = {
  MIGRATION_APPROVAL: true,
  BUSINESS_BEHAVIOR_CHANGE: true,
  BASELINE_CONTRACT_CHANGE: true,
  EXTERNAL_PROTOCOL_CHANGE: true,
  SECURITY_DEGRADATION: true,
  MATERIAL_PERFORMANCE_TRADEOFF: true,
  UNAUTHORIZED_SYSTEM_ACCESS: true,
  HARDWARE_REPLACEMENT: true,
  VENDOR_DECISION: true,
  MATERIAL_ARCHITECTURE_DECISION: true,
  // EXEC-ESC-001, explicitly: unrelated approved work continues.
  RETRY_BUDGET_EXHAUSTED: false,
};

export interface OpenGateInput {
  run: MigrationRun;
  type: HumanGateType;
  title: string;
  question: string;
  context: string;
  options: HumanGate['options'];
  attemptId?: string;
  relatedFindingIds?: string[];
  relatedChangeIds?: string[];
  evidenceIds?: string[];
}

/**
 * Opens a gate, idempotently on its subject.
 *
 * The id is derived from the run, the type and the subject, so a loop that
 * re-reaches the same impasse — a retry budget exhausted on the same problem,
 * the same invariant failing again — reopens nothing. Without that, a
 * non-blocking gate would accumulate one document per iteration and the
 * "action required" badge would count the same question many times.
 */
export async function openGate(
  repos: Repositories,
  input: OpenGateInput,
  subject: string,
): Promise<{ gate: HumanGate; created: boolean }> {
  const gateId = `gate_${input.run.migrationRunId}_${input.type.toLowerCase()}_${slug(subject)}`;
  const existing = await repos.humanGates.findOne({ gateId } as never);
  if (existing) return { gate: existing, created: false };

  const now = new Date();
  const blocking = BLOCKING[input.type];
  const gate: HumanGate = {
    _schemaVersion: 1, createdAt: now, updatedAt: now,
    gateId,
    projectId: input.run.projectId,
    migrationRunId: input.run.migrationRunId,
    ...(input.attemptId ? { attemptId: input.attemptId } : {}),
    type: input.type,
    blocking,
    title: input.title,
    question: input.question,
    context: input.context,
    evidenceIds: input.evidenceIds ?? [],
    relatedFindingIds: input.relatedFindingIds ?? [],
    relatedChangeIds: input.relatedChangeIds ?? [],
    options: input.options,
    status: 'OPEN',
    openedAt: now,
  };
  await repos.humanGates.insert(gate);

  await repos.projects.collection.updateOne(
    { projectId: input.run.projectId } as never,
    {
      $inc: { 'summary.counts.openGates': 1 } as never,
      // Only a blocking gate is something the user must answer before the run
      // can finish. Flagging a non-blocking one would tell them work has stopped
      // when it has not.
      ...(blocking ? { $set: { actionRequired: true, updatedAt: now } as never } : {}),
    },
  );
  await repos.migrationRuns.collection.updateOne(
    { migrationRunId: input.run.migrationRunId } as never,
    { $inc: { 'metrics.humanGatesOpened': 1 } as never },
  );

  await repos.events.emit(input.run.projectId, {
    type: 'HUMAN_GATE_REQUIRED', phase: 'MIGRATION',
    level: 'MILESTONE', severity: blocking ? 'ERROR' : 'WARN',
    stage: input.run.stage,
    title: input.title,
    message: `${input.type.replace(/_/g, ' ').toLowerCase()} · `
      + `${blocking ? 'the run is waiting on this' : 'unrelated approved work continues'}`,
    actor: 'SYSTEM',
    refs: { gateId, ...(input.attemptId ? { attemptId: input.attemptId } : {}) },
  });

  return { gate, created: true };
}

/** The two answers every mid-migration gate offers, plus whatever the caller adds. */
export const ACKNOWLEDGE_OPTIONS: HumanGate['options'] = [
  {
    optionId: 'ACKNOWLEDGE',
    label: 'Acknowledge and continue',
    detail: 'The finding is recorded and carried into the migration report.',
    consequence: 'No further autonomous attempts are made on this problem.',
  },
  {
    optionId: 'ABANDON',
    label: 'Abandon this item',
    detail: 'The rest of the approved scope continues without it.',
    consequence: 'The item is reported as requiring human action.',
  },
];

/** `EXEC-ESC-001` — four meaningful attempts on one problem. */
export function retryBudgetGate(
  run: MigrationRun,
  problemKey: string,
  attempts: number,
  classification: Classification,
  failure: StructuredFailure,
): OpenGateInput {
  return {
    run,
    type: 'RETRY_BUDGET_EXHAUSTED',
    title: `Four autonomous attempts on ${failure.failedTests[0]?.name ?? 'this problem'}`,
    question: 'This problem has not yielded to autonomous repair. How should it be handled?',
    context: [
      `Classification: ${classification.classification} (${classification.ruleId})`,
      `Attempts: ${attempts} of ${4}`,
      `Error: ${failure.error}`,
      '',
      'Relevant log lines:',
      ...failure.relevantLogs.slice(0, 10).map((l) => `  ${l}`),
      '',
      `Problem key: ${problemKey}`,
      '',
      'The rest of the approved scope is unaffected and continues.',
    ].join('\n'),
    options: ACKNOWLEDGE_OPTIONS,
  };
}

/** `EXEC-DIAG-005` — a MUST_PRESERVE invariant is failing. */
export function baselineContractGate(
  run: MigrationRun,
  invariantDescription: string,
  assertion: string,
  failure: StructuredFailure,
): OpenGateInput {
  return {
    run,
    type: 'BASELINE_CONTRACT_CHANGE',
    title: `Baseline invariant failing — ${invariantDescription}`,
    question: 'Completing the migration requires changing behaviour the baseline recorded '
      + 'as required. Is that change intended?',
    context: [
      'This assertion was captured before any modification and classified MUST_PRESERVE:',
      `  ${assertion}`,
      '',
      `It is now failing: ${failure.error}`,
      '',
      'No test or mock has been modified. Spec §25 forbids weakening a legitimate '
      + 'behavioural requirement to achieve a passing result, so this is a decision '
      + 'rather than a repair.',
    ].join('\n'),
    options: [
      {
        optionId: 'ACCEPT_CHANGE',
        label: 'The behaviour change is intended',
        detail: 'The invariant is reclassified and the assertion updated.',
        consequence: 'Recorded as a human-authorised baseline change in the report.',
      },
      {
        optionId: 'PRESERVE',
        label: 'The behaviour must be preserved',
        detail: 'The migration cannot complete this item as planned.',
        consequence: 'The item is reported as requiring human engineering.',
      },
    ],
  };
}

/** `EXEC-DIAG-008` — nothing classified it, and the model could not either. */
export function unclassifiedGate(
  run: MigrationRun,
  failure: StructuredFailure,
): OpenGateInput {
  return {
    run,
    type: 'MATERIAL_ARCHITECTURE_DECISION',
    title: 'A failure no classifier could resolve',
    question: 'This failure did not match any classifier and the diagnosis was '
      + 'inconclusive. How should it be handled?',
    context: [
      `Phase: ${failure.phase}`,
      `Command: ${failure.command} (exit ${failure.exitCode})`,
      `Error: ${failure.error}`,
      '',
      ...failure.relevantLogs.slice(0, 12).map((l) => `  ${l}`),
      '',
      'No repair was attempted. An unclassified failure repaired anyway is a guess '
      + 'with a commit attached.',
    ].join('\n'),
    options: ACKNOWLEDGE_OPTIONS,
  };
}

const slug = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'x';
