import type {
  Assessment, Evidence, Finding, GraphEdge, GraphNode, Project, ProjectFile, Recommendation,
} from '@proteus/schema';
import { AssessmentAgent, type FindingBrief } from '../agent/flows/assessment';
import type { ModelClient } from '../agent/model';
import type { RuleEngine } from '../core/rules/engine';
import type { Repositories } from '../core/repositories';
import type { ApprovalService } from '../core/services/approval';
import { AssessmentService, PlanValidationError } from '../core/services/assessment';
import { DispositionService } from '../core/services/dispositions';
import { ensurePolicy } from '../core/services/policy';
import type { BlobStore } from '../integrations/storage/blobs';
import { buildSnapshot, renderMarkdown } from '../reports/assessment';
import type { Logger } from '../config/logger';
import { AgentActionRecorder } from '../core/services/agentActions';
import { recordingModel } from '../agent/model';

/**
 * The assessment job.
 *
 * Rules first, model second, validation third, persistence last. The order is
 * the product's central claim: by the time A2 is asked anything, every
 * disposition is already fixed by a rule that can be cited, and the model is
 * only writing the words around decisions it did not make.
 */

export interface AssessmentJobDeps {
  repos: Repositories;
  engine: RuleEngine;
  model: ModelClient;
  blobs: BlobStore;
  /** Opens the approval gate once the assessment is ready. */
  approvals: ApprovalService;
  logger: Logger;
}

export async function runAssessment(
  project: Project,
  deps: AssessmentJobDeps,
): Promise<Assessment> {
  const { repos, engine } = deps;
  const model = recordingModel(deps.model, (r) => new AgentActionRecorder(
    repos, deps.blobs, { projectId: project.projectId },
  ).record(r));
  const log = deps.logger.child({ projectId: project.projectId, job: 'assessment' });

  const dispositions = new DispositionService(repos, engine);
  const assessments = new AssessmentService(repos);
  const agent = new AssessmentAgent(model);

  const policyId = await ensurePolicy(repos, engine);

  // 1. Rules. Nothing the model says can move a finding across this line.
  const pass = await dispositions.run(project.projectId);
  if (pass.undecided.length > 0) {
    // Not fatal: a finding no rule reached is left OPEN and reported, which is
    // more honest than inventing a disposition for it.
    log.warn({ undecided: pass.undecided }, 'findings no disposition rule matched');
  }

  const [findings, nodes, edges, evidence, files] = await Promise.all([
    repos.findings.find({ projectId: project.projectId } as never) as unknown as Promise<Finding[]>,
    repos.graphNodes.find({ projectId: project.projectId } as never) as unknown as Promise<GraphNode[]>,
    repos.graphEdges.find({ projectId: project.projectId } as never) as unknown as Promise<GraphEdge[]>,
    repos.evidence.find({ projectId: project.projectId } as never) as unknown as Promise<Evidence[]>,
    repos.projectFiles.find({ projectId: project.projectId } as never) as unknown as Promise<ProjectFile[]>,
  ]);

  const evidenceById = new Map(evidence.map((e) => [e.evidenceId, e]));
  const decisionFor = new Map(pass.decisions.map((d) => [d.findingId, d]));

  const briefs: FindingBrief[] = findings
    .filter((f) => decisionFor.has(f.findingId))
    .map((f) => {
      const d = decisionFor.get(f.findingId)!;
      return {
        finding: f,
        disposition: d.disposition,
        dispositionRuleId: d.ruleId,
        target: d.target
          ? {
              target: d.target.target,
              parameterSet: d.target.parameterSet,
              rationale: d.target.ruleIds.join(', '),
            }
          : undefined,
        evidence: f.evidenceIds
          .map((id) => evidenceById.get(id))
          .filter((e): e is Evidence => Boolean(e))
          .map((e) => ({
            evidenceClass: e.evidenceClass, evidenceType: e.evidenceType,
            source: e.source, excerpt: e.excerpt,
          })),
        nodes: nodes.filter((n) => f.nodeIds.includes(n.nodeId)),
      };
    });

  // 2. The model. Three narrow questions, none of them about scope.
  const narratives = await agent.narrate(briefs);
  const planItems = await agent.plan(briefs);
  const recommendationActions = await agent.recommend(
    pass.seeds.map((s) => ({
      findingId: s.findingId, name: s.name, disposition: s.disposition,
      subtype: s.subtype, owner: s.owner, citation: s.sourceCitation,
    })),
  );
  const summary = await agent.summarise(briefs, planItems, project.repository.url);

  // 3 and 4. Validate and persist. `generate` rejects rather than corrects.
  let assessment: Assessment;
  try {
    assessment = await assessments.generate({
      projectId: project.projectId,
      commitSha: project.repository.baseCommitSha ?? '0'.repeat(40),
      policyId, pass, summary, narratives,
      planItems: planItems.map((p) => ({ ...p })),
      recommendationActions,
    });
  } catch (e) {
    if (e instanceof PlanValidationError) {
      // The overreach is the news, not a detail. Logged in full and surfaced as
      // an event, because a silently-narrowed plan is exactly what this product
      // exists not to produce.
      log.error({ violations: e.violations }, 'A2 proposed work the dispositions forbid');
      await repos.events.emit(project.projectId, {
        type: 'MIGRATION_BLOCKER_IDENTIFIED', phase: 'ASSESSMENT',
        level: 'MILESTONE', severity: 'ERROR',
        title: 'Assessment rejected — proposed plan exceeded the approved dispositions',
        message: e.violations.join('\n'),
        actor: 'SYSTEM', refs: {},
      });
    }
    throw e;
  }

  // The gate. Everything above is preparation; this is the moment the product
  // stops and asks (spec §20).
  //
  // Modelled as a HumanGate rather than a stage flag, so the single up-front
  // approval and every mid-migration pause share one shape, one endpoint and one
  // audit record. The gate carries the disclosure it was opened with; the
  // approval carries what was acknowledged.
  await repos.projects.transition(project.projectId, 'ASSESSMENT_READY', 'AWAITING_APPROVAL');
  await deps.approvals.openApprovalGate(project.projectId, assessment);

  /**
   * The report is written after the gate, and its failure does not end the run.
   *
   * It used to run first, and a bucket that rejected the write left the project
   * at ASSESSMENT_READY for ever: the assessment existed, the findings existed,
   * and the product never asked the question it exists to ask. A downloadable
   * artifact is not worth an unasked approval.
   *
   * Not silent, though — the failure becomes an event, so the report's absence
   * is visible on the screen that would have offered it, and regenerating the
   * assessment produces it again.
   */
  try {
    await writeReport(project, assessment, deps, { nodes, edges, files });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    log.error({ err: e }, 'assessment report could not be written');
    await repos.events.emit(project.projectId, {
      type: 'ASSESSMENT_COMPLETED', phase: 'ASSESSMENT', level: 'DETAIL', severity: 'WARN',
      title: 'Assessment report could not be stored',
      message: `${reason} — the assessment itself is complete and the gate is open.`,
      actor: 'SYSTEM', refs: {},
    }).catch(() => undefined);
  }

  return assessment;
}

