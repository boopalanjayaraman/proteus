import {
  type CryptoUsage, type EvidenceInput, type Finding, type ProjectEvent,
} from '@proteus/schema';
import type { Candidate, DependencyFinding } from '../../core/discovery/detect';
import type { ModelClient } from '../model';
import { CorrelationInput, DiscoveryVerdict, ResolveUsageInput } from '../tools/registry';
import { DISCOVERY_SYSTEM_INSTRUCTION } from '../prompts/discovery';

/**
 * A1 — the Discovery Agent.
 *
 * Everything deterministic has already happened. What arrives here is a list of
 * candidates the scanner found, and the agent is asked only the questions a
 * scanner cannot answer: what an ambiguous usage is for, what a document implies
 * about the code, and whether there is enough to assess.
 *
 * The class holds no repository and no driver — it returns decisions, and the
 * caller persists them. That is what keeps `agent/` extractable and what the
 * architecture test enforces.
 */

export interface UsageDecision {
  candidate: Candidate;
  usage: CryptoUsage;
  reasoning: string;
  confidence: number;
  /** INFERRED, always — the model reasoned, it did not observe. */
  evidence: EvidenceInput;
}

export interface Correlation {
  claim: string;
  reasoning: string;
  confidence: number;
  relatedFindingIds: string[];
  evidence: EvidenceInput;
}

export interface DiscoveryDecisions {
  usages: UsageDecision[];
  correlations: Correlation[];
  verdict: { sufficient: boolean; reasoning: string; outstandingQuestions: string[] };
}

export class DiscoveryAgent {
  constructor(private readonly model: ModelClient) {}

  /**
   * Resolves the weak signals only.
   *
   * A strong match is not re-litigated: the scanner established it, and asking a
   * model to second-guess a deterministic result is how a reproducible finding
   * becomes a variable one.
   */
  async resolveUsages(candidates: Candidate[], excerptFor: (c: Candidate) => string): Promise<UsageDecision[]> {
    const weak = candidates.filter((c) => c.strength === 'WEAK' || c.usage === 'UNKNOWN');
    const decisions: UsageDecision[] = [];

    for (const c of weak) {
      const { output } = await this.model.generate({
        system: DISCOVERY_SYSTEM_INSTRUCTION,
        schema: ResolveUsageInput,
        purpose: `resolve-usage:${c.path}:${c.line}`,
        prompt: [
          `A scan found cryptography it could not classify.`,
          ``,
          `File:      ${c.path}:${c.line}`,
          `Algorithm: ${c.algorithm ?? 'not determined'}`,
          `Rule:      ${c.ruleId}`,
          ``,
          `Surrounding code:`,
          excerptFor(c),
          ``,
          `What is this cryptography for? Answer UNKNOWN if the code does not say.`,
        ].join('\n'),
      });

      decisions.push({
        candidate: c,
        usage: output.usage,
        reasoning: output.reasoning,
        confidence: output.confidence,
        evidence: {
          evidenceType: 'MODEL_REASONING',
          // Enforced by the schema too, but stated here so the intent is local:
          // a model conclusion is INFERRED and cannot reach full confidence.
          evidenceClass: 'INFERRED',
          confidence: Math.min(output.confidence, 0.99),
          source: `${c.path}:${c.line}`,
          locator: { kind: 'REPO', path: c.path, startLine: c.line, commitSha: '' },
          excerpt: output.reasoning.slice(0, 2000),
        },
      });
    }
    return decisions;
  }

  /** Connects an uploaded specification to what the code does. */
  async correlate(
    documents: Array<{ fileId: string; name: string; text: string }>,
    findings: Pick<Finding, 'findingId' | 'title' | 'summaryLine'>[],
  ): Promise<Correlation[]> {
    if (documents.length === 0 || findings.length === 0) return [];
    const out: Correlation[] = [];

    for (const doc of documents) {
      const { output } = await this.model.generate({
        system: DISCOVERY_SYSTEM_INSTRUCTION,
        schema: CorrelationInput,
        purpose: `correlate:${doc.fileId}`,
        prompt: [
          `Document: ${doc.name}`,
          ``,
          doc.text.slice(0, 12_000),
          ``,
          `Findings already established from the source:`,
          ...findings.map((f) => `- [${f.findingId}] ${f.title} — ${f.summaryLine}`),
          ``,
          `What does this document establish about the system that the source cannot show?`,
          `Cite the page. State only what the document says, not what it implies about capability.`,
        ].join('\n'),
      });

      out.push({
        claim: output.claim,
        reasoning: output.reasoning,
        confidence: output.confidence,
        relatedFindingIds: output.relatedFindingIds,
        evidence: {
          evidenceType: 'DOCUMENT',
          evidenceClass: 'INFERRED',
          confidence: output.confidence,
          source: output.documentPage ? `${doc.name}, page ${output.documentPage}` : doc.name,
          locator: {
            kind: 'DOCUMENT', fileId: doc.fileId,
            ...(output.documentPage ? { page: output.documentPage } : {}),
          },
          excerpt: output.reasoning.slice(0, 2000),
        },
      });
    }
    return out;
  }

  /** Spec §13 — is there enough evidence to produce an assessment? */
  async isSufficient(
    candidates: Candidate[],
    dependencies: DependencyFinding[],
    filesScanned: number,
  ): Promise<DiscoveryVerdict> {
    const { output } = await this.model.generate({
      system: DISCOVERY_SYSTEM_INSTRUCTION,
      schema: DiscoveryVerdict,
      purpose: 'discovery-sufficiency',
      prompt: [
        `${filesScanned} files scanned.`,
        ``,
        `Cryptographic uses found:`,
        ...candidates.map((c) => `- ${c.path}:${c.line} — ${c.algorithm ?? '?'} (${c.usage})`),
        ``,
        `Dependencies:`,
        ...dependencies.map((d) => `- ${d.dependencyName} ${d.version} — ${d.capability.capability}`),
        ``,
        `Is this enough to produce an assessment? What remains unknown?`,
      ].join('\n'),
    });
    return output;
  }
}

/** The feed row a decision produces (spec §38 levels). */
export function usageEvent(d: UsageDecision): Pick<ProjectEvent, 'type' | 'phase' | 'level' | 'severity' | 'title' | 'message' | 'actor' | 'refs'> {
  return {
    type: 'CRYPTO_FINDING_DETECTED',
    phase: 'DISCOVERY',
    level: d.usage === 'UNKNOWN' ? 'DETAIL' : 'ACTIVITY',
    severity: d.usage === 'UNKNOWN' ? 'WARN' : 'INFO',
    title:
      d.usage === 'UNKNOWN'
        ? `Usage undetermined at ${d.candidate.path}:${d.candidate.line}`
        : `${d.candidate.algorithm ?? 'Cryptography'} classified as ${d.usage.replace(/_/g, ' ').toLowerCase()}`,
    message: `${d.reasoning} · confidence ${d.confidence.toFixed(2)} · inferred`,
    actor: 'AGENT',
    refs: {},
  };
}
