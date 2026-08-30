import { randomUUID } from 'node:crypto';
import type { Project } from '@proteus/schema';
import { DiscoveryAgent, usageEvent } from '../agent/flows/discovery';
import type { ModelClient } from '../agent/model';
import { detect, detectDependencies, type Candidate } from '../core/discovery/detect';
import { detectEnvironment } from '../core/discovery/environment';
import { detectProfile } from '../core/discovery/profile';
import { WorkingCopy } from '../core/discovery/workingCopy';
import type { RuleEngine } from '../core/rules/engine';
import type { Repositories } from '../core/repositories';
import { DiscoveryService } from '../core/services/discovery';
import { GraphService } from '../core/services/graph';
import type { ProjectService } from '../core/services/projects';
import { GitHubReader, parseRepositoryUrl, permalink } from '../integrations/github/client';
import type { Logger } from '../config/logger';
import { AgentActionRecorder } from '../core/services/agentActions';
import { recordingModel } from '../agent/model';

/**
 * The discovery job — clone, scan, reason, persist, graph.
 *
 * The sequence lives here rather than inside the agent because it must survive
 * an evicted worker: every stage checkpoints, and a loop inside model reasoning
 * cannot be resumed. The agent is asked three questions along the way and
 * decides nothing about what happens next.
 *
 * `worker/` is the only place allowed to depend on both `core/` and `agent/` —
 * that is what it is for, and the architecture test holds the other layers to it.
 */

export interface DiscoveryJobDeps {
  repos: Repositories;
  projects: ProjectService;
  engine: RuleEngine;
  model: ModelClient;
  github?: GitHubReader;
  logger: Logger;
  /**
   * Runs after discovery completes. Injected rather than called directly so a
   * test can exercise discovery without a model, and so the two jobs stay
   * separately runnable — a re-assessment must not require a re-clone.
   */
  onComplete?: (project: Project) => Promise<void>;
}

export async function runDiscovery(project: Project, deps: DiscoveryJobDeps): Promise<void> {
  const { repos, projects, engine } = deps;
  const model = recordingModel(deps.model, (r) => new AgentActionRecorder(
    repos, undefined, { projectId: project.projectId },
  ).record(r));
  const github = deps.github ?? new GitHubReader();
  const discovery = new DiscoveryService(repos, new GraphService(repos));
  const agent = new DiscoveryAgent(model);
  const log = deps.logger.child({ projectId: project.projectId, job: 'discovery' });

  const run = await discovery.start(project.projectId, `worker-${randomUUID().slice(0, 8)}`);
  let checkout: Awaited<ReturnType<GitHubReader['checkout']>> | null = null;

  try {
    await discovery.advance(run, 'CLONING', `Cloning ${project.repository.url}`);
    const token = await projects.credentialFor(project.projectId);
    checkout = await github.checkout(project.repository.url, token);

    const wc = new WorkingCopy(checkout.dir);
    const ref = parseRepositoryUrl(project.repository.url);
    const linkFor = (path: string, line: number) =>
      permalink(ref, checkout!.commitSha, path, line);

    await discovery.advance(run, 'INSPECTING_STRUCTURE', 'Reading the build manifest');
    const profile = await detectProfile(wc);
    await repos.projects.collection.updateOne({ projectId: project.projectId } as never, {
      $set: { 'repository.baseCommitSha': checkout.commitSha, 'repository.profile': profile } as never,
    });
    await repos.events.emit(project.projectId, {
      type: 'REPOSITORY_CLONED', phase: 'DISCOVERY', level: 'MILESTONE', severity: 'INFO',
      title: `${profile.language} · ${profile.buildSystem} · ${profile.framework ?? 'no framework detected'}`,
      message: `${profile.fileCount ?? 0} files at ${checkout.commitSha.slice(0, 7)}`,
      actor: 'TOOL', refs: {}, stage: 'INSPECTING_STRUCTURE',
    });

    await discovery.advance(run, 'SCANNING_CRYPTO', 'Scanning source for cryptography');
    const result = await detect(engine, wc, checkout.commitSha, linkFor);
    await discovery.reportProgress(run, result.filesScanned, result.filesScanned);

    await discovery.advance(run, 'ANALYZING_DEPENDENCIES', 'Reading dependency versions');
    const dependencies = await detectDependencies(wc);

    await discovery.advance(run, 'ANALYZING_DOCUMENTS', 'Reading configuration and certificates');
    const environment = await detectEnvironment(wc, checkout.commitSha);

    // The three questions a scanner cannot answer. Everything above is settled
    // before the model is consulted at all.
    await discovery.advance(run, 'CORRELATING', 'Resolving ambiguous cryptographic usage');
    const excerptFor = (c: Candidate) => c.evidence.excerpt ?? c.matchedText;
    const usages = await agent.resolveUsages(result.candidates, excerptFor, checkout.commitSha);
    for (const d of usages) {
      const evidenceId = await discovery.saveEvidence(project.projectId, d.evidence);
      await repos.events.emit(project.projectId, {
        ...usageEvent(d), refs: { evidenceIds: [evidenceId] }, stage: 'CORRELATING',
      });
      // The agent's answer refines the candidate it was asked about; it never
      // adds one the scanner did not find.
      if (d.usage !== 'UNKNOWN') d.candidate.usage = d.usage;
    }

    const { links } = await discovery.persistCandidates(project.projectId, result, dependencies);
    await discovery.persistEnvironment(project.projectId, environment);

    await discovery.buildGraph(run, {
      profile,
      repositoryName: ref.repo,
      candidates: result.candidates,
      dependencies,
      environment,
      links,
    });

    await discovery.advance(run, 'GENERATING_ASSESSMENT', 'Checking the evidence is sufficient');
    const verdict = await agent.isSufficient(result.candidates, dependencies, result.filesScanned);
    await discovery.complete(run, verdict.reasoning);

    // Assessment follows immediately: spec §13 hands over without asking, and
    // the one human gate is at approval, not here.
    await deps.onComplete?.(project);
  } catch (e) {
    log.error({ err: e }, 'discovery failed');
    await discovery.fail(run, e instanceof Error ? e.message : String(e));
  } finally {
    await checkout?.dispose().catch(() => undefined);
  }
}
