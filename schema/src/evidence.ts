import { z } from 'zod';
import { Confidence, GcsUri, Id, ProjectId, Timestamp, baseDocFields } from './common';
import { EvidenceActor, EvidenceClass, EvidenceType } from './enums';

/**
 * The shared citation store (spec §11, §16).
 *
 * Findings, graph nodes, graph edges and recommendations all reference these
 * records rather than embedding their own copies. That is what makes "click the
 * source and inspect it" one component instead of four, and what keeps the
 * dependency graph auditable rather than an unattributable AI drawing.
 */

/** Machine locator — exactly one branch, discriminated so the UI can switch on it. */
export const EvidenceLocator = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('REPO'),
    path: z.string().min(1),
    startLine: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
    commitSha: z.string().min(7),
    permalink: z.string().url().optional(),
  }),
  z.object({
    kind: z.literal('DOCUMENT'),
    fileId: Id,
    page: z.number().int().positive().optional(),
    section: z.string().optional(),
    charStart: z.number().int().nonnegative().optional(),
    charEnd: z.number().int().nonnegative().optional(),
  }),
  z.object({
    kind: z.literal('EXECUTION'),
    executionRunId: Id,
    step: z.string().optional(),
    logGcsUri: GcsUri.optional(),
  }),
  z.object({
    kind: z.literal('REASONING'),
    agentActionId: Id,
  }),
]);
export type EvidenceLocator = z.infer<typeof EvidenceLocator>;

export const MAX_EXCERPT_BYTES = 2048;

export const Evidence = z
  .object({
    ...baseDocFields,
    evidenceId: Id,
    projectId: ProjectId,

    evidenceType: EvidenceType,
    evidenceClass: EvidenceClass,
    confidence: Confidence,

    /** Rendered verbatim: "src/security/CryptoService.java:48",
     *  "Security Architecture.pdf, page 17", "Gateway-X200 Tech Spec §8.4". */
    source: z.string().min(1),
    locator: EvidenceLocator,

    /** The excerpt a finding card expands to show. Multi-line, original line
     *  numbers preserved — the UI renders it as a numbered block. */
    excerpt: z.string().max(MAX_EXCERPT_BYTES).optional(),

    producedBy: z.object({
      actor: EvidenceActor,
      toolName: z.string().optional(),
      agentActionId: Id.optional(),
    }),

    observedAt: Timestamp,
  })
  .superRefine((ev, ctx) => {
    /**
     * The deterministic-first principle, enforced at the write boundary rather
     * than requested in a prompt: only a tool (or the user) can establish a fact.
     * Anything the model asserts is INFERRED and cannot claim full confidence.
     */
    if (ev.evidenceClass === 'OBSERVED' && ev.producedBy.actor === 'MODEL') {
      ctx.addIssue({
        code: 'custom',
        path: ['evidenceClass'],
        message: 'OBSERVED evidence must be produced by a TOOL or USER, not a MODEL',
      });
    }
    if (ev.evidenceClass === 'INFERRED' && ev.confidence >= 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['confidence'],
        message: 'INFERRED evidence cannot have confidence 1.0',
      });
    }
    if (ev.producedBy.actor === 'TOOL' && !ev.producedBy.toolName) {
      ctx.addIssue({
        code: 'custom',
        path: ['producedBy', 'toolName'],
        message: 'tool-produced evidence must name the tool',
      });
    }
  });
export type Evidence = z.infer<typeof Evidence>;

/** Evidence as an agent tool emits it — ids and timestamps are added server-side. */
export const EvidenceInput = z.object({
  evidenceType: EvidenceType,
  evidenceClass: EvidenceClass,
  confidence: Confidence,
  source: z.string().min(1),
  locator: EvidenceLocator,
  excerpt: z.string().max(MAX_EXCERPT_BYTES).optional(),
});
export type EvidenceInput = z.infer<typeof EvidenceInput>;

/**
 * Rolls a set of evidence up onto the node, edge or finding that cites it, so the
 * UI can badge observed-vs-inferred (and dash an inferred edge) without a second
 * query.
 */
export function rollUpEvidence(
  items: Array<Pick<Evidence, 'evidenceClass' | 'confidence'>>,
): { evidenceClass: z.infer<typeof EvidenceClass>; confidence: number } {
  if (items.length === 0) return { evidenceClass: 'INFERRED', confidence: 0 };
  const observed = items.some((e) => e.evidenceClass === 'OBSERVED');
  return {
    evidenceClass: observed ? 'OBSERVED' : 'INFERRED',
    confidence: Math.max(...items.map((e) => e.confidence)),
  };
}
