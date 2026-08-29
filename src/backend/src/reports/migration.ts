import type {
  AgentAction, Assessment, Baseline, ExecutionRun, Finding, HumanGate, MigrationAttempt,
  MigrationChange, MigrationRun, Project, ProblemThread, Recommendation,
  SandboxDeployment, VerificationResult,
} from '@proteus/schema';

/**
 * The migration report (spec §40).
 *
 * The evidence package is a deliverable, not a by-product: this is the artefact
 * that lets someone who watched none of it decide whether to trust the result.
 * Two properties make that possible.
 *
 * It renders from a frozen snapshot rather than from live collections, so the
 * file a reviewer keeps says the same thing next year that it said on screen.
 * And every number in it comes from persisted facts — the outcome, the counts,
 * the verdict — with narrative confined to the fields a model may write. A
 * confident paragraph over a partial migration is the failure mode this
 * separation exists to prevent.
 */

/** Everything the report renders. Stored verbatim as `artifact.contentSnapshot`. */
export interface MigrationReportSnapshot {
  generatedAt: string;
  /** Narrative, written by the model over facts it cannot change. Optional. */
  narrative?: {
    headline: string;
    summary: string;
    whatChanged: string;
    whatWasPreserved: string;
    whatRemains: string;
  };

  project: {
    projectId: string; name: string; repositoryUrl: string;
    sourceRevision: string; migrationBranch: string; branchHead?: string;
  };

  assessment: {
    assessmentId: string; version: number;
    headline: string;
    findings: Array<{
      findingId: string; title: string; severity: string; disposition: string;
      algorithm?: string; usage?: string; location?: string;
    }>;
    relationships: string[];
  };

  approvedPlan: {
    approvedBy: string; approvedAt: string; assessmentVersion: number;
    autonomous: Array<{ targetName: string; mode: string; action: string; paths: string[] }>;
    excluded: Array<{ targetName: string; mode: string; action: string }>;
    blockers: Array<{ name: string; disposition: string; owner: string }>;
  };

  baseline: {
    commitSha: string;
    build: { passed: boolean; durationMs: number };
    tests: { total: number; passed: number; failed: number; knownFailures: string[] };
    invariants: Array<{
      kind: string; description: string; assertion: string; disposition: string;
      observedAfter?: string;
    }>;
  };

  actions: Array<{
    sequence: number; summary: string; rationale: string; changeType: string;
    intent: string; commitSha?: string; files: string[]; findingIds: string[];
  }>;

  testEngineering: {
    added: Array<{ path: string; summary: string }>;
    mocks: Array<{ path: string; summary: string; classification: string; reason: string }>;
    baselineResult: string;
    finalResult: string;
  };

  recovery: {
    attempts: number;
    problems: Array<{
      classification: string; signature: string; meaningfulAttempts: number; budget: number;
      status: string;
      diagnosis?: { rootCause: string; reasoning: string; source: string };
      actionTaken?: string;
    }>;
    autonomousRepairs: number;
  };

  security: {
    verdict: string;
    checks: Array<{ check: string; status: string; detail: string; executionRunId?: string }>;
    assertions: Array<{ label: string; status: string; evidence: string }>;
    residualLegacy: Array<{
      algorithm: string; usage: string; location: string; acceptanceReason: string;
    }>;
    verifiedPqc: Array<{ algorithm: string; usage: string; location: string }>;
    unresolved: Array<{ title: string; blocking: boolean; status: string }>;
  };

  externalDependencies: Array<{
    name: string; disposition: string; subtype?: string; action: string; owner: string;
    sourceCitation: string;
  }>;

  runtime: {
    deployed: boolean;
    imageUri?: string;
    serviceUrl?: string;
    isProduction: boolean;
    startup?: string;
    scenarios: Array<{ name: string; passed: boolean }>;
    latencyDeltaMs?: number;
  };

