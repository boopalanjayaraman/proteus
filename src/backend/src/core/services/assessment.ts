import {
  AUTONOMOUS_PLAN_MODES,
  type Assessment, type Evidence, type Finding, type GraphEdge, type GraphNode,
  type PlanItem, type PlanItemMode, type Recommendation,
} from '@proteus/schema';
import type { Repositories } from '../repositories';
import type { DispositionPass, RecommendationSeed } from './dispositions';

/**
 * The assessment, assembled and frozen.
 *
 * Two properties do the work here. It is immutable — regenerating writes version
 * N+1 and supersedes its predecessor, so the migration is always auditable
 * against exactly the scope a human approved. And every plan item is validated
 * against its findings' dispositions before anything is written: a violating
 * item is rejected, never corrected, because silently repairing a model's
 * overreach would hide the overreach.
 */

/** Which plan modes a disposition permits. The autonomy boundary, as a table. */
const PERMITTED: Record<string, readonly PlanItemMode[]> = {
  AUTONOMOUS_MIGRATION: AUTONOMOUS_PLAN_MODES,
  ASSISTED_MIGRATION: ['TEST_ENVIRONMENT_ADAPTATION', 'ASSISTED_MIGRATION'],
  NO_CHANGE_REQUIRED: ['NO_AUTONOMOUS_CHANGE'],
  VENDOR_DEPENDENCY: ['NO_AUTONOMOUS_CHANGE'],
  HARDWARE_REPLACEMENT: ['NO_AUTONOMOUS_CHANGE'],
  HUMAN_DECISION_REQUIRED: ['NO_AUTONOMOUS_CHANGE'],
  NEEDS_FURTHER_INVESTIGATION: ['NO_AUTONOMOUS_CHANGE'],
};

export class ApprovedAssessmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApprovedAssessmentError';
  }
}

export class PlanValidationError extends Error {
  constructor(readonly violations: string[]) {
    super(`plan rejected: ${violations.join('; ')}`);
    this.name = 'PlanValidationError';
  }
}

export interface ProposedPlanItem {
  targetName: string;
  findingIds: string[];
  mode: PlanItemMode;
  action: string;
  rationale: string;
  expectedChanges: Array<{ changeType: PlanItem['expectedChanges'][number]['changeType']; paths: string[]; description: string }>;
  conditions: string[];
  risk: 'LOW' | 'MEDIUM' | 'HIGH';
}

export interface AssessmentInput {
  projectId: string;
  commitSha: string;
  policyId: string;
  pass: DispositionPass;
  summary: Assessment['summary'];
  narratives: Array<{ findingId: string; title: string; summaryLine: string; description: string; agentIntent: string }>;
  planItems: ProposedPlanItem[];
  recommendationActions: Array<{ findingId: string; action: string }>;
}

/**
 * Rejects any plan item the dispositions do not authorise.
 *
 * Every clause is a separate way a model could quietly widen its own remit, so
 * each is reported separately rather than collapsed into one failure.
 */
export function validatePlan(
  items: ProposedPlanItem[],
  pass: DispositionPass,
): string[] {
  const byFinding = new Map(pass.decisions.map((d) => [d.findingId, d]));
  const suppressed = new Set(
    pass.decisions.filter((d) => d.suppressedBy?.length).map((d) => d.findingId),
  );
  const violations: string[] = [];

  for (const item of items) {
    if (item.findingIds.length === 0) {
      violations.push(`"${item.targetName}" cites no finding`);
      continue;
    }
    for (const findingId of item.findingIds) {
      const decision = byFinding.get(findingId);
      if (!decision) {
        violations.push(`"${item.targetName}" cites unknown finding ${findingId}`);
        continue;
      }
      const permitted = PERMITTED[decision.disposition] ?? [];
      if (!permitted.includes(item.mode)) {
        violations.push(
          `"${item.targetName}" proposes ${item.mode} for ${findingId}, `
          + `which is dispositioned ${decision.disposition} by ${decision.ruleId}`,
        );
      }
      // FR-3: a prohibition outranks the plan regardless of what the model wrote.
      if (suppressed.has(findingId) && item.mode !== 'NO_AUTONOMOUS_CHANGE') {
        violations.push(
          `"${item.targetName}" acts on ${findingId}, suppressed by `
          + `${byFinding.get(findingId)?.suppressedBy?.join(', ')}`,
        );
      }
    }
    // FR-6: an item that will change something must say what.
    if (
      (AUTONOMOUS_PLAN_MODES as readonly string[]).includes(item.mode)
      && item.expectedChanges.length === 0
    ) {
      violations.push(`"${item.targetName}" is ${item.mode} but declares no expected changes`);
    }
  }
  return violations;
}

