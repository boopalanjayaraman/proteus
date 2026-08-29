import type { Disposition, Finding, GraphNode, RecommendationDisposition } from '@proteus/schema';
import { resolveDisposition, resolveTarget, type MigrationTarget } from '../rules/assess';
import type { RuleEngine } from '../rules/engine';
import type { Facts } from '../rules/predicates';
import type { Repositories } from '../repositories';

/**
 * Dispositions, assigned by rules before the model composes anything.
 *
 * The order matters more than the code: A2 is handed findings that already carry
 * a disposition and cannot change them. `AUTONOMOUS_MIGRATION` is reachable only
 * through `EXEC-DISP-009`, whose every clause is load-bearing, and a model that
 * could promote a finding into it would make the whole autonomy boundary
 * advisory (agent architecture §7).
 */

export interface RecommendationSeed {
  findingId: string;
  nodeIds: string[];
  evidenceIds: string[];
  name: string;
  disposition: RecommendationDisposition;
  subtype?: string;
  owner: string;
  /** "Gateway-X200 Technical Specification §8.4" — resolved from the evidence. */
  sourceCitation: string;
  ruleId: string;
}

export interface DispositionResult {
  findingId: string;
  disposition: Disposition;
  ruleId: string;
  autonomyBoundary?: string;
  target?: MigrationTarget;
  suppressedBy?: string[];
}

export interface DispositionPass {
  decisions: DispositionResult[];
  seeds: RecommendationSeed[];
  /** Findings no disposition rule matched. Left OPEN rather than guessed at. */
  undecided: string[];
}

/** Where the finding lives, in the vocabulary `EXEC-DISP-009.locationIn` uses. */
function locationOf(finding: Finding): string {
  const path = finding.locations[0]?.path ?? '';
  if (/(^|\/)(pom\.xml|build\.gradle|package\.json)$/.test(path)) return 'MANIFEST';
  if (/\.(ya?ml|properties|conf|toml)$/.test(path)) return 'CONFIG';
  if (/(^|\/)(test|tests)\//.test(path)) return 'TEST';
  if (path) return 'SOURCE';
  return 'DOCUMENT';
}

/**
 * The facts a disposition rule reads.
 *
 * Assembled from the finding and the graph nodes it touches, never from prose.
 * A key that is absent is genuinely unknown — the predicate evaluator
 * distinguishes a missing fact from a mismatched one, so a rule that needs
 * `algorithmSetFixedInFirmware` simply does not fire when nothing established it.
 */
export function factsFor(
  finding: Finding,
  nodes: GraphNode[],
  hasTarget: boolean,
): Facts {
  const own = nodes.filter((n) => finding.nodeIds.includes(n.nodeId));
  const types = own.map((n) => n.type);

  const facts: Facts = {
    location: locationOf(finding),
    approvedTargetExists: hasTarget,
    severity: finding.severity,
  };

  // Only asserted when something classified it. Defaulting to `false` would let
  // EXEC-DISP-001 ("not quantum-vulnerable means no change required") claim
  // every finding that carries no cryptographic classification at all — an
  // external boundary, a coverage gap — and dismiss it as safe. The predicate
  // evaluator distinguishes a missing fact from a false one; this is why.
  if (finding.crypto) {
    facts['quantumVulnerable'] = finding.crypto.quantumVulnerable;
    facts['algorithm'] = finding.crypto.algorithm;
    facts['usage'] = finding.crypto.usage;
  }
  // A finding usually touches one node; when it touches several, the rules read
  // `nodeTypeIn`, so the whole set is offered rather than an arbitrary first.
  if (types.length === 1) facts['nodeType'] = types[0];
  if (types.length > 0) facts['nodeTypes'] = types;

  // Strength is not stored on the finding; it is recoverable from the fact that
  // a strong detection assigned a usage and a weak one left it UNKNOWN.
  facts['usageStrength'] = finding.crypto && finding.crypto.usage !== 'UNKNOWN'
    ? 'STRONG' : 'WEAK';

  for (const n of own) {
    if (n.attributes.firmwareVersion) facts['algorithmSetFixedInFirmware'] = true;
    if (n.type === 'EXTERNAL_SERVICE') facts['peerCapabilityConfirmed'] = false;
    if (n.type === 'PROTOCOL') facts['protocolManaged'] = true;
    // Established by the provider capability registry, not by the model.
    if (n.type === 'CRYPTO_LIBRARY' && n.attributes.capability) {
      facts['dependencyCapability'] = n.attributes.capability;
    }
  }
  return facts;
}

/** A human-readable citation for a recommendation, taken from the finding's evidence. */
function citationFor(finding: Finding): string {
  return finding.locations[0]?.path
    ? `${finding.locations[0].path}${finding.locations[0].startLine ? `:${finding.locations[0].startLine}` : ''}`
    : finding.title;
}

export class DispositionService {
  constructor(
    private readonly repos: Repositories,
    private readonly engine: RuleEngine,
  ) {}

  /**
   * Runs the rules over every open finding and writes the result back.
   *
   * Returns recommendation seeds rather than recommendations: the rule decides
   * the disposition, the subtype and the owner; only the prose is the model's,
   * and prose is added later.
   */
  async run(projectId: string): Promise<DispositionPass> {
    const [findings, nodes] = await Promise.all([
      this.repos.findings.find({ projectId } as never) as unknown as Promise<Finding[]>,
      this.repos.graphNodes.find({ projectId } as never) as unknown as Promise<GraphNode[]>,
    ]);

    const decisions: DispositionResult[] = [];
    const seeds: RecommendationSeed[] = [];
    const undecided: string[] = [];

    for (const finding of findings) {
      // The target is resolved first because `EXEC-DISP-009` requires one to
      // exist: the disposition can never outrun what the standards approve.
      const target = finding.crypto
        ? resolveTarget(this.engine, {
            algorithm: finding.crypto.algorithm,
            usage: finding.crypto.usage,
            quantumVulnerable: finding.crypto.quantumVulnerable,
          }) ?? undefined
        : undefined;

      const facts = factsFor(finding, nodes, Boolean(target));
      const decision = resolveDisposition(this.engine, facts);

      if (!decision) {
        undecided.push(finding.findingId);
        continue;
      }

      decisions.push({
        findingId: finding.findingId,
        disposition: decision.disposition,
        ruleId: decision.ruleId,
        autonomyBoundary: decision.autonomyBoundary,
        target,
        suppressedBy: decision.suppressedBy,
      });

      await this.repos.findings.collection.updateOne({ findingId: finding.findingId } as never, {
        $set: {
          disposition: decision.disposition,
          updatedAt: new Date(),
          ...(target && finding.crypto
            ? {
                'crypto.proposedTarget': target.parameterSet ?? target.target,
                'crypto.targetRationale': `Selected by ${target.ruleIds.join(', ')}.`,
              }
            : {}),
        } as never,
      });

      if (decision.recommendation) {
        const node = nodes.find((n) => finding.nodeIds.includes(n.nodeId));
        seeds.push({
          findingId: finding.findingId,
          nodeIds: finding.nodeIds,
          evidenceIds: finding.evidenceIds,
          name: node?.name ?? finding.title,
          disposition: decision.recommendation.disposition,
          subtype: decision.recommendation.subtype,
          // The rule names the owner. A model choosing who should act would be
          // inventing an org chart.
          owner: decision.recommendation.suggestedOwner ?? 'Unassigned',
          sourceCitation: citationFor(finding),
          ruleId: decision.ruleId,
        });
      }
    }

    return { decisions, seeds, undecided };
  }
}
