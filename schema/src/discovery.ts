import { z } from 'zod';
import {
  CommitSha,
  Confidence,
  Id,
  Percent,
  ProjectId,
  Timestamp,
  baseDocFields,
} from './common';
import {
  BlockerKind,
  CryptoUsage,
  DiscoveryStage,
  Disposition,
  EvidenceClass,
  FindingCategory,
  FindingStatus,
  MigrationImpact,
  NodeType,
  RelationshipType,
  Severity,
} from './enums';

/**
 * The read-only analysis phase: the discovery run, its findings, and the
 * evidence-backed PQC dependency graph (spec §6–§13).
 */

// ---------------------------------------------------------------------------
// Discovery run
// ---------------------------------------------------------------------------

/**
 * Symmetric with MigrationRun, and needed for the same reason: discovery is
 * long-running server-side work that must survive an instance eviction, and the
 * discovery screen renders live progress that has to come from somewhere.
 */
export const DiscoveryRun = z.object({
  ...baseDocFields,
  discoveryRunId: Id,
  projectId: ProjectId,

  stage: DiscoveryStage,
  stageEnteredAt: Timestamp,
  status: z.enum(['RUNNING', 'COMPLETED', 'FAILED']),

  /** The headline tiles on the discovery screen. */
  progress: z.object({
    /** null until the clone completes and the tree can be counted. */
    filesTotal: z.number().int().nonnegative().nullable().default(null),
    filesAnalyzed: z.number().int().nonnegative().default(0),
    percent: Percent.default(0),
  }),

  commitSha: CommitSha.optional(),
  /** The elapsed timer's origin. */
  startedAt: Timestamp,
  completedAt: Timestamp.optional(),

  checkpoint: z.object({
    stage: DiscoveryStage,
    cursor: z.record(z.string(), z.unknown()).optional(),
    at: Timestamp,
  }),
  lease: z.object({ holder: z.string(), expiresAt: Timestamp }).optional(),

  /** Why the run stopped. Set only when `status` is FAILED. */
  error: z.string().max(2000).optional(),
});
export type DiscoveryRun = z.infer<typeof DiscoveryRun>;

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

export const CodeLocation = z.object({
  path: z.string().optional(),
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
  component: z.string().optional(),
});
export type CodeLocation = z.infer<typeof CodeLocation>;

export const Finding = z.object({
  ...baseDocFields,
  findingId: Id,
  projectId: ProjectId,

  category: FindingCategory,
  title: z.string().min(1), // "RSA-2048 used for key establishment"

  /**
   * The one-line subtitle under the title. Often derivable from `crypto`
   * ("Usage: key transport → Target: ML-KEM-768") but not always — four of the
   * seven findings in the UX are not cryptographic ("Test coverage gap",
   * "Externally controlled protocol"). Stored, because it cannot be computed for
   * those.
   */
  summaryLine: z.string().min(1),

  /** The expanded detail paragraph. */
  description: z.string(),

  /**
   * Present for cryptographic findings. `usage` is the field that makes this
   * product honest: RSA for key transport and RSA for signing are different
   * findings with different targets (spec §8).
   */
  crypto: z
    .object({
      algorithm: z.string(),
      usage: CryptoUsage,
      proposedTarget: z.string().optional(),
      targetRationale: z.string().optional(),
      quantumVulnerable: z.boolean(),
    })
    .optional(),

  severity: Severity,
  impact: MigrationImpact,
  disposition: Disposition,

  /**
   * "AGENT INTENT" — what the agent proposes to do about *this finding*, in its
   * own words. Distinct from a plan item's action: findings dispositioned
   * NO_CHANGE_REQUIRED still carry an intent ("No modification. Recorded as an
   * assessment item requiring vendor capability confirmation"), and those produce
   * no plan item at all.
   */
  agentIntent: z.string(),

  locations: z.array(CodeLocation).default([]),
  nodeIds: z.array(z.string()).default([]),
  evidenceIds: z.array(Id).default([]),
  /** The citation shown on the collapsed card, before evidence is expanded. */
  primaryEvidenceId: Id.optional(),

  origin: z.enum([
    'REPOSITORY_SCAN',
    'DOCUMENT_ANALYSIS',
    'EXISTING_FINDINGS_IMPORT',
    'CORRELATION',
  ]),

  blocker: z.object({ kind: BlockerKind, detail: z.string() }).optional(),

  status: FindingStatus.default('OPEN'),
  /** Refinement chain — discovery sharpens rather than overwrites. */
  supersededBy: Id.optional(),
  /** Unique per project; makes re-emission of the same finding an update. */
  dedupeKey: z.string().min(1),

  discoveredAt: Timestamp,
});
export type Finding = z.infer<typeof Finding>;