export class AssessmentService {
  constructor(private readonly repos: Repositories) {}

  /** The current assessment, or null before one exists. */
  async current(projectId: string): Promise<Assessment | null> {
    const rows = await this.repos.assessments.collection
      .find({ projectId } as never).sort({ version: -1 }).limit(1).toArray();
    return (rows[0] as Assessment | undefined) ?? null;
  }

  async version(projectId: string, v: number): Promise<Assessment | null> {
    return this.repos.assessments.findOne({ projectId, version: v } as never);
  }

  async history(projectId: string): Promise<Assessment[]> {
    return this.repos.assessments.collection
      .find({ projectId } as never).sort({ version: 1 }).toArray() as unknown as Promise<Assessment[]>;
  }

  /**
   * Writes an assessment.
   *
   * Order is deliberate: validate, then narratives, then recommendations, then
   * the assessment itself. The assessment's snapshot names recommendation ids,
   * so they must exist before it is frozen.
   */
  async generate(input: AssessmentInput): Promise<Assessment> {
    const violations = validatePlan(input.planItems, input.pass);
    if (violations.length > 0) throw new PlanValidationError(violations);

    const { projectId } = input;

    // An approved assessment is final. Writing version N+1 would mark it
    // SUPERSEDED, and the migration would then be running against a scope
    // nothing on screen still claims a human agreed to.
    const approved = await this.repos.assessments.findOne({
      projectId, status: 'APPROVED',
    } as never);
    if (approved) {
      throw new ApprovedAssessmentError(
        `${approved.assessmentId} has been approved; regenerating would supersede it.`,
      );
    }

    const now = new Date();

    // Narratives land on the findings, which is where every surface reads them.
    for (const n of input.narratives) {
      await this.repos.findings.collection.updateOne({ projectId, findingId: n.findingId } as never, {
        $set: {
          title: n.title, summaryLine: n.summaryLine, description: n.description,
          agentIntent: n.agentIntent, updatedAt: now,
        } as never,
      });
    }

    const recommendationIds = await this.writeRecommendations(
      projectId, input.pass.seeds, input.recommendationActions, now,
    );

    // Plan items are the only place `status: PLANNED` is set, so a finding is
    // marked planned exactly when something intends to act on it.
    const plannedFindingIds = new Set(input.planItems.flatMap((p) => p.findingIds));
    if (plannedFindingIds.size > 0) {
      await this.repos.findings.collection.updateMany(
        { projectId, findingId: { $in: [...plannedFindingIds] } } as never,
        { $set: { status: 'PLANNED', updatedAt: now } as never },
      );
    }

    const [findings, nodes, edges, files] = await Promise.all([
      this.repos.findings.find({ projectId } as never) as unknown as Promise<Finding[]>,
      this.repos.graphNodes.find({ projectId } as never) as unknown as Promise<GraphNode[]>,
      this.repos.graphEdges.find({ projectId } as never) as unknown as Promise<GraphEdge[]>,
      this.repos.projectFiles.find({ projectId } as never),
    ]);

    const previous = await this.current(projectId);
    const version = (previous?.version ?? 0) + 1;

    const assessment: Assessment = {
      _schemaVersion: 1, createdAt: now, updatedAt: now,
      assessmentId: `asmt_${projectId}_v${version}`,
      projectId, version,
      summary: input.summary,
      // The frozen membership: everything the report renders from, named by id.
      // Later discovery cannot retroactively change what was approved.
      snapshot: {
        findingIds: findings.map((f) => f.findingId).sort(),
        recommendationIds: [...recommendationIds].sort(),
        graphNodeIds: nodes.map((n) => n.nodeId).sort(),
        graphEdgeIds: edges.map((e) => e.edgeId).sort(),
        inputFileIds: files.map((f) => (f as { fileId: string }).fileId).sort(),
        repoCommitSha: input.commitSha,
      },
      planItems: input.planItems.map((p, i) => ({
        planItemId: `plan_${projectId}_v${version}_${i + 1}`,
        targetName: p.targetName,
        targetNodeIds: findings
          .filter((f) => p.findingIds.includes(f.findingId))
          .flatMap((f) => f.nodeIds),
        findingIds: p.findingIds,
        mode: p.mode, action: p.action, rationale: p.rationale,
        expectedChanges: p.expectedChanges,
        conditions: p.conditions, risk: p.risk, order: i,
      })),
      policyId: input.policyId,
      status: 'READY',
      generatedAt: now,
    };

    await this.repos.assessments.insert(assessment);
    if (previous) {
      // Superseded, not deleted: AC-5 requires version 1 to stay readable and
      // byte-identical after version 2 exists.
      await this.repos.assessments.collection.updateOne(
        { assessmentId: previous.assessmentId } as never,
        { $set: { status: 'SUPERSEDED', updatedAt: now } as never },
      );
    }

    const autonomous = assessment.planItems.filter(
      (p) => (AUTONOMOUS_PLAN_MODES as readonly string[]).includes(p.mode),
    ).length;

    await this.repos.projects.collection.updateOne({ projectId } as never, {
      $set: {
        'current.assessmentId': assessment.assessmentId,
        'summary.assessmentComplete': true,
        'summary.counts.findings': findings.length,
        'summary.counts.recommendations': recommendationIds.length,
        'summary.autonomy.eligibleItems': autonomous,
        'summary.lastActivityAt': now,
        'summary.lastActivityText': `Assessment v${version} ready — ${autonomous} autonomous items`,
      } as never,
    });

    await this.repos.events.emit(projectId, {
      type: 'ASSESSMENT_COMPLETED', phase: 'ASSESSMENT', level: 'MILESTONE', severity: 'SUCCESS',
      title: `Assessment v${version} ready`,
      message: `${findings.length} findings · ${assessment.planItems.length} plan items · `
        + `${autonomous} autonomous · ${recommendationIds.length} recommendations`,
      actor: 'AGENT', refs: {},
    });

    return assessment;
  }

