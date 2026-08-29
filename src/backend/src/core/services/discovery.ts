import {
  makeNodeId, type DiscoveryRun, type DiscoveryStage, type Evidence,
  type EvidenceInput, type Finding,
} from '@proteus/schema';
import type { Candidate, DetectionResult, DependencyFinding } from '../discovery/detect';
import type { Repositories } from '../repositories';

/**
 * The discovery run.
 *
 * The orchestration lives here rather than inside the agent, for the same reason
 * the migration loop will: a run must survive an evicted worker, and a loop
 * inside model reasoning cannot be checkpointed, resumed or bounded.
 *
 * `core/` must not import `agent/` — the architecture test enforces it — so the
 * agent's decisions arrive as plain data through `applyDecisions`.
 */

export const DISCOVERY_STAGES: DiscoveryStage[] = [
  'QUEUED', 'CLONING', 'INSPECTING_STRUCTURE', 'SCANNING_CRYPTO',
  'ANALYZING_DEPENDENCIES', 'ANALYZING_DOCUMENTS', 'CORRELATING',
  'BUILDING_GRAPH', 'GENERATING_ASSESSMENT', 'COMPLETED',
];

/** Percent complete, derived from position in the pipeline. */
export function stageProgress(stage: DiscoveryStage): number {
  const i = DISCOVERY_STAGES.indexOf(stage);
  if (i < 0) return 0;
  return Math.round((i / (DISCOVERY_STAGES.length - 1)) * 100);
}

export class DiscoveryService {
  constructor(private readonly repos: Repositories) {}

  async start(projectId: string, holder: string): Promise<DiscoveryRun> {
    const now = new Date();
    const run: DiscoveryRun = {
      _schemaVersion: 1, createdAt: now, updatedAt: now,
      discoveryRunId: `disc_${projectId}_${now.getTime().toString(36)}`,
      projectId,
      stage: 'QUEUED', stageEnteredAt: now, status: 'RUNNING',
      progress: { filesTotal: null, filesAnalyzed: 0, percent: 0 },
      startedAt: now,
      checkpoint: { stage: 'QUEUED', at: now },
    };
    await this.repos.discoveryRuns.insert(run);

    // Refused if another worker already holds it — a double-clicked create or a
    // scale-out cannot produce two runs against one project.
    const acquired = await this.repos.discoveryLease.acquire(run.discoveryRunId, holder);
    if (!acquired) throw new Error(`discovery run ${run.discoveryRunId} is already held`);

    await this.repos.projects.transition(projectId, 'CREATED', 'ANALYZING', {
      current: { discoveryRunId: run.discoveryRunId },
    } as never);
    await this.repos.events.emit(projectId, {
      type: 'SOURCE_ANALYSIS_STARTED', phase: 'DISCOVERY', level: 'MILESTONE',
      severity: 'INFO', title: 'Discovery started', actor: 'SYSTEM', refs: {},
      stage: 'QUEUED',
    });
    return run;
  }

  /** Advances a stage and writes the checkpoint an evicted worker resumes from. */
  async advance(run: DiscoveryRun, stage: DiscoveryStage, note?: string): Promise<void> {
    const at = new Date();
    await this.repos.discoveryRuns.patch({ discoveryRunId: run.discoveryRunId } as never, {
      stage, stageEnteredAt: at, updatedAt: at,
      checkpoint: { stage, at },
      progress: { ...run.progress, percent: stageProgress(stage) },
    } as never);
    run.stage = stage;
    run.progress.percent = stageProgress(stage);

    if (note) {
      await this.repos.events.emit(run.projectId, {
        type: 'FILE_ANALYZED', phase: 'DISCOVERY', level: 'ACTIVITY', severity: 'INFO',
        title: note, actor: 'AGENT', refs: {}, stage,
      });
    }
  }

  async reportProgress(run: DiscoveryRun, filesAnalyzed: number, filesTotal: number): Promise<void> {
    await this.repos.discoveryRuns.patch({ discoveryRunId: run.discoveryRunId } as never, {
      progress: { filesTotal, filesAnalyzed, percent: stageProgress(run.stage) },
      updatedAt: new Date(),
    } as never);
    run.progress = { filesTotal, filesAnalyzed, percent: stageProgress(run.stage) };
  }

  /** Where a restarted worker picks up. */
  async resumePoint(projectId: string): Promise<DiscoveryStage | null> {
    const run = await this.repos.discoveryRuns.findOne(
      { projectId, status: 'RUNNING' } as never,
    );
    return run?.checkpoint.stage ?? null;
  }