// ---------------------------------------------------------------------------
// Graph
// ---------------------------------------------------------------------------

/** Sparse, node-type dependent. Kept open rather than modelled per type. */
export const NodeAttributes = z.object({
  algorithm: z.string().optional(),
  keySize: z.number().int().positive().optional(),
  usage: CryptoUsage.optional(),
  library: z.string().optional(),
  version: z.string().optional(),
  protocol: z.string().optional(),
  vendor: z.string().optional(),
  model: z.string().optional(),
  firmwareVersion: z.string().optional(),
  path: z.string().optional(),
  externalEndpoint: z.string().optional(),
});
export type NodeAttributes = z.infer<typeof NodeAttributes>;

export const GraphStyle = z.enum(['force', 'radial', 'blueprint']);
export type GraphStyle = z.infer<typeof GraphStyle>;

export const GraphNode = z.object({
  ...baseDocFields,
  /** Deterministic slug from `makeNodeId` — the upsert key. */
  nodeId: z.string().min(1),
  projectId: ProjectId,

  type: NodeType,
  name: z.string().min(1),
  subtitle: z.string().optional(),

  /**
   * The inspector panel's explanatory paragraph — why this node matters to the
   * migration. "Wraps key encapsulation for partner sessions. This is the primary
   * autonomous migration target." Written by the agent; not derivable.
   */
  note: z.string().default(''),

  impact: MigrationImpact.default('UNKNOWN'),
  attributes: NodeAttributes.default({}),

  evidenceIds: z.array(Id).default([]),
  findingIds: z.array(Id).default([]),
  confidence: Confidence.default(0),
  evidenceClass: EvidenceClass.default('INFERRED'),

  /**
   * The event seq at which this node first appeared. The discovery screen reveals
   * nodes in the order the agent found them; replaying by `sequence` reproduces
   * that build-up exactly, which timestamps alone would not.
   */
  sequence: z.number().int().nonnegative().default(0),

  /**
   * ONLY a user's manual pin, scoped to the layout style they dragged it in.
   * Computed positions are never stored: they would go stale on every node
   * insertion, and nodes are inserted continuously during discovery.
   */
  pin: z.object({ x: z.number(), y: z.number(), style: GraphStyle }).optional(),

  firstSeenAt: Timestamp,
});
export type GraphNode = z.infer<typeof GraphNode>;

export const GraphEdge = z.object({
  ...baseDocFields,
  /** `${fromNodeId}|${relationship}|${toNodeId}` — also the upsert key. */
  edgeId: z.string().min(1),
  projectId: ProjectId,

  fromNodeId: z.string().min(1),
  toNodeId: z.string().min(1),
  relationship: RelationshipType,
  label: z.string().optional(),

  impact: MigrationImpact.default('UNKNOWN'),
  evidenceIds: z.array(Id).default([]),
  findingIds: z.array(Id).default([]),
  confidence: Confidence.default(0),
  /**
   * Drives the dashed stroke: INFERRED edges are drawn dashed so an inferred
   * relationship never reads as an established one.
   */
  evidenceClass: EvidenceClass.default('INFERRED'),

  sequence: z.number().int().nonnegative().default(0),
  firstSeenAt: Timestamp,
});
export type GraphEdge = z.infer<typeof GraphEdge>;

/** What `GET /projects/{id}/graph` returns and what the SSE deltas patch into. */
export const GraphSnapshot = z.object({
  projectId: ProjectId,
  graphVersion: z.number().int().nonnegative(),
  nodes: z.array(GraphNode),
  edges: z.array(GraphEdge),
});
export type GraphSnapshot = z.infer<typeof GraphSnapshot>;

// ---------------------------------------------------------------------------
// Agent-facing inputs (Genkit tool schemas)
// ---------------------------------------------------------------------------

/**
 * What the agent supplies when it asserts a node. It names the node canonically
 * and never invents an id — the server derives that, which is what keeps repeated
 * observation idempotent.
 */
export const UpsertGraphNodeInput = z.object({
  type: NodeType,
  canonicalName: z.string().min(1),
  subtitle: z.string().optional(),
  note: z.string().optional(),
  impact: MigrationImpact.optional(),
  attributes: NodeAttributes.optional(),
});
export type UpsertGraphNodeInput = z.infer<typeof UpsertGraphNodeInput>;

export const UpsertGraphEdgeInput = z.object({
  fromNodeId: z.string().min(1),
  toNodeId: z.string().min(1),
  relationship: RelationshipType,
  label: z.string().optional(),
  impact: MigrationImpact.optional(),
});
export type UpsertGraphEdgeInput = z.infer<typeof UpsertGraphEdgeInput>;