  outcome: {
    /** From data, never from prose. */
    final: 'VERIFIED' | 'PARTIALLY_MIGRATED' | 'HUMAN_ACTION_REQUIRED';
    eligibleItems: number;
    completedAutonomously: number;
    completionPct: number | null;
    humanEngineeringActions: number;
    approvals: number;
    autonomousRepairs: number;
    recommendationsRaised: number;
    elapsed?: string;
  };

  /** Cited, never inlined — the full trail is far too large for a report. */
  auditTrail: { agentActions: number; events: number; executions: number };
}

const AUTONOMOUS = new Set([
  'AUTONOMOUS_MIGRATION', 'AUTONOMOUS_UPDATE', 'AUTONOMOUS_GENERATION',
  'TEST_ENVIRONMENT_ADAPTATION',
]);

/**
 * The final outcome, from data.
 *
 * Spec §40 offers three, and which one applies is a question about persisted
 * state rather than a judgment. `VERIFIED` requires the verdict; anything with
 * an open blocking gate needs a human; everything else landed some of the
 * approved scope and not the rest.
 */
export function finalOutcome(input: {
  verification: VerificationResult | null;
  openBlockingGates: number;
  completed: number;
  eligible: number;
}): MigrationReportSnapshot['outcome']['final'] {
  if (input.verification?.overall === 'VERIFIED' && input.openBlockingGates === 0) {
    return 'VERIFIED';
  }
  if (input.openBlockingGates > 0) return 'HUMAN_ACTION_REQUIRED';
  return input.completed > 0 && input.completed < input.eligible
    ? 'PARTIALLY_MIGRATED'
    : 'HUMAN_ACTION_REQUIRED';
}

export interface BuildInput {
  project: Project;
  run: MigrationRun;
  assessment: Assessment;
  findings: Finding[];
  baseline: Baseline | null;
  changes: MigrationChange[];
  attempts: MigrationAttempt[];
  problems: ProblemThread[];
  executions: ExecutionRun[];
  verification: VerificationResult | null;
  sandbox: SandboxDeployment | null;
  recommendations: Recommendation[];
  gates: HumanGate[];
  agentActions: AgentAction[];
  eventCount: number;
  narrative?: MigrationReportSnapshot['narrative'];
}