  /**
   * Persists what the deterministic scan found.
   *
   * Findings are upserted on `dedupeKey`, so a re-run enriches rather than
   * duplicates — the same discipline the graph uses for node identity.
   */
  async persistCandidates(
    projectId: string,
    result: DetectionResult,
    dependencies: DependencyFinding[],
  ): Promise<{ findings: number; evidence: number }> {
    let findings = 0;
    let evidence = 0;

    for (const c of result.candidates) {
      const evidenceId = await this.saveEvidence(projectId, c.evidence);
      evidence++;

      const existing = await this.repos.findings.findOne(
        { projectId, dedupeKey: c.dedupeKey } as never,
      );
      if (existing) {
        await this.repos.findings.collection.updateOne(
          { findingId: existing.findingId } as never,
          { $addToSet: { evidenceIds: evidenceId } as never, $set: { updatedAt: new Date() } as never },
        );
        continue;
      }

      const now = new Date();
      const finding: Finding = {
        _schemaVersion: 1, createdAt: now, updatedAt: now,
        findingId: `f_${projectId}_${c.dedupeKey.slice(0, 24).replace(/[^a-z0-9]/gi, '')}_${findings}`,
        projectId,
        category: c.usage === 'DIGITAL_SIGNATURE' ? 'CRYPTOGRAPHIC' : 'CRYPTOGRAPHIC',
        title: `${c.algorithm ?? 'Cryptography'} at ${c.path.split('/').pop()}`,
        summaryLine: c.usage === 'UNKNOWN'
          ? 'Usage not determined — requires investigation'
          : `Usage: ${c.usage.replace(/_/g, ' ').toLowerCase()}`,
        description: `Found by ${c.ruleId} at ${c.path}:${c.line}.`,
        crypto: c.algorithm
          ? { algorithm: c.algorithm, usage: c.usage, quantumVulnerable: c.quantumVulnerable }
          : undefined,
        severity: c.severity,
        impact: c.quantumVulnerable ? 'MIGRATION_REQUIRED' : 'NO_PQC_CHANGE_REQUIRED',
        // Disposition is assigned by the rules in PRD-09, not guessed here.
        disposition: 'NEEDS_FURTHER_INVESTIGATION',
        agentIntent: 'Pending assessment.',
        locations: [{ path: c.path, startLine: c.line }],
        nodeIds: [makeNodeId('SOURCE_COMPONENT', c.path.split('/').pop() ?? c.path)],
        evidenceIds: [evidenceId],
        primaryEvidenceId: evidenceId,
        origin: 'REPOSITORY_SCAN',
        status: 'OPEN',
        dedupeKey: c.dedupeKey,
        discoveredAt: now,
      };
      await this.repos.findings.insert(finding);
      findings++;
    }

    for (const d of dependencies) {
      if (d.capability.capability === 'SUPPORTED') continue;
      await this.repos.events.emit(projectId, {
        type: 'DEPENDENCY_DISCOVERED', phase: 'DISCOVERY', level: 'ACTIVITY',
        severity: d.capability.capability === 'UNKNOWN' ? 'WARN' : 'INFO',
        title: `${d.dependencyName} ${d.version}`,
        message: d.capability.reason,
        actor: 'TOOL', refs: { paths: [d.path] }, stage: 'ANALYZING_DEPENDENCIES',
      });
    }

    await this.repos.projects.collection.updateOne({ projectId } as never, {
      $set: { 'summary.counts.findings': await this.repos.findings.count({ projectId } as never) } as never,
    });
    return { findings, evidence };
  }

  async saveEvidence(projectId: string, input: EvidenceInput): Promise<string> {
    const now = new Date();
    const evidenceId = `ev_${projectId}_${now.getTime().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const doc: Evidence = {
      _schemaVersion: 1, createdAt: now, updatedAt: now,
      evidenceId, projectId, observedAt: now,
      ...input,
      producedBy: input.evidenceClass === 'OBSERVED'
        ? { actor: 'TOOL', toolName: 'scan_crypto' }
        : { actor: 'MODEL' },
    };
    await this.repos.evidence.insert(doc);
    return evidenceId;
  }

  /** Ends the run and hands over to assessment (spec §13). */
  async complete(run: DiscoveryRun, reasoning: string): Promise<void> {
    const at = new Date();
    await this.repos.discoveryRuns.patch({ discoveryRunId: run.discoveryRunId } as never, {
      stage: 'COMPLETED', status: 'COMPLETED', completedAt: at, updatedAt: at,
      checkpoint: { stage: 'COMPLETED', at },
      progress: { ...run.progress, percent: 100 },
    } as never);

    // The transition carries no summary patch: `$set: { summary: undefined }`
    // would replace the whole projection, and the dotted update below would then
    // have nothing to write into.
    await this.repos.projects.transition(run.projectId, 'ANALYZING', 'ASSESSMENT_READY');
    await this.repos.projects.collection.updateOne({ projectId: run.projectId } as never, {
      $set: {
        'summary.discoveryComplete': true,
        'summary.lastActivityAt': at,
        'summary.lastActivityText': 'Discovery complete — assessment ready',
      } as never,
    });

    await this.repos.events.emit(run.projectId, {
      type: 'ASSESSMENT_COMPLETED', phase: 'DISCOVERY', level: 'MILESTONE', severity: 'SUCCESS',
      title: 'Discovery complete — assessment and proposed migration plan generated',
      message: reasoning, actor: 'AGENT', refs: {}, stage: 'COMPLETED',
    });
    await this.repos.discoveryLease.release(run.discoveryRunId, 'any').catch(() => undefined);
  }
}