  /** Recommendations, upserted on the finding that raised them. */
  private async writeRecommendations(
    projectId: string,
    seeds: RecommendationSeed[],
    actions: Array<{ findingId: string; action: string }>,
    now: Date,
  ): Promise<string[]> {
    const actionFor = new Map(actions.map((a) => [a.findingId, a.action]));
    const ids: string[] = [];

    for (const seed of seeds) {
      const recommendationId = `rec_${projectId}_${seed.findingId.slice(-12)}`;
      const doc: Recommendation = {
        _schemaVersion: 1, createdAt: now, updatedAt: now,
        recommendationId, projectId,
        name: seed.name,
        disposition: seed.disposition,
        // A rule-decided item with no prose still has to say something; the
        // subtype is the honest fallback, not an invented action.
        action: actionFor.get(seed.findingId)
          ?? `Resolve with the owner. Classified ${seed.subtype ?? seed.disposition} by ${seed.ruleId}.`,
        owner: seed.owner,
        findingIds: [seed.findingId],
        nodeIds: seed.nodeIds,
        evidenceIds: seed.evidenceIds,
        sourceCitation: seed.sourceCitation,
        status: 'OPEN',
        raisedAt: now,
      };

      const existing = await this.repos.recommendations.findOne({ recommendationId } as never);
      if (existing) {
        await this.repos.recommendations.collection.updateOne(
          { recommendationId } as never,
          { $set: { ...doc, createdAt: existing.createdAt, raisedAt: existing.raisedAt } as never },
        );
      } else {
        await this.repos.recommendations.insert(doc);
        await this.repos.events.emit(projectId, {
          type: 'RECOMMENDATION_RAISED', phase: 'ASSESSMENT', level: 'ACTIVITY', severity: 'WARN',
          title: `${seed.name} — ${seed.disposition.replace(/_/g, ' ').toLowerCase()}`,
          message: `${doc.action} · owner: ${seed.owner}`,
          actor: 'AGENT', refs: { findingId: seed.findingId },
        });
      }
      ids.push(recommendationId);
    }
    return ids;
  }

  /** The evidence the report and the finding cards cite. */
  async evidenceFor(projectId: string, ids: string[]): Promise<Evidence[]> {
    if (ids.length === 0) return [];
    return this.repos.evidence.collection
      .find({ projectId, evidenceId: { $in: ids } } as never)
      .toArray() as unknown as Promise<Evidence[]>;
  }
}