/** Renders and stores the downloadable report (spec §19). */
async function writeReport(
  project: Project,
  assessment: Assessment,
  deps: AssessmentJobDeps,
  ctx: { nodes: GraphNode[]; edges: GraphEdge[]; files: ProjectFile[] },
): Promise<void> {
  const { repos, blobs } = deps;

  // Read back through the snapshot, not the live collections: the report must
  // render exactly the membership the assessment froze.
  const [findings, recommendations, evidence] = await Promise.all([
    repos.findings.collection
      .find({ findingId: { $in: assessment.snapshot.findingIds } } as never)
      .toArray() as unknown as Promise<Finding[]>,
    repos.recommendations.collection
      .find({ recommendationId: { $in: assessment.snapshot.recommendationIds } } as never)
      .toArray() as unknown as Promise<Recommendation[]>,
    repos.evidence.find({ projectId: project.projectId } as never) as unknown as Promise<Evidence[]>,
  ]);

  const snapshot = buildSnapshot({
    project, assessment, findings, evidence,
    nodes: ctx.nodes.filter((n) => assessment.snapshot.graphNodeIds.includes(n.nodeId)),
    edges: ctx.edges.filter((e) => assessment.snapshot.graphEdgeIds.includes(e.edgeId)),
    recommendations, files: ctx.files,
  });

  const markdown = renderMarkdown(snapshot);
  const body = Buffer.from(markdown, 'utf8');
  const path = `${project.projectId}/reports/assessment-v${assessment.version}.md`;
  const stored = await blobs.put(path, body, 'text/markdown');

  const artifactId = `art_${project.projectId}_asmt_v${assessment.version}`;
  const now = new Date();
  await repos.artifacts.insert({
    _schemaVersion: 1, createdAt: now, updatedAt: now,
    artifactId, projectId: project.projectId,
    kind: 'ASSESSMENT_REPORT', format: 'MARKDOWN',
    title: `Assessment report v${assessment.version}`,
    displayMeta: `${findings.length} FINDINGS · ${assessment.planItems.length} PLAN ITEMS · `
      + `${recommendations.length} RECOMMENDATIONS`,
    stats: { pages: Math.max(1, Math.ceil(markdown.length / 3000)) },
    assessmentId: assessment.assessmentId,
    gcsUri: stored.gcsUri,
    sizeBytes: stored.sizeBytes,
    // Stored so the same bytes can be re-rendered in another format later
    // without re-reading collections that have since moved on.
    contentSnapshot: snapshot as unknown as Record<string, unknown>,
    status: 'READY',
    generatedAt: now,
  });

  await repos.assessments.collection.updateOne(
    { assessmentId: assessment.assessmentId } as never,
    { $set: { artifactId, updatedAt: now } as never },
  );
}
