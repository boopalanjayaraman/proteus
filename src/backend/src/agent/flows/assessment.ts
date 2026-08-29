import { z } from 'zod';
import {
  AUTONOMOUS_PLAN_MODES,
  type Disposition, type Finding, type GraphNode, type PlanItemMode,
} from '@proteus/schema';
import type { ModelClient } from '../model';
import {
  AssessmentSummaryInput, FindingNarrativeInput, PlanItemInput,
  RecommendationNarrativeInput,
} from '../tools/registry';
import { ASSESSMENT_SYSTEM_INSTRUCTION } from '../prompts/assessment';

/**
 * A2 — the Assessment Agent.
 *
 * Reads persisted state, returns prose and proposed plan items. It holds no
 * repository and no driver, exactly like A1: what comes back is data, and the
 * caller decides whether to keep it.
 *
 * The disposition is passed in and never asked for. That single choice is what
 * makes the autonomy boundary a property of the system rather than of a prompt.
 */

/** What A2 is given about one finding. It never sees the repository. */
export interface FindingBrief {
  finding: Finding;
  disposition: Disposition;
  dispositionRuleId: string;
  target?: { target: string; parameterSet?: string; rationale: string };
  evidence: Array<{ evidenceClass: string; evidenceType: string; source: string; excerpt?: string }>;
  nodes: GraphNode[];
}

export interface AssessmentDecisions {
  narratives: FindingNarrativeInput[];
  planItems: PlanItemInput[];
  recommendationActions: RecommendationNarrativeInput[];
  summary: AssessmentSummaryInput;
}

/** Which plan modes a disposition may produce. Enforced after the model answers. */
const PERMITTED_MODES: Record<Disposition, readonly PlanItemMode[]> = {
  AUTONOMOUS_MIGRATION: AUTONOMOUS_PLAN_MODES,
  ASSISTED_MIGRATION: ['TEST_ENVIRONMENT_ADAPTATION', 'ASSISTED_MIGRATION'],
  NO_CHANGE_REQUIRED: ['NO_AUTONOMOUS_CHANGE'],
  VENDOR_DEPENDENCY: ['NO_AUTONOMOUS_CHANGE'],
  HARDWARE_REPLACEMENT: ['NO_AUTONOMOUS_CHANGE'],
  HUMAN_DECISION_REQUIRED: ['NO_AUTONOMOUS_CHANGE'],
  NEEDS_FURTHER_INVESTIGATION: ['NO_AUTONOMOUS_CHANGE'],
};

export const permittedModes = (d: Disposition): readonly PlanItemMode[] => PERMITTED_MODES[d];

const brief = (b: FindingBrief): string => [
  `[${b.finding.findingId}] ${b.finding.title}`,
  `  disposition: ${b.disposition}  (assigned by ${b.dispositionRuleId} — you cannot change it)`,
  `  permitted plan modes: ${PERMITTED_MODES[b.disposition].join(', ') || 'none'}`,
  b.finding.crypto
    ? `  cryptography: ${b.finding.crypto.algorithm} used for ${b.finding.crypto.usage}`
      + `${b.finding.crypto.quantumVulnerable ? ' (quantum-vulnerable)' : ' (not quantum-vulnerable)'}`
    : '  cryptography: none recorded',
  b.target ? `  approved target: ${b.target.parameterSet ?? b.target.target} — ${b.target.rationale}` : '',
  `  location: ${b.finding.locations.map((l) => `${l.path ?? '?'}${l.startLine ? `:${l.startLine}` : ''}`).join(', ') || 'not in the repository'}`,
  `  graph nodes: ${b.nodes.map((n) => `${n.name} (${n.type})`).join(', ') || 'none'}`,
  ...b.evidence.map((e) => `  evidence: ${e.evidenceClass} ${e.evidenceType} — ${e.source}`),
].filter(Boolean).join('\n');

export class AssessmentAgent {
  constructor(private readonly model: ModelClient) {}