export function buildSnapshot(input: BuildInput): MigrationReportSnapshot {
  const { project, run, assessment, baseline, verification, sandbox } = input;
  const now = new Date();

  const approved = new Set(run.approval.approvedPlanItemIds);
  const approvedItems = assessment.planItems.filter((p) => approved.has(p.planItemId));
  const excludedItems = assessment.planItems.filter((p) => !approved.has(p.planItemId));

  const openBlocking = input.gates.filter((g) => g.status === 'OPEN' && g.blocking);
  const migrationChanges = input.changes.filter((c) => c.intent !== 'TEST_ENGINEERING');
  const testChanges = input.changes.filter((c) => c.intent === 'TEST_ENGINEERING');

  const diagnosisFor = new Map(
    input.attempts.filter((a) => a.diagnosis).map((a) => [a.problemKey ?? a.attemptId, a]),
  );

  const baselineTests = baseline
    ? `${baseline.tests.passed}/${baseline.tests.total} passing at `
      + `${baseline.commitSha.slice(0, 7)}`
    : 'not captured';

  const finalRun = input.executions
    .filter((e) => e.kind === 'CRYPTO_VERIFY' && e.tests)
    .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0];

  const outcome = finalOutcome({
    verification,
    openBlockingGates: openBlocking.length,
    completed: project.summary.autonomy.completedAutonomously,
    eligible: project.summary.autonomy.eligibleItems,
  });

  return {
    generatedAt: now.toISOString(),
    ...(input.narrative ? { narrative: input.narrative } : {}),

    project: {
      projectId: project.projectId,
      name: project.name,
      repositoryUrl: project.repository.url,
      sourceRevision: run.branch.baseCommitSha,
      migrationBranch: run.branch.name,
      ...(run.branch.headCommitSha ? { branchHead: run.branch.headCommitSha } : {}),
    },

    assessment: {
      assessmentId: assessment.assessmentId,
      version: assessment.version,
      headline: assessment.summary.headline,
      // Significant findings only. A report that lists every no-change finding
      // buries the four that mattered.
      findings: input.findings
        .filter((f) => f.severity === 'CRITICAL' || f.severity === 'HIGH'
          || AUTONOMOUS.has(f.disposition) || f.disposition !== 'NO_CHANGE_REQUIRED')
        .map((f) => ({
          findingId: f.findingId, title: f.title, severity: f.severity,
          disposition: f.disposition,
          ...(f.crypto ? { algorithm: f.crypto.algorithm, usage: f.crypto.usage } : {}),
          ...(f.locations[0]?.path
            ? {
                location: `${f.locations[0].path}`
                  + (f.locations[0].startLine ? `:${f.locations[0].startLine}` : ''),
              }
            : {}),
        })),
      relationships: approvedItems.flatMap((p) =>
        p.targetNodeIds.map((n) => `${p.targetName} → ${n}`)),
    },

    approvedPlan: {
      approvedBy: run.approval.approvedBy,
      approvedAt: run.approval.approvedAt.toISOString(),
      assessmentVersion: run.approval.assessmentVersion,
      autonomous: approvedItems.map((p) => ({
        targetName: p.targetName, mode: p.mode, action: p.action,
        paths: p.expectedChanges.flatMap((c) => c.paths),
      })),
      excluded: excludedItems.map((p) => ({
        targetName: p.targetName, mode: p.mode, action: p.action,
      })),
      // Hardware and vendor items are blockers on the *plan*, distinct from
      // gates on the run — they were never in scope and never stopped anything.
      blockers: input.recommendations
        .filter((r) => r.disposition === 'HARDWARE_REPLACEMENT'
          || r.disposition === 'VENDOR_DECISION')
        .map((r) => ({ name: r.name, disposition: r.disposition, owner: r.owner })),
    },

    baseline: {
      commitSha: baseline?.commitSha ?? run.branch.baseCommitSha,
      build: {
        passed: baseline?.build.passed ?? false,
        durationMs: baseline?.build.durationMs ?? 0,
      },
      tests: {
        total: baseline?.tests.total ?? 0,
        passed: baseline?.tests.passed ?? 0,
        failed: baseline?.tests.failed ?? 0,
        knownFailures: (baseline?.tests.knownFailures ?? []).map((f) => f.testId),
      },
      invariants: (baseline?.invariants ?? []).map((i) => ({
        kind: i.kind, description: i.description, assertion: i.assertion,
        disposition: i.disposition,
        ...(i.observedAfter ? { observedAfter: i.observedAfter } : {}),
      })),
    },

    actions: migrationChanges.map((c) => ({
      sequence: c.sequence, summary: c.summary, rationale: c.rationale,
      changeType: c.changeType, intent: c.intent,
      ...(c.commitSha ? { commitSha: c.commitSha } : {}),
      files: c.files.map((f) => f.path),
      findingIds: c.findingIds,
    })),

    testEngineering: {
      added: testChanges
        .filter((c) => c.changeType === 'TEST')
        .flatMap((c) => c.files.map((f) => ({ path: f.path, summary: c.summary }))),
      // The anti-cheating record, in the report. Spec §26's question — why was
      // it safe to edit this? — has to be answerable from the deliverable.
      mocks: input.changes
        .filter((c) => c.changeType === 'MOCK' || c.changeType === 'FIXTURE')
        .flatMap((c) => c.files.map((f) => ({
          path: f.path,
          summary: c.summary,
          classification: c.testIntegrity?.failureClassification ?? 'UNKNOWN',
          reason: c.testIntegrity?.reason ?? '',
        }))),
      baselineResult: baselineTests,
      finalResult: finalRun?.tests
        ? `${finalRun.tests.passed}/${finalRun.tests.total} passing`
          + (finalRun.tests.failed > 0 ? ` · ${finalRun.tests.failed} failing` : '')
        : 'not run',
    },

    recovery: {
      attempts: input.attempts.length,
      problems: input.problems.map((p) => {
        const attempt = diagnosisFor.get(p.problemKey);
        return {
          classification: p.classification,
          signature: p.signature,
          meaningfulAttempts: p.meaningfulAttempts,
          budget: 4,
          status: p.status,
          ...(attempt?.diagnosis
            ? {
                diagnosis: {
                  rootCause: attempt.diagnosis.rootCause,
                  reasoning: attempt.diagnosis.reasoning,
                  source: 'MODEL',
                },
              }
            : {}),
          ...(actionFor(p, input.changes) ? { actionTaken: actionFor(p, input.changes)! } : {}),
        };
      }),
      autonomousRepairs: run.metrics.autonomousRepairs,
    },

    security: {
      verdict: verification?.overall ?? 'NOT_VERIFIED',
      checks: (verification?.checks ?? []).map((c) => ({
        check: c.check, status: c.status, detail: c.detail,
        ...(c.executionRunId ? { executionRunId: c.executionRunId } : {}),
      })),
      assertions: (verification?.cryptoAssertions ?? []).map((a) => ({
        label: a.label, status: a.status, evidence: a.evidence,
      })),
      // Kept apart from the verified PQC deliberately: a reader needs to see
      // both what is still classical and why that is acceptable.
      residualLegacy: (verification?.residualLegacyCrypto ?? []).map((r) => ({
        algorithm: r.algorithm, usage: r.usage,
        location: `${r.path}:${r.line}`,
        acceptanceReason: r.acceptanceReason ?? 'out of approved scope',
      })),
      verifiedPqc: (verification?.detectedPqc ?? []).map((d) => ({
        algorithm: d.algorithm, usage: d.usage, location: `${d.path}:${d.line}`,
      })),
      unresolved: input.gates
        .filter((g) => g.status === 'OPEN')
        .map((g) => ({ title: g.title, blocking: g.blocking, status: g.status })),
    },

    externalDependencies: input.recommendations.map((r) => ({
      name: r.name, disposition: r.disposition, action: r.action, owner: r.owner,
      sourceCitation: r.sourceCitation,
    })),

    runtime: {
      deployed: sandbox?.status === 'READY',
      ...(sandbox?.imageUri ? { imageUri: sandbox.imageUri } : {}),
      ...(sandbox?.service.url ? { serviceUrl: sandbox.service.url } : {}),
      isProduction: sandbox?.isProduction ?? false,
      ...(sandbox?.startupCheck?.detail ? { startup: sandbox.startupCheck.detail } : {}),
      scenarios: sandbox?.e2e?.scenarios ?? [],
      ...(sandbox?.e2e?.latencyDeltaMs !== undefined
        ? { latencyDeltaMs: sandbox.e2e.latencyDeltaMs }
        : {}),
    },

    outcome: {
      final: outcome,
      eligibleItems: project.summary.autonomy.eligibleItems,
      completedAutonomously: project.summary.autonomy.completedAutonomously,
      completionPct: project.summary.autonomy.completionPct,
      humanEngineeringActions: project.summary.autonomy.humanEngineeringActions,
      approvals: project.summary.autonomy.approvals,
      autonomousRepairs: run.metrics.autonomousRepairs,
      recommendationsRaised: input.recommendations.length,
      ...(run.completedAt
        ? { elapsed: elapsed(run.startedAt, run.completedAt) }
        : {}),
    },

    // Risk 3: the full trail would make the report unusable. Cited by count,
    // with the collections named, so a reviewer knows where to look.
    auditTrail: {
      agentActions: input.agentActions.length,
      events: input.eventCount,
      executions: input.executions.length,
    },
  };
}

