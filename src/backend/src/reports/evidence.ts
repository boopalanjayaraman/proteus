import type { ExecutionRun, MigrationAttempt, MigrationChange } from '@proteus/schema';

/**
 * The two non-narrative artifacts: the diff and the build evidence.
 *
 * Both are assembled rather than rendered — a diff is already the right format
 * and a build log is already structured. The value added here is context: which
 * modification a hunk belongs to, and which attempt a failure came from. A bare
 * `git diff` and a folder of logs are what you get without it, and neither
 * answers "why".
 */

export interface DiffStats {
  commits: number;
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
}

/**
 * The branch diff, annotated per modification.
 *
 * Each hunk is preceded by the change that produced it and its rationale, so a
 * reviewer reading top to bottom sees the reasoning before the code rather than
 * having to correlate a commit message with a report section.
 */
export function renderDiff(
  changes: MigrationChange[],
  patches: Map<string, string>,
): { content: string; stats: DiffStats } {
  const out: string[] = [];
  const files = new Set<string>();
  let added = 0;
  let removed = 0;
  let commits = 0;

  for (const change of [...changes].sort((a, b) => a.sequence - b.sequence)) {
    const patch = patches.get(change.changeId);
    if (!patch) continue;
    commits++;

    for (const f of change.files) {
      files.add(f.path);
      added += f.linesAdded;
      removed += f.linesRemoved;
    }

    out.push(
      `# ─────────────────────────────────────────────────────────────────────`,
      `# Modification #${change.sequence} — ${change.summary}`,
      `# ${change.changeType} · ${change.intent}`
        + (change.commitSha ? ` · ${change.commitSha}` : ''),
      `#`,
      ...wrap(change.rationale, 76).map((l) => `# ${l}`),
      // Spec §26's question, answered in the diff itself: a reviewer looking at
      // a modified test should not have to leave the file to learn why it was
      // safe to modify.
      ...(change.testIntegrity
        ? [
            `#`,
            `# Test integrity: ${change.testIntegrity.failureClassification}`,
            ...wrap(change.testIntegrity.reason, 76).map((l) => `#   ${l}`),
            `#   Baseline requirement changed: `
              + `${change.testIntegrity.baselineRequirementChanged ? 'YES' : 'no'}`,
          ]
        : []),
      `# ─────────────────────────────────────────────────────────────────────`,
      '',
      patch.trimEnd(),
      '',
    );
  }

  // Counted from the patch when the change document did not record line counts,
  // which is the common case — git computes them and we did not store them.
  if (added === 0 && removed === 0) {
    for (const patch of patches.values()) {
      for (const line of patch.split('\n')) {
        if (line.startsWith('+') && !line.startsWith('+++')) added++;
        else if (line.startsWith('-') && !line.startsWith('---')) removed++;
      }
    }
  }

  // An empty file would claim the migration changed nothing. Saying why the
  // patches are missing is the honest version, and it is a real state: a run
  // whose diffs never reached blob storage produced no reviewable change.
  const content = out.length > 0
    ? out.join('\n')
    : `# No patches are available for this migration run.\n`
      + `# ${changes.length} change(s) are recorded, but none carries a stored diff.\n`;

  return {
    content,
    stats: { commits, filesChanged: files.size, linesAdded: added, linesRemoved: removed },
  };
}

export interface BuildEvidence {
  generatedAt: string;
  summary: {
    executions: number;
    attempts: number;
    passed: number;
    failed: number;
  };
  executions: Array<{
    executionRunId: string;
    kind: string;
    environment: string;
    command: string;
    commitSha: string;
    status: string;
    exitCode?: number;
    durationMs?: number;
    tests?: {
      total: number; passed: number; failed: number; skipped: number;
      failures: Array<{ testId: string; message: string }>;
    };
    /** The bounded extract, not the log. The full log stays in blob storage. */
    logExcerpt: string[];
    logGcsUri?: string;
  }>;
  attempts: Array<{
    attemptId: string;
    attemptNumber: number;
    intent: string;
    result: string;
    problemKey?: string;
    failure?: {
      phase: string; command: string; exitCode: number; error: string;
      failedTests: string[]; relevantLogs: string[];
    };
    diagnosis?: {
      classification: string; rootCause: string; withinAutonomousBoundary: boolean;
      baselineRequirementChanged: boolean; proposedAction: string;
    };
  }>;
}

