import {
  makeNodeId, type DiscoveryRun, type DiscoveryStage, type Evidence,
  type EvidenceInput, type Finding, type RepositoryProfile,
} from '@proteus/schema';
import type { Candidate, DetectionResult, DependencyFinding } from '../discovery/detect';
import type { EnvironmentFact } from '../discovery/environment';
import type { Repositories } from '../repositories';
import { buildGraph, componentName, componentType } from './graphBuilder';
import { GraphService } from './graph';

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

export interface CandidateLinks {
  evidenceIds: string[];
  findingIds: string[];
}

export interface PersistResult {
  findings: number;
  evidence: number;
  /** Keyed by candidate `dedupeKey`. */
  links: Map<string, CandidateLinks>;
}

export class DiscoveryService {
  private readonly graph: GraphService;

  constructor(private readonly repos: Repositories, graph?: GraphService) {
    this.graph = graph ?? new GraphService(repos);
  }

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
  ): Promise<PersistResult> {
    let findings = 0;
    let evidence = 0;
    // What each candidate produced, so the graph can cite it rather than
    // re-derive it. Keyed by dedupeKey because that is what identifies a
    // candidate across a re-run.
    const links = new Map<string, CandidateLinks>();
    const link = (key: string): CandidateLinks => {
      const existing = links.get(key);
      if (existing) return existing;
      const fresh: CandidateLinks = { evidenceIds: [], findingIds: [] };
      links.set(key, fresh);
      return fresh;
    };

    for (const c of result.candidates) {
      const evidenceId = await this.saveEvidence(projectId, c.evidence);
      evidence++;
      link(c.dedupeKey).evidenceIds.push(evidenceId);

      const existing = await this.repos.findings.findOne(
        { projectId, dedupeKey: c.dedupeKey } as never,
      );
      if (existing) {
        await this.repos.findings.collection.updateOne(
          { findingId: existing.findingId } as never,
          { $addToSet: { evidenceIds: evidenceId } as never, $set: { updatedAt: new Date() } as never },
        );
        link(c.dedupeKey).findingIds.push(existing.findingId);
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
        // The same derivation the graph builder uses, so the finding and the
        // node it points at cannot disagree about the component's name.
        nodeIds: [makeNodeId(componentType(c.path), componentName(c.path))],
        evidenceIds: [evidenceId],
        primaryEvidenceId: evidenceId,
        origin: 'REPOSITORY_SCAN',
        status: 'OPEN',
        dedupeKey: c.dedupeKey,
        discoveredAt: now,
      };
      await this.repos.findings.insert(finding);
      link(c.dedupeKey).findingIds.push(finding.findingId);
      findings++;
    }

    for (const d of dependencies) {
      if (d.capability.capability === 'SUPPORTED') continue;

      // A finding, not just a feed row. The provider version is the second of the
      // two autonomous items in the reference scenario (spec §17), and a
      // dependency that only ever appears in the activity feed cannot be
      // dispositioned, planned or approved.
      const dedupeKey = `dep:${d.dependencyName}:${d.version}`;
      const existingDep = await this.repos.findings.findOne({ projectId, dedupeKey } as never);
      if (!existingDep) {
        const at = new Date();
        const evidenceId = await this.saveEvidence(projectId, {
          evidenceType: 'DEPENDENCY', evidenceClass: 'OBSERVED', confidence: 1,
          source: `${d.path}:${d.line}`,
          locator: { kind: 'REPO', path: d.path, startLine: d.line, commitSha: '0000000' },
          excerpt: d.capability.reason,
        });
        await this.repos.findings.insert({
          _schemaVersion: 1, createdAt: at, updatedAt: at,
          findingId: `f_${projectId}_dep_${d.dependencyName.replace(/[^a-z0-9]/gi, '')}`,
          projectId,
          category: 'APPLICATION',
          title: `${d.dependencyName} ${d.version}`,
          summaryLine: d.capability.capability === 'NOT_SUPPORTED'
            ? `${d.dependencyName} ${d.version} → approved compatible version`
            : 'Provider capability not established',
          description: d.capability.reason,
          severity: d.capability.capability === 'NOT_SUPPORTED' ? 'HIGH' : 'MEDIUM',
          impact: d.capability.capability === 'NOT_SUPPORTED'
            ? 'MIGRATION_LIKELY' : 'DEPENDENCY_REQUIRES_INVESTIGATION',
          disposition: 'NEEDS_FURTHER_INVESTIGATION',
          agentIntent: 'Pending assessment.',
          locations: [{ path: d.path, startLine: d.line }],
          nodeIds: [makeNodeId('CRYPTO_LIBRARY', `${d.dependencyName} ${d.version}`)],
          evidenceIds: [evidenceId],
          primaryEvidenceId: evidenceId,
          origin: 'REPOSITORY_SCAN',
          status: 'OPEN',
          dedupeKey,
          discoveredAt: at,
        } as never);
      }

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
    return { findings, evidence, links };
  }

  /**
   * Builds the graph from what the scan established.
   *
   * Runs after the findings are persisted so every node can cite a finding id
   * that already exists — a node pointing at nothing would break the inspector
   * panel, which resolves its evidence list on open.
   */
  async buildGraph(
    run: DiscoveryRun,
    input: {
      profile: RepositoryProfile;
      repositoryName: string;
      candidates: Candidate[];
      dependencies: DependencyFinding[];
      environment?: EnvironmentFact[];
      links: Map<string, CandidateLinks>;
    },
  ): Promise<{ nodes: number; edges: number }> {
    await this.advance(run, 'BUILDING_GRAPH');

    await buildGraph(this.graph, {
      projectId: run.projectId,
      profile: input.profile,
      repositoryName: input.repositoryName,
      candidates: input.candidates,
      dependencies: input.dependencies,
      environment: input.environment,
      saveEvidence: (e) => this.saveEvidence(run.projectId, e),
      evidenceFor: (c) => input.links.get(c.dedupeKey)?.evidenceIds ?? [],
      findingFor: (c) => input.links.get(c.dedupeKey)?.findingIds ?? [],
      onCreated: async (kind, id, label) => {
        await this.repos.events.emit(run.projectId, {
          type: kind === 'NODE' ? 'GRAPH_NODE_ADDED' : 'GRAPH_RELATIONSHIP_ADDED',
          phase: 'DISCOVERY',
          // The canvas animates on these, so they are ACTIVITY rather than
          // DETAIL: a filtered feed that hides them would leave the graph
          // growing with nothing in the feed to explain why.
          level: 'ACTIVITY', severity: 'INFO',
          title: kind === 'NODE' ? `Graph node: ${label}` : `Graph relationship: ${label}`,
          actor: 'AGENT', refs: kind === 'NODE' ? { nodeId: id } : { edgeId: id },
          stage: 'BUILDING_GRAPH',
        });
      },
    });

    // `graphVersion` is bumped by the upserts themselves (FR-9), not here — a
    // second bump per build would make the counter mean two different things.
    const counts = await this.graph.counts(run.projectId);
    await this.repos.projects.collection.updateOne({ projectId: run.projectId } as never, {
      $set: {
        'summary.counts.graphNodes': counts.nodes,
        'summary.counts.graphEdges': counts.edges,
      } as never,
    });
    return counts;
  }

  /**
   * Findings for the cryptography a repository declares rather than calls.
   *
   * The graph already shows these; the findings list must too, or the assessment
   * silently omits the certificate and the partner boundary — two of the items a
   * PQC reviewer is specifically looking for. It also makes EXEC-DISP-006 and
   * EXEC-DISP-008 reachable: a disposition rule keyed on a node type needs a
   * finding pointing at that node to run against.
   */
  async persistEnvironment(
    projectId: string,
    facts: EnvironmentFact[],
  ): Promise<{ findings: number }> {
    let written = 0;

    for (const f of facts) {
      const dedupeKey = `env:${f.kind}:${f.name}`;
      const existing = await this.repos.findings.findOne({ projectId, dedupeKey } as never);
      const evidenceId = await this.saveEvidence(projectId, f.evidence);

      if (existing) {
        await this.repos.findings.collection.updateOne(
          { findingId: existing.findingId } as never,
          { $addToSet: { evidenceIds: evidenceId } as never, $set: { updatedAt: new Date() } as never },
        );
        continue;
      }

      const now = new Date();
      const nodeId = makeNodeId(f.kind, f.name);
      await this.repos.findings.insert({
        _schemaVersion: 1, createdAt: now, updatedAt: now,
        findingId: `f_${projectId}_env_${f.kind.toLowerCase()}_${written}`,
        projectId,
        category: f.kind === 'CERTIFICATE' ? 'CRYPTOGRAPHIC' : 'APPLICATION',
        title: f.kind === 'CERTIFICATE'
          ? `Certificate ${f.name}`
          : f.kind === 'PROTOCOL' ? `Transport protocol ${f.name}` : `External boundary ${f.name}`,
        summaryLine: f.detail || f.kind.replace(/_/g, ' ').toLowerCase(),
        description: f.note,
        // The usage is what makes the disposition rules reachable, and it is
        // read from the file rather than assumed: a certificate is validated, a
        // protocol establishes keys, a boundary is where one is handed over.
        crypto: f.kind === 'CERTIFICATE'
          ? { algorithm: f.detail.split(' · ')[0] ?? 'unknown', usage: 'CERTIFICATE_VALIDATION',
              quantumVulnerable: f.quantumVulnerable }
          : f.kind === 'PROTOCOL'
          ? { algorithm: f.name, usage: 'KEY_ESTABLISHMENT', quantumVulnerable: f.quantumVulnerable }
          : undefined,
        severity: f.quantumVulnerable ? 'MEDIUM' : 'INFO',
        impact: f.quantumVulnerable ? 'MIGRATION_LIKELY' : 'NO_PQC_CHANGE_REQUIRED',
        disposition: 'NEEDS_FURTHER_INVESTIGATION',
        agentIntent: 'Pending assessment.',
        locations: [{ path: f.path, startLine: f.line }],
        nodeIds: [nodeId],
        evidenceIds: [evidenceId],
        primaryEvidenceId: evidenceId,
        origin: 'REPOSITORY_SCAN',
        status: 'OPEN',
        dedupeKey,
        discoveredAt: now,
      } as never);
      written++;
    }

    if (written > 0) {
      await this.repos.projects.collection.updateOne({ projectId } as never, {
        $set: { 'summary.counts.findings': await this.repos.findings.count({ projectId } as never) } as never,
      });
    }
    return { findings: written };
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

  /**
   * Ends a run that could not finish.
   *
   * The project moves to FAILED rather than staying ANALYZING forever: a run
   * that is quietly stuck is worse than one that says it broke, because nobody
   * goes looking for it.
   */
  async fail(run: DiscoveryRun, reason: string): Promise<void> {
    const at = new Date();
    await this.repos.discoveryRuns.patch({ discoveryRunId: run.discoveryRunId } as never, {
      status: 'FAILED', completedAt: at, updatedAt: at, error: reason.slice(0, 2000),
    } as never);
    await this.repos.projects.transition(run.projectId, 'ANALYZING', 'FAILED').catch(() => undefined);
    await this.repos.events.emit(run.projectId, {
      type: 'DISCOVERY_FAILED', phase: 'DISCOVERY', level: 'MILESTONE', severity: 'ERROR',
      title: 'Discovery failed', message: reason.slice(0, 2000),
      actor: 'SYSTEM', refs: {}, stage: run.stage,
    });
    await this.repos.discoveryLease.release(run.discoveryRunId, 'any').catch(() => undefined);
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