/** What was actually done about a problem, from the change that followed it. */
function actionFor(problem: ProblemThread, changes: MigrationChange[]): string | undefined {
  const repair = changes.find(
    (c) => c.intent === 'REPAIR'
      && c.testIntegrity?.failureClassification === problem.classification,
  );
  return repair ? `${repair.summary} (modification #${repair.sequence})` : undefined;
}

const elapsed = (from: Date, to: Date): string => {
  const s = Math.max(0, Math.round((to.getTime() - from.getTime()) / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const h = (level: number, text: string): string => `${'#'.repeat(level)} ${text}\n`;
const none = '_None._\n';

/** A pure transform of the snapshot. Same input, same bytes, forever. */
export function renderMarkdown(s: MigrationReportSnapshot): string {
  const out: string[] = [];

  out.push(h(1, `PQC migration report — ${s.project.name}`));
  out.push(`Generated ${s.generatedAt}\n`);
  // The verdict first. A reader who stops after one line should have the answer.
  out.push(`**${s.outcome.final.replace(/_/g, ' ')}**`
    + (s.outcome.elapsed ? ` · ${s.outcome.elapsed} end to end` : '') + '\n');

  if (s.narrative) {
    out.push(`${s.narrative.headline}\n`);
    out.push(`${s.narrative.summary}\n`);
  }

  out.push(h(2, 'Project summary'));
  out.push(
    `- **Project** ${s.project.projectId} — ${s.project.name}\n`
    + `- **Repository** ${s.project.repositoryUrl}\n`
    + `- **Source revision** ${s.project.sourceRevision}\n`
    + `- **Migration branch** ${s.project.migrationBranch}`
    + (s.project.branchHead ? ` at ${s.project.branchHead.slice(0, 7)}` : '') + '\n',
  );

  out.push(h(2, 'Original assessment'));
  out.push(`${s.assessment.headline}\n`);
  out.push(h(3, 'Significant findings'));
  out.push(s.assessment.findings.length === 0 ? none : s.assessment.findings.map((f) =>
    `- **${f.title}** — ${f.severity} · ${f.disposition.replace(/_/g, ' ')}`
    + (f.algorithm ? ` · ${f.algorithm} for ${f.usage}` : '')
    + (f.location ? ` · ${f.location}` : ''),
  ).join('\n') + '\n');
  out.push(h(3, 'Dependency relationships'));
  out.push(s.assessment.relationships.length === 0
    ? none
    : s.assessment.relationships.map((r) => `- ${r}`).join('\n') + '\n');

  out.push(h(2, 'Approved migration plan'));
  out.push(
    `Approved by ${s.approvedPlan.approvedBy} at ${s.approvedPlan.approvedAt}, `
    + `against assessment version ${s.approvedPlan.assessmentVersion}.\n`,
  );
  out.push(h(3, 'Autonomous items'));
  out.push(s.approvedPlan.autonomous.length === 0 ? none : s.approvedPlan.autonomous.map((p) =>
    `- **${p.targetName}** (${p.mode.replace(/_/g, ' ')}) — ${p.action}`
    + (p.paths.length ? `\n  - Declared scope: ${p.paths.join(', ')}` : ''),
  ).join('\n') + '\n');
  out.push(h(3, 'Excluded items'));
  out.push(s.approvedPlan.excluded.length === 0 ? none : s.approvedPlan.excluded.map((p) =>
    `- **${p.targetName}** (${p.mode.replace(/_/g, ' ')}) — ${p.action}`).join('\n') + '\n');
  out.push(h(3, 'Vendor and hardware blockers'));
  out.push(s.approvedPlan.blockers.length === 0 ? none : s.approvedPlan.blockers.map((b) =>
    `- **${b.name}** — ${b.disposition.replace(/_/g, ' ')} · owner: ${b.owner}`).join('\n') + '\n');

  out.push(h(2, 'Baseline'));
  out.push(
    `- **Commit** ${s.baseline.commitSha}\n`
    + `- **Build** ${s.baseline.build.passed ? 'passed' : 'FAILED'} `
    + `in ${(s.baseline.build.durationMs / 1000).toFixed(1)}s\n`
    + `- **Tests** ${s.baseline.tests.passed}/${s.baseline.tests.total} passing`
    + (s.baseline.tests.knownFailures.length
      ? `, ${s.baseline.tests.knownFailures.length} pre-existing failure(s) recorded as known `
        + 'and never attributed to the migration'
      : '') + '\n',
  );
  out.push(h(3, 'Captured behavioural invariants'));
  out.push(s.baseline.invariants.length === 0 ? none : s.baseline.invariants.map((i) =>
    `- \`${i.disposition}\` **${i.kind}** — ${i.description}\n`
    + `  - \`${i.assertion}\``
    + (i.observedAfter ? `\n  - After migration: ${i.observedAfter}` : ''),
  ).join('\n') + '\n');

  out.push(h(2, 'Migration actions'));
  if (s.actions.length === 0) out.push(none);
  for (const a of s.actions) {
    out.push(h(3, `Modification #${a.sequence} — ${a.summary}`));
    out.push(
      `- **Type** ${a.changeType} · ${a.intent}\n`
      + (a.findingIds.length ? `- **Source finding** ${a.findingIds.join(', ')}\n` : '')
      + `- **Files** ${a.files.join(', ')}\n`
      + (a.commitSha ? `- **Commit** ${a.commitSha}\n` : '')
      + `\n**Rationale** — ${a.rationale}\n`,
    );
  }

  out.push(h(2, 'Test engineering'));
  out.push(h(3, 'Tests added'));
  out.push(s.testEngineering.added.length === 0 ? none : s.testEngineering.added.map((t) =>
    `- \`${t.path}\` — ${t.summary}`).join('\n') + '\n');
  out.push(h(3, 'Mocks and fixtures'));
  out.push(s.testEngineering.mocks.length === 0 ? none : s.testEngineering.mocks.map((m) =>
    `- \`${m.path}\` — ${m.summary}\n`
    + `  - Classification: ${m.classification}${m.reason ? ` — ${m.reason}` : ''}`,
  ).join('\n') + '\n');
  out.push(
    `- **Baseline result** ${s.testEngineering.baselineResult}\n`
    + `- **Final result** ${s.testEngineering.finalResult}\n`,
  );

  out.push(h(2, 'Autonomous recovery'));
  out.push(
    `${s.recovery.attempts} attempt(s) · ${s.recovery.autonomousRepairs} autonomous repair(s)\n`,
  );
  if (s.recovery.problems.length === 0) out.push(none);
  for (const p of s.recovery.problems) {
    out.push(h(3, `${p.classification.replace(/_/g, ' ')}`));
    out.push(
      `- **Failure** ${p.signature}\n`
      + `- **Retry count** ${p.meaningfulAttempts} / ${p.budget} meaningful attempts\n`
      + `- **Status** ${p.status}\n`
      + (p.diagnosis
        ? `\n**Diagnosis** — ${p.diagnosis.rootCause}\n\n${p.diagnosis.reasoning}\n`
        : '')
      + (p.actionTaken ? `\n**Action taken** — ${p.actionTaken}\n` : ''),
    );
  }

  out.push(h(2, 'Security verification'));
  out.push(`**${s.security.verdict.replace(/_/g, ' ')}**\n`);
  out.push(s.security.checks.map((c) =>
    `- ${c.status === 'PASS' ? '✓' : c.status === 'FAIL' ? '✗' : '–'} `
    + `**${c.check.replace(/_/g, ' ')}** — ${c.detail}`
    + (c.executionRunId ? ` _(${c.executionRunId})_` : ''),
  ).join('\n') + '\n');

  out.push(h(3, 'Cryptographic assertions'));
  out.push(s.security.assertions.length === 0 ? none : s.security.assertions.map((a) =>
    `- \`${a.status}\` ${a.label} — ${a.evidence}`).join('\n') + '\n');

  out.push(h(3, 'Legacy cryptography remaining'));
  out.push(s.security.residualLegacy.length === 0
    ? '_None._\n'
    : s.security.residualLegacy.map((r) =>
        `- **${r.algorithm}** for ${r.usage.replace(/_/g, ' ').toLowerCase()} at ${r.location}\n`
        + `  - ${r.acceptanceReason}`).join('\n') + '\n');

  out.push(h(3, 'Target PQC implementation'));
  out.push(s.security.verifiedPqc.length === 0 ? none : s.security.verifiedPqc.map((d) =>
    `- **${d.algorithm}** for ${d.usage.replace(/_/g, ' ').toLowerCase()} at ${d.location}`,
  ).join('\n') + '\n');

  out.push(h(3, 'Unresolved security issues'));
  out.push(s.security.unresolved.length === 0 ? none : s.security.unresolved.map((u) =>
    `- ${u.blocking ? '**BLOCKING** ' : ''}${u.title} (${u.status})`).join('\n') + '\n');

  out.push(h(2, 'External dependencies'));
  out.push(s.externalDependencies.length === 0 ? none : s.externalDependencies.map((d) =>
    `- **${d.name}** — ${d.disposition.replace(/_/g, ' ')}\n`
    + `  - Action: ${d.action}\n`
    + `  - Owner: ${d.owner}\n`
    + `  - Source: ${d.sourceCitation}`).join('\n') + '\n');

  out.push(h(2, 'Runtime verification'));
  out.push(
    `- **Sandbox** ${s.runtime.deployed ? 'deployed and healthy' : 'not deployed'}\n`
    + (s.runtime.imageUri ? `- **Image** ${s.runtime.imageUri}\n` : '')
    + (s.runtime.serviceUrl ? `- **Application** ${s.runtime.serviceUrl}\n` : '')
    // Stated from the data, every time. Spec §36 forbids representing the
    // sandbox as production, and a report is a place that could quietly do it.
    + `- **Environment** ${s.runtime.isProduction ? 'PRODUCTION' : 'isolated sandbox — not production'}\n`
    + (s.runtime.startup ? `- **Startup** ${s.runtime.startup}\n` : ''),
  );
  out.push(h(3, 'End-to-end verification'));
  out.push(s.runtime.scenarios.length === 0 ? none : s.runtime.scenarios.map((sc) =>
    `- ${sc.passed ? '✓' : '✗'} ${sc.name}`).join('\n')
    + (s.runtime.latencyDeltaMs !== undefined
      ? `\n\nLatency ${s.runtime.latencyDeltaMs >= 0 ? '+' : ''}${s.runtime.latencyDeltaMs}ms `
        + 'versus baseline. Reported, not gated — no performance budget was supplied '
        + '(EXEC-ESC-007).\n'
      : '\n'));

  out.push(h(2, 'Final outcome'));
  out.push(
    `**${s.outcome.final.replace(/_/g, ' ')}**\n\n`
    + `- Autonomous completion: ${s.outcome.completionPct ?? 0}% `
    + `(${s.outcome.completedAutonomously} of ${s.outcome.eligibleItems} eligible)\n`
    + `- Human engineering actions: ${s.outcome.humanEngineeringActions}\n`
    + `- Approvals: ${s.outcome.approvals}\n`
    + `- Autonomous repairs: ${s.outcome.autonomousRepairs}\n`
    + `- Recommendations raised: ${s.outcome.recommendationsRaised}\n`,
  );

  out.push(h(2, 'Audit trail'));
  out.push(
    `The complete trail is retained and referenced rather than reproduced here: `
    + `${s.auditTrail.agentActions} agent action(s) in \`agent_actions\`, `
    + `${s.auditTrail.events} event(s) in \`events\`, and `
    + `${s.auditTrail.executions} execution(s) in \`execution_runs\`.\n`,
  );

  return out.join('\n');
}

/** The §40 sections, named. A test asserts the rendered report contains each. */
export const REQUIRED_SECTIONS = [
  'Project summary', 'Original assessment', 'Approved migration plan', 'Baseline',
  'Migration actions', 'Test engineering', 'Autonomous recovery', 'Security verification',
  'External dependencies', 'Runtime verification', 'Final outcome',
] as const;