/**
 * Every execution and attempt, structured.
 *
 * JSON rather than prose because this is the artifact something else reads —
 * a reviewer's script, a compliance tool, the next run comparing against this
 * one. The log excerpts are the same bounded extracts the diagnosis saw, so a
 * reader can check the classification against exactly what produced it.
 */
export function buildEvidence(
  executions: ExecutionRun[],
  attempts: MigrationAttempt[],
): BuildEvidence {
  const ordered = [...executions].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      executions: ordered.length,
      attempts: attempts.length,
      passed: ordered.filter((e) => e.status === 'SUCCESS').length,
      failed: ordered.filter((e) => e.status === 'FAILURE' || e.status === 'TIMEOUT').length,
    },
    executions: ordered.map((e) => ({
      executionRunId: e.executionRunId,
      kind: e.kind,
      environment: e.environment,
      command: e.command,
      commitSha: e.commitSha,
      status: e.status,
      ...(e.exitCode !== undefined ? { exitCode: e.exitCode } : {}),
      ...(e.durationMs !== undefined ? { durationMs: e.durationMs } : {}),
      ...(e.tests
        ? {
            tests: {
              total: e.tests.total, passed: e.tests.passed,
              failed: e.tests.failed, skipped: e.tests.skipped,
              failures: e.tests.failures.map((f) => ({
                testId: f.testId, message: f.message,
              })),
            },
          }
        : {}),
      logExcerpt: e.logExcerpt,
      ...(e.logGcsUri ? { logGcsUri: e.logGcsUri } : {}),
    })),
    attempts: [...attempts]
      .sort((a, b) => a.attemptNumber - b.attemptNumber)
      .map((a) => ({
        attemptId: a.attemptId,
        attemptNumber: a.attemptNumber,
        intent: a.intent,
        result: a.result,
        ...(a.problemKey ? { problemKey: a.problemKey } : {}),
        ...(a.failure
          ? {
              failure: {
                phase: a.failure.phase, command: a.failure.command,
                exitCode: a.failure.exitCode, error: a.failure.error,
                failedTests: a.failure.failedTests.map((t) => t.name),
                relevantLogs: a.failure.relevantLogs,
              },
            }
          : {}),
        ...(a.diagnosis
          ? {
              diagnosis: {
                classification: a.diagnosis.classification,
                rootCause: a.diagnosis.rootCause,
                withinAutonomousBoundary: a.diagnosis.withinAutonomousBoundary,
                baselineRequirementChanged: a.diagnosis.baselineRequirementChanged,
                proposedAction: a.diagnosis.proposedAction,
              },
            }
          : {}),
      })),
  };
}

/** `6 COMMITS · 4 FILES · +212 −68` — the card's meta line. */
export function diffMeta(stats: DiffStats): string {
  return `${stats.commits} COMMIT${stats.commits === 1 ? '' : 'S'} · `
    + `${stats.filesChanged} FILE${stats.filesChanged === 1 ? '' : 'S'} · `
    + `+${stats.linesAdded} −${stats.linesRemoved}`;
}

export function evidenceMeta(evidence: BuildEvidence): string {
  return `${evidence.summary.executions} EXECUTION`
    + `${evidence.summary.executions === 1 ? '' : 'S'} · `
    + `${evidence.summary.attempts} ATTEMPT${evidence.summary.attempts === 1 ? '' : 'S'}`;
}

/**
 * Roughly how many pages this renders to.
 *
 * An estimate and labelled as one on the card. A precise figure would need the
 * PDF toolchain that does not exist yet, and an approximate page count is more
 * useful to a reader deciding whether to open something than no count at all.
 */
export const pagesOf = (markdown: string): number => Math.max(1, Math.ceil(markdown.length / 3000));

function wrap(text: string, width: number): string[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ');
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (line.length + word.length + 1 > width) {
      if (line) lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}