  /**
   * The narrative for every finding, in one call.
   *
   * One call rather than one per finding because the intents have to be
   * consistent with each other — "two other RSA occurrences are signature usages
   * and are deliberately excluded" is only writable by something that saw both.
   */
  async narrate(briefs: FindingBrief[]): Promise<FindingNarrativeInput[]> {
    if (briefs.length === 0) return [];
    const { output } = await this.model.generate({
      system: ASSESSMENT_SYSTEM_INSTRUCTION,
      schema: z.object({ narratives: z.array(FindingNarrativeInput) }),
      purpose: 'assessment-narratives',
      prompt: [
        'Discovery established the following. Write the finding cards.',
        '',
        ...briefs.map(brief),
        '',
        'Return one narrative per finding, using the exact findingId given.',
        'The AGENT INTENT must be consistent with the disposition: an intent that',
        'describes changing a finding dispositioned NO_CHANGE_REQUIRED is wrong.',
      ].join('\n'),
    });
    // Anything invented is dropped rather than trusted: a narrative for a
    // findingId that does not exist has nowhere legitimate to have come from.
    const known = new Set(briefs.map((b) => b.finding.findingId));
    return output.narratives.filter((n) => known.has(n.findingId));
  }

  /** The proposed plan. Validated by the caller before any of it is persisted. */
  async plan(briefs: FindingBrief[]): Promise<PlanItemInput[]> {
    const changeable = briefs.filter((b) => PERMITTED_MODES[b.disposition].some(
      (m) => m !== 'NO_AUTONOMOUS_CHANGE',
    ));
    if (changeable.length === 0) return [];

    const { output } = await this.model.generate({
      system: ASSESSMENT_SYSTEM_INSTRUCTION,
      schema: z.object({ planItems: z.array(PlanItemInput) }),
      purpose: 'assessment-plan',
      prompt: [
        'Compose the proposed migration plan.',
        '',
        'Findings whose disposition permits change:',
        ...changeable.map(brief),
        '',
        'Findings that must NOT appear in any plan item, for context only:',
        ...briefs.filter((b) => !changeable.includes(b)).map(brief),
        '',
        'One plan item per unit of work a reviewer would approve or refuse as a whole.',
        'Group findings that must move together; separate anything a reviewer might',
        'want to refuse on its own. `expectedChanges` is the contract verification',
        'checks against — path patterns, and only what this item will really touch.',
      ].join('\n'),
    });
    return output.planItems;
  }

  /** The action prose for recommendations the rules already decided. */
  async recommend(
    seeds: Array<{ findingId: string; name: string; disposition: string; subtype?: string; owner: string; citation: string }>,
  ): Promise<RecommendationNarrativeInput[]> {
    if (seeds.length === 0) return [];
    const { output } = await this.model.generate({
      system: ASSESSMENT_SYSTEM_INSTRUCTION,
      schema: z.object({ recommendations: z.array(RecommendationNarrativeInput) }),
      purpose: 'assessment-recommendations',
      prompt: [
        'These are outside the autonomy boundary. The disposition, the subtype and the',
        'owner are already decided. Write what the owner should do.',
        '',
        ...seeds.map((s) => [
          `[${s.findingId}] ${s.name}`,
          `  disposition: ${s.disposition}${s.subtype ? ` · ${s.subtype}` : ''}`,
          `  owner: ${s.owner}`,
          `  source: ${s.citation}`,
        ].join('\n')),
        '',
        'One action per item, addressed to that owner, specific enough to start on.',
      ].join('\n'),
    });
    const known = new Set(seeds.map((s) => s.findingId));
    return output.recommendations.filter((r) => known.has(r.findingId));
  }

  /** The four questions of spec §14. */
  async summarise(
    briefs: FindingBrief[],
    planItems: PlanItemInput[],
    repositoryName: string,
  ): Promise<AssessmentSummaryInput> {
    const { output } = await this.model.generate({
      system: ASSESSMENT_SYSTEM_INSTRUCTION,
      schema: AssessmentSummaryInput,
      purpose: 'assessment-summary',
      prompt: [
        `Repository: ${repositoryName}`,
        '',
        'Findings:',
        ...briefs.map((b) => `- ${b.finding.title} → ${b.disposition}`),
        '',
        'Proposed plan:',
        ...planItems.map((p) => `- ${p.targetName} → ${p.mode} — ${p.action}`),
        '',
        'Answer the four questions. Plainly, and without overstating what is known.',
      ].join('\n'),
    });
    return output;
  }
}
