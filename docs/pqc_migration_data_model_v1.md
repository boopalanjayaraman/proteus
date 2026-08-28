# Proteus — Data Model v1

Derived from:
- `requirements/Autonomous_PQC_Migration_Engineer_MVP_Product_Spec_v1.2.md`
- `requirements/ux design/v1.2/` — the UX design canvas, screen by screen
- `docs/PQC_Migration_Architecture_v1.md`
- `docs/PQC_Migration_Tech_Stack_v1.md`

Target persistence: **MongoDB** (system of record) + **Google Cloud Storage** (blobs) + **SSE** (transport only, never state).

Every field below is reachable from something the UX actually renders, or from a
rule the spec actually enforces. Where the two disagree, the UX wins on shape and
the spec wins on meaning.

---

## 0. Design rules this model obeys

1. **The browser owns nothing.** Every user-visible fact — stage, findings, graph, activity feed, migration progress, verification, sandbox URL — is reconstructible from Mongo with plain reads. SSE only carries *deltas since a known point*.
2. **Events are persisted before they are streamed**, and carry a per-project monotonic `seq` so a reconnecting client can say "give me everything after 412".
3. **Evidence is a first-class entity**, not a string. Findings, graph nodes, graph edges, and recommendations all point at the same evidence records (spec §11, §16).
4. **The approved thing is immutable.** An `assessment` (with its plan items) is versioned and frozen at approval time, so the migration is always auditable against exactly what the human approved.
5. **Truth vs. reasoning is modelled explicitly.** Anything Gemini asserts carries `evidenceClass: INFERRED`; anything a tool established carries `OBSERVED` and a `toolRunId`. Verification only accepts tool-established facts.
6. **Nothing unbounded lives in a document.** Raw build logs, cloned trees, PDFs, and reports go to GCS; Mongo keeps structured extracts and pointers. Keeps every doc far from the 16 MB cap.
7. **Everything is scoped by `projectId`** — it is the first field of every index, and the authorization boundary (`project.ownerId === firebaseUid`).
8. **A repository credential never enters this database.** The GitHub PAT collected at
   project creation goes straight to Secret Manager; MongoDB holds a *reference* and a
   display fingerprint. No document, event, agent action or report may contain the token,
   and no API response may return it. See §3.2.
9. **Derived display values are computed, not stored — except where they tick live.** Stage labels, breadcrumbs and CTA text are functions of state. Counters that a live screen updates several times a second are denormalized, because recomputing them per SSE frame is the one place this rule costs more than it saves.

---

## 1. Identifier conventions

| Kind | Format | Example | Notes |
|---|---|---|---|
| Project | `PQC-####` | `PQC-0184` | Human-facing, from `counters`. Used as FK everywhere. |
| Graph node | `{type-slug}:{name-slug}` | `crypto-implementation:cryptoservice` | **Deterministic** — lets the agent upsert the same node repeatedly without duplicating. |
| Graph edge | `{from}\|{REL}\|{to}` | `service:payments-api\|STORES_KEY_IN\|hsm:thales-p400` | Same idempotency property. |
| Everything else | ULID / `nanoid` | `f_01HZX...` | Sortable, generated app-side. |

Mongo `_id` stays an ObjectId; the business id is a separate indexed field. Every document also carries `createdAt`, `updatedAt`, `_schemaVersion: number`, and (where an agent writes it) `idempotencyKey`.

`_schemaVersion` is not ceremony: this model will change mid-build, and one integer is the difference between a migration script and a guessing game about which documents predate a field.

**Blob layout.** Every `gcsUri` in the model is produced from one path helper, so the bucket stays navigable by hand during a demo:

```text
projects/{projectId}/files/{fileId}/{name}       uploaded specs and findings
projects/{projectId}/extracted/{fileId}.txt      extracted document text
projects/{projectId}/runs/{executionRunId}/      build and test logs, JUnit XML
projects/{projectId}/changes/{changeId}.patch    full diffs
projects/{projectId}/artifacts/{artifactId}.*    reports, diffs, evidence bundles
projects/{projectId}/agent/{agentActionId}.json  prompts, tool payloads
```

---

## 2. Shared enums

```ts
// ---- Project lifecycle (spec §4) ----
export type ProjectStage =
  | 'CREATED' | 'ANALYZING' | 'ASSESSMENT_READY' | 'AWAITING_APPROVAL'
  | 'MIGRATING' | 'VERIFYING' | 'SANDBOX_READY' | 'COMPLETED'
  | 'NEEDS_HUMAN_ACTION' | 'FAILED';

// The UX renders an 8-segment progress rail on each project tile; these eight
// ordered stages are that rail. NEEDS_HUMAN_ACTION and FAILED colour it instead.
export const STAGE_RAIL: ProjectStage[] = [
  'CREATED', 'ANALYZING', 'ASSESSMENT_READY', 'AWAITING_APPROVAL',
  'MIGRATING', 'VERIFYING', 'SANDBOX_READY', 'COMPLETED',
];

export type DiscoveryStage =
  | 'QUEUED' | 'CLONING' | 'INSPECTING_STRUCTURE' | 'SCANNING_CRYPTO'
  | 'ANALYZING_DEPENDENCIES' | 'ANALYZING_DOCUMENTS' | 'CORRELATING'
  | 'BUILDING_GRAPH' | 'GENERATING_ASSESSMENT' | 'COMPLETED' | 'FAILED';

// Spec §22 — milestones shown as the migration stage rail.
export type MigrationStage =
  | 'PREPARING_MIGRATION' | 'CREATING_BRANCH' | 'CAPTURING_BASELINE'
  | 'ASSESSING_TEST_COVERAGE' | 'CREATING_TESTS' | 'PREPARING_MOCKS'
  | 'VALIDATING_BASELINE_TESTS' | 'APPLYING_MIGRATION_CHANGES'
  | 'BUILDING' | 'RUNNING_TESTS' | 'ANALYZING_FAILURE' | 'REPAIRING'
  | 'REBUILDING' | 'RETESTING' | 'CRYPTO_VERIFYING' | 'SANDBOX_DEPLOYING'
  | 'END_TO_END_VERIFYING' | 'COMPLETED';

// ---- Evidence (spec §11) ----
export type EvidenceType =
  | 'SOURCE_CODE' | 'CONFIGURATION' | 'DEPENDENCY' | 'TEST'
  | 'DOCUMENT' | 'EXISTING_FINDING' | 'BUILD_OUTPUT' | 'TEST_OUTPUT'
  | 'RUNTIME_OBSERVATION' | 'USER_INSTRUCTION' | 'MODEL_REASONING';
export type EvidenceClass = 'OBSERVED' | 'INFERRED';

// ---- Graph (spec §10) ----
export type NodeType =
  | 'APPLICATION' | 'SERVICE' | 'SOURCE_COMPONENT' | 'CRYPTO_IMPLEMENTATION'
  | 'CRYPTO_LIBRARY' | 'ALGORITHM' | 'CERTIFICATE' | 'KEY' | 'PROTOCOL'
  | 'API' | 'DATABASE' | 'EXTERNAL_SERVICE' | 'HSM' | 'SECURE_ELEMENT'
  | 'OT_DEVICE' | 'IOT_DEVICE' | 'SECURITY_APPLIANCE' | 'VENDOR_DEPENDENCY'
  | 'TEST_MOCK';

export type RelationshipType =
  | 'USES' | 'SECURES' | 'DEPENDS_ON' | 'AUTHENTICATES_WITH' | 'ENCRYPTS_WITH'
  | 'SIGNS_WITH' | 'STORES_KEY_IN' | 'CONNECTS_TO' | 'TESTED_BY'
  | 'SIMULATED_BY' | 'CONTROLLED_BY' | 'REQUIRES_MIGRATION_WITH';
// SECURES is not in spec §10 but the UX uses it on the TLS → API edge, and
// USES would lose the direction of protection.

// spec §12 — applies to nodes AND edges
export type MigrationImpact =
  | 'MIGRATION_REQUIRED' | 'MIGRATION_LIKELY' | 'NO_PQC_CHANGE_REQUIRED'
  | 'DEPENDENCY_REQUIRES_INVESTIGATION' | 'VENDOR_CONTROLLED'
  | 'HARDWARE_CONTROLLED' | 'BLOCKED' | 'UNKNOWN';
// The graph legend collapses VENDOR_CONTROLLED and HARDWARE_CONTROLLED into one
// swatch ("VENDOR / HW"). That is a display grouping; keep them distinct here,
// because the disposition and the recommendation owner differ between them.

// ---- Findings (spec §8, §15, §18) ----
export type FindingCategory =
  | 'CRYPTOGRAPHIC' | 'APPLICATION' | 'HARDWARE_INFRASTRUCTURE' | 'MIGRATION_DEVIATION';

/** The point of spec §8: the primitive alone is not the finding. */
export type CryptoUsage =
  | 'KEY_ESTABLISHMENT' | 'KEY_TRANSPORT' | 'DIGITAL_SIGNATURE'
  | 'CERTIFICATE_VALIDATION' | 'AUTHENTICATION' | 'SYMMETRIC_ENCRYPTION'
  | 'HASHING' | 'MAC' | 'RANDOMNESS' | 'KEY_STORAGE' | 'UNKNOWN';

export type Disposition =
  | 'AUTONOMOUS_MIGRATION' | 'ASSISTED_MIGRATION' | 'NO_CHANGE_REQUIRED'
  | 'VENDOR_DEPENDENCY' | 'HARDWARE_REPLACEMENT' | 'HUMAN_DECISION_REQUIRED'
  | 'NEEDS_FURTHER_INVESTIGATION';

/**
 * The plan card uses a different vocabulary from the finding badge, and it is a
 * real distinction: a finding's disposition says what *kind of problem* it is,
 * a plan item's mode says what the agent will *do*. One finding of disposition
 * AUTONOMOUS_MIGRATION can produce a plan item of mode AUTONOMOUS_GENERATION.
 */
export type PlanItemMode =
  | 'AUTONOMOUS_MIGRATION' | 'AUTONOMOUS_UPDATE' | 'AUTONOMOUS_GENERATION'
  | 'TEST_ENVIRONMENT_ADAPTATION' | 'ASSISTED_MIGRATION' | 'NO_AUTONOMOUS_CHANGE';

/** New in UX v1.1 — what the agent will not do, and who should. */
export type RecommendationDisposition =
  | 'HUMAN_DECISION' | 'HARDWARE_REPLACEMENT' | 'VENDOR_DECISION'
  | 'FOLLOW_ON_WORKSTREAM';

// ---- Execution & failure (spec §29) ----
export type FailureClassification =
  | 'BUILD_DEFECT' | 'IMPLEMENTATION_DEFECT' | 'DEPENDENCY_INCOMPATIBILITY'
  | 'CONFIGURATION_DEFECT' | 'TEST_COVERAGE_GAP' | 'TEST_FIXTURE_OUTDATED'
  | 'MOCK_INCOMPATIBILITY' | 'ENVIRONMENT_FAILURE' | 'EXPECTED_BEHAVIOR_CHANGE'
  | 'EXTERNAL_DEPENDENCY_BLOCKER' | 'UNKNOWN';

// ---- Human gates (arch §23) ----
export type HumanGateType =
  | 'MIGRATION_APPROVAL'            // the Screen-3 gate
  | 'BUSINESS_BEHAVIOR_CHANGE' | 'BASELINE_CONTRACT_CHANGE'
  | 'EXTERNAL_PROTOCOL_CHANGE' | 'SECURITY_DEGRADATION'
  | 'MATERIAL_PERFORMANCE_TRADEOFF' | 'UNAUTHORIZED_SYSTEM_ACCESS'
  | 'HARDWARE_REPLACEMENT' | 'VENDOR_DECISION' | 'MATERIAL_ARCHITECTURE_DECISION'
  | 'RETRY_BUDGET_EXHAUSTED';       // spec §31

/** Spec §31 — applies per unresolved problem, not per command. */
export const MAX_MEANINGFUL_AUTONOMOUS_ATTEMPTS = 4;
```

---
## 3. Collections

### 3.1 `users` — identity and preferences

The app header renders a display name, an avatar monogram, "GOOGLE ACCOUNT", and a
theme toggle. Firebase Auth answers *who* the user is on every request; this
collection is the local mirror of what the UI shows, plus anything they set.

```ts
interface User {
  userId: string;                    // Firebase UID — the join key everywhere
  email: string;
  displayName: string;
  photoUrl?: string;
  initials: string;                  // "AO" — precomputed, avatar fallback
  preferences: {
    theme: 'dark' | 'light';
    graphStyle: 'force' | 'radial' | 'blueprint';
    discoveryLayout: 'graph' | 'split';
  };
  lastSeenAt: Date;
}
```

Preferences live server-side, not in `localStorage`, because the graph style and
discovery layout change what the user sees on the demo's centrepiece screen and
should survive a device change. They are the only settings in the product.

---

### 3.2 `projects` — the resumable state root

Deliberately **thin and hot**: everything the landing screen and a project reopen
need, and nothing that grows without bound.

```ts
interface Project {
  projectId: string;                 // "PQC-0184"
  ownerId: string;                   // Firebase UID — authorization boundary
  name: string;

  repository: {
    url: string;
    provider: 'GITHUB';
    defaultBranch: string;
    baseCommitSha?: string;          // resolved at clone; the baseline anchor
    visibility: 'PUBLIC' | 'PREAUTHORIZED';
    webUrlTemplate?: string;         // ".../blob/{sha}/{path}#L{line}"

    /**
     * Where the access token lives. NOT the token — see design rule 8. The
     * migration branch is written with this credential, so it is per-project:
     * one repository, one token, one Secret Manager entry, revocable alone.
     */
    credential: {
      /** Secret Manager resource: projects/{gcp}/secrets/{name}/versions/{v} */
      secretName: string;          // proteus-{projectId}-github-pat
      secretVersion: string;       // pinned, not "latest" — see below
      /** Enough to recognise the token in the UI, never enough to use it.
       *  Renders as "github_pat_11ABCD•••…". */
      displayPrefix: string;       // first 12 characters
      /** Scopes the user was asked for (UX v1.2), recorded as granted-at-entry.
       *  Not proof: GitHub is the only authority on what a token can actually do. */
      declaredScopes: string[];    // ["contents: read & write", ...]
      status: 'STORED' | 'MISSING' | 'INVALID' | 'REVOKED';
      storedAt: Date;
      lastVerifiedAt?: Date;
      /** storedAt + 90 days. Surfaces a reminder; does not expire the project. */
      rotationDueAt: Date;
    };

    /**
     * Detected at clone, before discovery finishes. Renders as the
     * "PUBLIC · JAVA 17 · MAVEN" chip and feeds the discovery feed's opening
     * lines. Absent until the repository has been read once.
     */
    profile?: {
      language: string;              // "Java"
      languageVersion?: string;      // "17"
      buildSystem?: string;          // "Maven"
      framework?: string;            // "Spring Boot 3.2"
      testFrameworks?: string[];     // ["surefire", "failsafe"]
      fileCount?: number;            // 486
      detectedAt: Date;
    };
  };

  instructions?: string;             // free-text AI instructions (spec §5)

  stage: ProjectStage;
  stageDetail?: DiscoveryStage | MigrationStage;
  stageEnteredAt: Date;
  actionRequired: boolean;           // derived: any OPEN blocking human gate
  failureReason?: string;

  // Landing-tile projection — denormalized so the list needs one query (spec §4)
  summary: {
    lastActivityAt: Date;
    lastActivityText: string;        // "Repairing integration test — mock partner…"
    discoveryComplete: boolean;
    assessmentComplete: boolean;
    migrationApproved: boolean;
    migrationComplete: boolean;
    verificationComplete: boolean;
    sandboxDeployed: boolean;
    counts: {
      findings: number; recommendations: number;
      graphNodes: number; graphEdges: number;
      openGates: number; migrationChanges: number;
    };

    /**
     * Spec §53's North-Star metric. The UX renders it in the persistent header
     * on every screen ("AUTONOMOUS COMPLETION 100% / ELIGIBLE WORK") and again
     * as an outcome tile, so it is denormalized rather than recomputed per view.
     * `humanEngineeringActions` deliberately excludes the one approval — that is
     * counted separately, because the whole claim is "one approval, zero
     * engineering interventions".
     */
    autonomy: {
      eligibleItems: number;
      completedAutonomously: number;
      completionPct: number | null;  // null before migration starts — renders "—"
      humanEngineeringActions: number;
      approvals: number;
    };

    latestArtifactId?: string;
    sandboxUrl?: string;
  };

  // Pointers to the current head of each phase
  current: {
    discoveryRunId?: string;
    assessmentId?: string;           // latest generated
    approvedAssessmentId?: string;   // frozen at approval
    migrationRunId?: string;
    baselineId?: string;
    verificationResultId?: string;
    sandboxDeploymentId?: string;
  };

  lastEventSeq: number;              // SSE resume cursor + change detection
  graphVersion: number;              // bumped on any node/edge write

  version: number;                   // optimistic concurrency for stage transitions
  createdAt: Date; updatedAt: Date;
}
```

**Stage transitions are guarded**, never blind `$set` — this is what makes
concurrent agent + user writes safe on multi-instance Cloud Run:

```ts
db.projects.updateOne(
  { projectId, stage: 'ANALYZING', version: expectedVersion },
  { $set: { stage: 'ASSESSMENT_READY', stageEnteredAt: now },
    $inc: { version: 1 } }
);
```

Everything else on the project tile is derived: the progress rail is
`STAGE_RAIL.indexOf(stage)`, the "live" border is `stage ∈ {ANALYZING, MIGRATING}`,
and the call-to-action label (`REVIEW & APPROVE`, `DECISION REQUIRED`,
`REVIEW SANDBOX`, `VIEW REPORT`) is a pure function of `stage` and
`actionRequired`. None of it is stored.

---

### 3.3 `project_files` — uploaded context (spec §5)

```ts
type FileKind =
  | 'HARDWARE_SPEC' | 'OT_SPEC' | 'IOT_SPEC' | 'HSM_SPEC' | 'FIRMWARE_DOC'
  | 'ARCHITECTURE_DOC' | 'SECURITY_ARCHITECTURE_DOC' | 'PROTOCOL_DOC'
  | 'CBOM' | 'SAST_FINDINGS' | 'VULN_REPORT' | 'PQC_READINESS_REPORT' | 'OTHER';

interface ProjectFile {
  fileId: string;
  projectId: string;
  kind: FileKind;
  originalName: string;              // "Gateway-X200 Technical Specification.pdf"
  mimeType: string;
  sizeBytes: number;                 // rendered as the "4.2 MB" meta line
  gcsUri: string;
  sha256: string;

  extraction: {
    status: 'PENDING' | 'EXTRACTED' | 'PARTIAL' | 'FAILED';
    textGcsUri?: string;             // extracted plain text — NOT in Mongo
    pageCount?: number;
    /** Page/section offsets so a finding can cite "page 17" or "§8.4" and the
     *  evidence viewer can jump there. Both citation forms appear in the UX. */
    sections?: Array<{ page?: number; heading?: string; charStart: number; charEnd: number }>;
    error?: string;
  };

  uploadedBy: string; createdAt: Date; updatedAt: Date;
}
```

---

### 3.4 `evidence` — the shared citation store (spec §11, §16)

One collection, referenced by findings, nodes, edges, and recommendations. This is
what makes "click the source and inspect it" work uniformly, and what keeps the
graph auditable rather than an AI drawing.

```ts
interface Evidence {
  evidenceId: string;
  projectId: string;

  evidenceType: EvidenceType;
  evidenceClass: EvidenceClass;      // OBSERVED | INFERRED
  confidence: number;                // 0..1 — rendered as "CONF 0.94"

  /** Rendered verbatim: "src/security/CryptoService.java:48",
   *  "Security Architecture.pdf, page 17", "Gateway-X200 Technical Spec §8.4" */
  source: string;

  /** Machine locator — exactly one branch populated. Drives deep links. */
  locator:
    | { kind: 'REPO'; path: string; startLine?: number; endLine?: number;
        commitSha: string; permalink?: string }
    | { kind: 'DOCUMENT'; fileId: string; page?: number; section?: string;
        charStart?: number; charEnd?: number }
    | { kind: 'EXECUTION'; executionRunId: string; step?: string; logGcsUri?: string }
    | { kind: 'REASONING'; agentActionId: string };

  /** The code/spec excerpt the finding card expands to show. Multi-line, with
   *  original line numbers preserved — the UX renders it as a numbered block. */
  excerpt?: string;
  producedBy: { actor: 'TOOL' | 'MODEL' | 'USER'; toolName?: string; agentActionId?: string };

  createdAt: Date;
}
```

> **Rule:** `evidenceClass: 'OBSERVED'` requires `producedBy.actor` of `TOOL` or `USER`. A model assertion is `INFERRED` with `confidence < 1.0`. Enforced in the write path, not in the prompt.

---

### 3.5 `discovery_runs` — the read-only analysis phase

Symmetric with `migration_runs`, and needed for the same reason: discovery is
long-running server-side work that must survive an instance eviction, and the
discovery screen renders live progress that has to come from somewhere.

```ts
interface DiscoveryRun {
  discoveryRunId: string;
  projectId: string;

  stage: DiscoveryStage;
  stageEnteredAt: Date;
  status: 'RUNNING' | 'COMPLETED' | 'FAILED';

  /** The four headline tiles on the discovery screen. */
  progress: {
    filesTotal: number | null;       // null until the clone completes
    filesAnalyzed: number;
    percent: number;                 // 0..100, monotonic
  };

  commitSha?: string;
  startedAt: Date;                   // the elapsed timer's origin
  completedAt?: Date;

  checkpoint: { stage: DiscoveryStage; cursor?: Record<string, unknown>; at: Date };
  lease?: { holder: string; expiresAt: Date };
}
```

Findings, node and blocker counts on the same tile row come from
`project.summary.counts` — they are shared with the assessment screen, so they
live on the project rather than being counted twice.

---

### 3.6 `findings` (spec §8, §15, §16, §18)

```ts
interface Finding {
  findingId: string;
  projectId: string;

  category: FindingCategory;
  title: string;                     // "RSA-2048 used for key establishment"

  /**
   * The one-line subtitle under the title. Often derivable from `crypto`
   * ("Usage: key transport → Target: ML-KEM-768") but not always — four of the
   * seven findings in the UX are not cryptographic findings at all
   * ("Test coverage gap", "Externally controlled protocol"). Stored, because it
   * cannot be computed for those.
   */
  summaryLine: string;

  description: string;               // the expanded detail paragraph

  crypto?: {
    algorithm: string;               // "RSA-2048"
    usage: CryptoUsage;              // THE discriminator (spec §8)
    proposedTarget?: string;         // "ML-KEM-768"
    targetRationale?: string;
    quantumVulnerable: boolean;
  };

  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';
  impact: MigrationImpact;
  disposition: Disposition;

  /**
   * "AGENT INTENT" — what the agent proposes to do about *this finding*,
   * in its own words. Distinct from the plan item's action: findings with
   * disposition NO_CHANGE_REQUIRED still carry an intent ("No modification.
   * Recorded as an assessment item requiring vendor capability confirmation"),
   * and those produce no plan item at all.
   */
  agentIntent: string;

  locations: Array<{ path?: string; startLine?: number; endLine?: number; component?: string }>;
  nodeIds: string[];                 // graph nodes this finding attaches to
  evidenceIds: string[];
  primaryEvidenceId?: string;        // the citation shown on the collapsed card

  origin: 'REPOSITORY_SCAN' | 'DOCUMENT_ANALYSIS' | 'EXISTING_FINDINGS_IMPORT' | 'CORRELATION';
  blocker?: {
    kind: 'UNSUPPORTED_DEPENDENCY' | 'EXTERNAL_PROTOCOL' | 'VENDOR_DEPENDENCY'
        | 'NO_PQC_SUPPORT' | 'TEST_DEFICIENCY' | 'ARCHITECTURE_CONSTRAINT';
    detail: string;
  };

  status: 'OPEN' | 'PLANNED' | 'IN_MIGRATION' | 'MIGRATED' | 'VERIFIED'
        | 'EXCLUDED' | 'BLOCKED';
  supersededBy?: string;             // refinement chain as discovery sharpens
  dedupeKey: string;                 // idempotent re-emission

  discoveredAt: Date; updatedAt: Date;
}
```

---

### 3.7 `graph_nodes` / `graph_edges` (spec §9–§12)

Two collections, not one embedded blob. The graph is written incrementally by a
streaming agent, so each write should be a small idempotent upsert rather than a
rewrite of a large array; edges need their own indexes for traversal; and the SSE
deltas map 1:1 onto node/edge upserts.

```ts
interface GraphNode {
  nodeId: string;                    // deterministic slug — upsert key
  projectId: string;

  type: NodeType;
  name: string;                      // "RSA-2048 key transport"
  subtitle?: string;

  /**
   * The inspector panel's explanatory paragraph — why this node matters to the
   * migration. "Wraps key encapsulation for partner sessions. This is the
   * primary autonomous migration target." Written by the agent; not derivable.
   */
  note: string;

  impact: MigrationImpact;

  attributes: {                      // sparse, type-dependent
    algorithm?: string; keySize?: number; usage?: CryptoUsage;
    library?: string; version?: string; protocol?: string;
    vendor?: string; model?: string; firmwareVersion?: string;
    path?: string; externalEndpoint?: string;
  };

  evidenceIds: string[];
  findingIds: string[];
  confidence: number;                // max of contributing evidence
  evidenceClass: EvidenceClass;      // OBSERVED if any observed evidence

  /** The event seq at which this node first appeared. The discovery screen
   *  reveals nodes in order as the agent finds them; replaying by `sequence`
   *  reproduces that build-up exactly, which timestamps alone would not. */
  sequence: number;

  /** ONLY a user's manual pin — see §7. Computed positions are never stored. */
  pin?: { x: number; y: number; style: 'force' | 'radial' | 'blueprint' };

  firstSeenAt: Date; updatedAt: Date;
}

interface GraphEdge {
  edgeId: string;                    // `${fromNodeId}|${relationship}|${toNodeId}`
  projectId: string;

  fromNodeId: string;
  toNodeId: string;
  relationship: RelationshipType;
  label?: string;                    // "RSA key transport", "signing key"

  impact: MigrationImpact;
  evidenceIds: string[];
  findingIds: string[];
  confidence: number;
  /** Drives the dashed stroke: INFERRED edges are drawn dashed so an inferred
   *  relationship never reads as an established one. */
  evidenceClass: EvidenceClass;

  sequence: number;
  firstSeenAt: Date; updatedAt: Date;
}
```

**Why this stays correct under a streaming agent:** every graph write is

```ts
db.graph_nodes.updateOne(
  { projectId, nodeId },
  { $setOnInsert: { firstSeenAt: now, type, name, sequence: seq },
    $set: { impact, note, updatedAt: now },
    $addToSet: { evidenceIds: { $each: newEvidenceIds }, findingIds: { $each: fids } } },
  { upsert: true }
);
```

Re-discovering the same dependency enriches the node instead of duplicating it.
The tool layer returns `{ created: boolean }` so the emitter knows whether to send
`GRAPH_NODE_ADDED` or `GRAPH_NODE_UPDATED`.

---
### 3.8 `assessments` — immutable, versioned (spec §13, §17, §19)

```ts
interface Assessment {
  assessmentId: string;
  projectId: string;
  version: number;                   // 1, 2, … regenerating never mutates in place

  /** The four questions Screen 3 must answer (spec §14). */
  summary: {
    headline: string;
    whatExists: string; whatIsVulnerable: string;
    whatAgentWillChange: string; whatAgentWillNotChange: string;
  };

  /** Frozen membership — the report must render identically forever. */
  snapshot: {
    findingIds: string[];
    recommendationIds: string[];
    graphNodeIds: string[];
    graphEdgeIds: string[];
    inputFileIds: string[];
    repoCommitSha: string;
  };

  planItems: PlanItem[];

  policyId: string;                  // which migration policy produced the targets
  artifactId?: string;               // the downloadable assessment report

  status: 'DRAFT' | 'READY' | 'APPROVED' | 'SUPERSEDED';
  generatedAt: Date;
}

interface PlanItem {
  planItemId: string;
  targetName: string;                // "CryptoService", "Partner simulator"
  targetNodeIds: string[];
  findingIds: string[];

  mode: PlanItemMode;                // "AUTONOMOUS GENERATION" etc.
  action: string;                    // the one-line "what" on the plan card
  rationale: string;

  /** Autonomy contract: what the agent claims it will touch. Verified after. */
  expectedChanges: Array<{
    changeType: 'SOURCE' | 'DEPENDENCY' | 'CONFIGURATION' | 'TEST' | 'MOCK' | 'BUILD_CONFIG';
    paths: string[];
    description: string;
  }>;

  conditions?: string[];             // "only if tests prove the mock is obsolete"
  risk: 'LOW' | 'MEDIUM' | 'HIGH';
  order: number;
  approved?: boolean;                // set at approval; supports partial scope
}
```

Note there is no `blockers[]` array here any more. Blocking facts live on the
finding that established them (`finding.blocker`); what the *user* sees is the
recommendation raised in response, below.

---

### 3.9 `recommendations` — what the agent will not do, and who should

New in UX v1.1, and the better model. The earlier design had two half-overlapping
lists — "excluded from scope" on the assessment and "unresolved external items"
on the final report. They are the same thing seen twice, and neither said who was
supposed to act. A recommendation is raised during assessment, survives approval
untouched, and reappears in the migration report carried forward.

```ts
interface Recommendation {
  recommendationId: string;
  projectId: string;

  name: string;                      // "Gateway-X200 · firmware 4.2.1"
  disposition: RecommendationDisposition;

  /** The recommended action, in prose. This is the deliverable — an item with
   *  no action is just a complaint. */
  action: string;

  /** Who should act. A team or role, not a person: the prototype has no
   *  directory, and assigning to an individual would imply one. */
  owner: string;                     // "OT engineering · procurement"

  findingIds: string[];              // what raised it
  nodeIds: string[];
  evidenceIds: string[];
  sourceCitation: string;            // "Gateway-X200 Technical Specification §8.4"

  status: 'OPEN' | 'ACKNOWLEDGED' | 'CLOSED';
  raisedAt: Date; updatedAt: Date;
}
```

Recommendations are a collection rather than an embedded array because they
outlive the assessment that raised them: the same three items render on the
assessment screen, in the assessment report, on the completion screen, and in the
migration report. Embedding would mean copying them into each.

---

### 3.10 `migration_runs` — one per approval

```ts
interface MigrationRun {
  migrationRunId: string;
  projectId: string;

  approval: {
    assessmentId: string;
    assessmentVersion: number;
    approvedPlanItemIds: string[];
    approvedBy: string;              // Firebase UID
    approvedAt: Date;
    acknowledgedActions: string[];   // the 14-item disclosure list the user confirmed
  };

  branch: { name: string; baseCommitSha: string; headCommitSha?: string;
            createdAt?: Date; pushed: boolean; prUrl?: string;
            commitCount: number };   // rendered as "BASE 7c41ab9 · 6 COMMITS"

  stage: MigrationStage;
  stageEnteredAt: Date;
  status: 'RUNNING' | 'PAUSED_FOR_HUMAN' | 'COMPLETED' | 'FAILED' | 'ABANDONED';

  baselineId?: string;
  attemptCount: number;
  currentAttemptId?: string;

  /**
   * The four live tiles above the migration feed. Denormalized deliberately:
   * they change on almost every event, and joining three collections per SSE
   * frame to recompute them is the one case where storing derived data is
   * cheaper than deriving it (see design rule 8).
   */
  metrics: {
    testsPassing: number;
    testsFailing: number;
    autonomousRepairs: number;
    humanGatesOpened: number;
    cloudBuildAttempts: number;
  };

  /** Written at every stage boundary so a restarted worker resumes at the last
   *  completed milestone rather than from scratch. */
  checkpoint: { stage: MigrationStage; cursor?: Record<string, unknown>; at: Date };

  /** TTL lease. Guarantees a single writer, so neither a double-clicked Approve
   *  nor a scale-out event can start two migrations. */
  lease?: { holder: string; expiresAt: Date };

  outcome?: 'VERIFIED' | 'PARTIALLY_MIGRATED' | 'HUMAN_ACTION_REQUIRED';
  startedAt: Date; completedAt?: Date;   // the "11:42 END TO END" figure
}
```

### 3.11 `baselines` (spec §24)

```ts
interface Baseline {
  baselineId: string;
  projectId: string;
  migrationRunId: string;
  commitSha: string;

  build: { executionRunId: string; passed: boolean; durationMs: number };

  tests: {
    executionRunId: string;
    total: number; passed: number; failed: number; skipped: number;
    /** Pre-existing failures — the migration is never blamed for these, and the
     *  final report states explicitly that they are unchanged. */
    knownFailures: Array<{ testId: string; name: string; message?: string }>;
    inventory: Array<{ testId: string; name: string; suite: string;
                       status: 'PASSED' | 'FAILED' | 'SKIPPED' }>;
  };

  /** The behavioural contract, rendered as the "BASELINE CONTRACT" checklist
   *  and re-checked verbatim during verification. */
  invariants: Array<{
    invariantId: string;
    kind: 'API_BEHAVIOR' | 'CRYPTO_OUTCOME' | 'FAILURE_MODE' | 'MESSAGE_FORMAT'
        | 'FUNCTIONAL_OUTCOME';
    description: string;             // "Malformed peer key → 400"
    assertion: string;               // executable predicate / test id
    capturedFrom: 'EXISTING_TEST' | 'GENERATED_PROBE' | 'RUNTIME_OBSERVATION';
    mustHold: true;
    evidenceIds: string[];
  }>;

  capturedAt: Date;
}
```

### 3.12 `migration_attempts` (spec §27, §28, §31)

One document per **meaningful engineering cycle**. The retry budget counts these,
not command retries.

```ts
interface MigrationAttempt {
  attemptId: string;
  projectId: string;
  migrationRunId: string;
  attemptNumber: number;

  intent: string;
  planItemIds: string[];
  changeIds: string[];
  executionRunIds: string[];

  /** Structured failure evidence (spec §33) — compact by construction. This is
   *  rendered verbatim as a JSON block in the migration feed. */
  failure?: {
    phase: 'BUILD' | 'UNIT_TEST' | 'INTEGRATION_TEST' | 'CRYPTO_VERIFY' | 'DEPLOY' | 'E2E';
    command: string;
    exitCode: number;
    failedTests: Array<{ name: string; message: string; stackHead?: string }>;
    error: string;
    relevantLogs: string[];          // ≤ 20 lines, extracted deterministically
    fullLogGcsUri: string;           // the rest lives in GCS
  };

  diagnosis?: {
    classification: FailureClassification;
    rootCause: string;
    reasoning: string;
    withinAutonomousBoundary: boolean;
    baselineRequirementChanged: boolean;   // spec §26 — if true → human gate
    proposedAction: string;
    evidenceIds: string[];
    modelRef: { model: string; agentActionId: string };
  };

  /** Groups repeated attempts at the same unresolved problem (spec §31). */
  problemKey?: string;

  result: 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'ABANDONED' | 'ESCALATED';
  startedAt: Date; endedAt?: Date;
}
```

```ts
/** Enforces MAX_MEANINGFUL_AUTONOMOUS_ATTEMPTS = 4 — the "1 / 4 MEANINGFUL
 *  ATTEMPTS" counter on the migration screen. */
interface ProblemThread {
  problemKey: string;
  projectId: string;
  migrationRunId: string;
  classification: FailureClassification;
  signature: string;                 // normalized failure text
  meaningfulAttempts: number;        // at 4 → open a RETRY_BUDGET_EXHAUSTED gate
  attemptIds: string[];
  status: 'ACTIVE' | 'RESOLVED' | 'ESCALATED';
  firstSeenAt: Date; updatedAt: Date;
}
```

### 3.13 `migration_changes` (spec §25, §26, §27)

```ts
interface MigrationChange {
  changeId: string;
  projectId: string;
  migrationRunId: string;
  attemptId: string;
  sequence: number;                  // "Modification #3"

  changeType: 'SOURCE' | 'DEPENDENCY' | 'CONFIGURATION' | 'TEST' | 'MOCK'
            | 'FIXTURE' | 'BUILD_CONFIG' | 'REVERT';
  intent: 'MIGRATION' | 'REPAIR' | 'TEST_ENGINEERING' | 'ROLLBACK';

  summary: string;                   // "Migrated CryptoService to ML-KEM-768"
  rationale: string;
  findingIds: string[];
  planItemIds: string[];

  files: Array<{ path: string; operation: 'ADDED' | 'MODIFIED' | 'DELETED';
                 linesAdded: number; linesRemoved: number }>;
  commitSha?: string;
  diffGcsUri: string;                // full patch in GCS; Mongo keeps the shape

  /** Anti-test-cheating record — REQUIRED when changeType is TEST | MOCK |
   *  FIXTURE (spec §26). The migration feed renders it verbatim. */
  testIntegrity?: {
    failureClassification: FailureClassification;
    reason: string;
    baselineRequirementChanged: boolean;
    safeAutonomousModification: boolean;
    gateId?: string;                 // required when baselineRequirementChanged
  };

  verificationOutcome?: 'PENDING' | 'BUILD_PASS' | 'TEST_PASS' | 'FAILED' | 'REVERTED';
  revertedByChangeId?: string;
  appliedAt: Date;
}
```

### 3.14 `execution_runs` — every Cloud Build / deploy / E2E invocation

Where "tools establish truth" is stored.

```ts
interface ExecutionRun {
  executionRunId: string;
  projectId: string;
  migrationRunId?: string;
  attemptId?: string;

  kind: 'BASELINE_BUILD' | 'BASELINE_TEST' | 'BUILD' | 'UNIT_TEST'
      | 'INTEGRATION_TEST' | 'CRYPTO_VERIFY' | 'IMAGE_BUILD' | 'DEPLOY' | 'E2E_TEST';
  environment: 'CLOUD_BUILD' | 'CLOUD_RUN_SANDBOX';

  provider: { cloudBuildId?: string; cloudRunService?: string; region?: string;
              logUrl?: string };

  commitSha: string;
  command: string;                   // "mvn -q verify"
  exitCode?: number;
  status: 'QUEUED' | 'RUNNING' | 'SUCCESS' | 'FAILURE' | 'TIMEOUT' | 'CANCELLED';

  tests?: {
    total: number; passed: number; failed: number; skipped: number;
    failures: Array<{ testId: string; name: string; suite: string;
                      message: string; stackHead?: string }>;
    reportGcsUri?: string;
  };

  artifacts?: { imageUri?: string; imageDigest?: string };

  logGcsUri?: string;                // full logs — never in Mongo
  logExcerpt?: string[];             // deterministic extract for the model
  startedAt: Date; finishedAt?: Date; durationMs?: number;
}
```

### 3.15 `verification_results` (spec §34, §35)

```ts
type VerificationCheck =
  | 'BASELINE_INVARIANTS_PRESERVED' | 'BUILD_SUCCESSFUL' | 'REQUIRED_TESTS_PASSED'
  | 'PROHIBITED_CRYPTO_ABSENT' | 'REQUIRED_PQC_PRESENT' | 'MIGRATION_POLICY_SATISFIED'
  | 'NO_CRITICAL_BLOCKER' | 'SANDBOX_DEPLOYMENT_SUCCESSFUL' | 'E2E_VERIFICATION_SUCCESSFUL';

interface VerificationResult {
  verificationResultId: string;
  projectId: string;
  migrationRunId: string;
  commitSha: string;

  /** The nine gating checks. PASS/FAIL only — this list decides `overall`. */
  checks: Array<{
    check: VerificationCheck;
    status: 'PASS' | 'FAIL' | 'NOT_APPLICABLE';
    detail: string;
    /** A check with no executionRunId and no evidence cannot PASS. */
    executionRunId?: string;
    evidenceIds: string[];
    findings?: Array<{ path: string; line?: number; match: string }>;
  }>;

  /**
   * The crypto-specific summary on the completion screen. Deliberately a
   * SEPARATE list from `checks`: it is narrative rather than gating, and it
   * needs a third state. "Certificate chain still RSA-signed — PKI migration out
   * of approved scope" is neither a pass nor a failure; it is an honest NOTED.
   * Letting NOTED into `checks` would make the completion rule ambiguous.
   */
  cryptoAssertions: Array<{
    label: string;                   // "ML-KEM-768 encapsulation present"
    status: 'PASS' | 'NOTED' | 'FAIL';
    evidence: string;                // "CryptoService.java:51 · provider verified"
    evidenceIds: string[];
  }>;

  overall: 'VERIFIED' | 'NOT_VERIFIED';
  residualLegacyCrypto: Array<{ algorithm: string; usage: CryptoUsage;
                                path: string; line: number; accepted: boolean;
                                acceptanceReason?: string }>;
  detectedPqc: Array<{ algorithm: string; usage: CryptoUsage; path: string; line: number }>;

  verifiedAt: Date;
}
```

> `overall` is computed by code from `checks` — never written by the model, never derived from a chat completion. `cryptoAssertions` does not participate.

### 3.16 `sandbox_deployments` (spec §36, §37)

```ts
interface SandboxDeployment {
  sandboxDeploymentId: string;
  projectId: string;
  migrationRunId: string;

  imageUri: string; imageDigest: string; commitSha: string;
  service: { name: string; region: string; url?: string; revision?: string };

  status: 'BUILDING_IMAGE' | 'DEPLOYING' | 'STARTING' | 'READY' | 'FAILED' | 'TORN_DOWN';
  startupCheck?: { passed: boolean; httpStatus?: number; detail?: string;
                   startupMs?: number };   // "service started in 2.4s"
  e2e?: { executionRunId: string; passed: boolean;
          scenarios: Array<{ name: string; passed: boolean }>;
          latencyDeltaMs?: number };       // "latency +4.1ms vs baseline"

  isProduction: false;               // literal — every surface labels from this
  expiresAt?: Date;
  deployedAt?: Date;
}
```

---
### 3.17 `human_gates` (spec §20, §30; arch §23)

```ts
interface HumanGate {
  gateId: string;
  projectId: string;
  migrationRunId?: string;
  attemptId?: string;

  type: HumanGateType;
  blocking: boolean;                 // false → unrelated work continues (spec §30)

  title: string;
  question: string;
  context: string;
  evidenceIds: string[];
  relatedFindingIds: string[];
  relatedChangeIds: string[];

  options: Array<{ optionId: string; label: string; detail?: string;
                   consequence?: string }>;

  status: 'OPEN' | 'RESOLVED' | 'EXPIRED' | 'WITHDRAWN';
  resolution?: { optionId: string; note?: string; resolvedBy: string; resolvedAt: Date };

  openedAt: Date;
}
```

`MIGRATION_APPROVAL` is modelled as a gate too, so Screen 3's approval and every
mid-migration pause share one component, one endpoint
(`POST /projects/{id}/decisions/{gateId}`), and one audit shape.

### 3.18 `events` — the append-only stream (spec §41, §42)

```ts
interface ProjectEvent {
  eventId: string;
  projectId: string;
  seq: number;                       // per-project monotonic; SSE Last-Event-ID
  ts: Date;

  type: EventType;                   // the spec §41 vocabulary
  phase: 'DISCOVERY' | 'ASSESSMENT' | 'MIGRATION' | 'VERIFICATION' | 'SANDBOX' | 'SYSTEM';

  /** The fine-grained stage at emission. Every line in the migration feed is
   *  stamped with the stage it happened in ("APPLYING CHANGES", "REPAIRING"),
   *  and reconstructing that from the run's *current* stage would relabel
   *  history every time the run advances. */
  stage?: DiscoveryStage | MigrationStage;

  /** Live Activity Stream vs Complete Audit Trail (spec §38). */
  level: 'MILESTONE' | 'ACTIVITY' | 'DETAIL';
  severity: 'INFO' | 'WARN' | 'ERROR' | 'SUCCESS';

  title: string;                     // user-facing one-liner
  message?: string;                  // the detail block; may be a JSON string
  payload?: Record<string, unknown>;

  refs: {                            // sparse — drives click-through
    findingId?: string; nodeId?: string; edgeId?: string;
    attemptId?: string; changeId?: string; executionRunId?: string;
    gateId?: string; assessmentId?: string; recommendationId?: string;
    sandboxDeploymentId?: string; evidenceIds?: string[];
    /** File chips rendered on the feed line. Denormalized from the change so a
     *  streaming feed does not need a lookup per row. */
    paths?: string[];
  };

  actor: 'AGENT' | 'TOOL' | 'SYSTEM' | 'USER';
  idempotencyKey?: string;           // unique index — safe agent retries
}
```

The frontend renders `MILESTONE` and `ACTIVITY` in the live feed and `DETAIL`
only inside the audit trail drawer — that is the whole fix for spec §38's
"terminal spam" concern, and it is a data-model decision rather than a UI filter
invented later.

### 3.19 `agent_actions` — full audit of reasoning + tool calls (spec §39)

```ts
interface AgentAction {
  agentActionId: string;
  projectId: string;
  migrationRunId?: string;
  attemptId?: string;

  kind: 'MODEL_TURN' | 'TOOL_CALL';
  toolName?: string;                 // scan_crypto, apply_patch, run_build, …
  input?: Record<string, unknown>;   // truncated; large payloads → GCS
  output?: Record<string, unknown>;
  outputGcsUri?: string;

  model?: { name: string; promptTokens: number; outputTokens: number; latencyMs: number };
  promptGcsUri?: string;
  status: 'SUCCESS' | 'ERROR';
  error?: string;

  startedAt: Date; endedAt: Date;
}
```

### 3.20 `artifacts` — the downloadable evidence package (spec §19, §40)

Widened from a reports-only collection. The completion screen offers four
downloads and only two of them are reports; a git diff and a build-evidence
bundle sit alongside them with the same affordance, so they are the same kind of
thing to the user and should be the same kind of thing to the model.

```ts
interface Artifact {
  artifactId: string;
  projectId: string;

  kind: 'ASSESSMENT_REPORT' | 'MIGRATION_REPORT' | 'GIT_DIFF' | 'BUILD_TEST_EVIDENCE';
  format: 'PDF' | 'MARKDOWN' | 'JSON' | 'DIFF';

  title: string;                     // "Migration report"
  /** The card's meta line: "34 PAGES · FULL AUDIT TRAIL",
   *  "6 COMMITS · 4 FILES · +212 −68". Rendered, so stored. */
  displayMeta: string;
  /** …and the same facts structurally, for the report body and for anything
   *  that needs to reason about them rather than print them. */
  stats?: {
    pages?: number; commits?: number; filesChanged?: number;
    linesAdded?: number; linesRemoved?: number; buildAttempts?: number;
  };

  assessmentId?: string;
  migrationRunId?: string;

  gcsUri: string;
  sizeBytes: number;
  contentSnapshot?: Record<string, unknown>;  // the structured source of the render
  status: 'GENERATING' | 'READY' | 'FAILED';
  generatedAt: Date;
}
```

### 3.21 `migration_policies` — what "migrated" means

Small but load-bearing: deterministic verification needs a machine-readable
policy, not a prompt.

```ts
interface MigrationPolicy {
  policyId: string;
  name: string;                      // "NIST PQC — key transport"
  rules: Array<{
    ruleId: string;
    when: { algorithmPattern: string; usage: CryptoUsage };   // RSA-* + KEY_TRANSPORT
    target: string;                                            // ML-KEM-768
    prohibitedPatterns: string[];    // regexes verification greps for
    requiredPatterns: string[];      // regexes verification requires present
    rationale: string;
  }>;
}
```

### 3.22 `counters`

```ts
interface Counter { _id: string; seq: number }   // "project", "event:PQC-0184", …
```

---

## 4. Relationship map

```text
users (firebase uid)
  └── projects (ownerId)
        ├── project_files ──────────┐
        ├── evidence ◄──────────────┘ (locator.fileId / path / executionRunId)
        │      ▲        ▲        ▲        ▲
        ├── discovery_runs          │        │
        ├── findings ── graph_nodes ── graph_edges
        │      │   ▲          ▲            ▲
        │      │   └── recommendations ────┘
        │      │
        ├── assessments ──► planItems[] ──► findings, graph_nodes
        │        │          snapshot ─────► recommendations
        │        └── approval ──► migration_runs
        │                            ├── baselines ──► invariants[]
        │                            ├── migration_attempts ──► problem_threads
        │                            │        ├── migration_changes
        │                            │        └── execution_runs
        │                            ├── verification_results ──► execution_runs
        │                            └── sandbox_deployments ──► execution_runs
        │
        ├── human_gates      (any phase, including the approval)
        ├── events           (append-only, seq-ordered)
        ├── agent_actions    (append-only audit)
        └── artifacts
```

---

## 5. Indexes

```js
// users
db.users.createIndex({ userId: 1 }, { unique: true });

// projects — landing screen
db.projects.createIndex({ projectId: 1 }, { unique: true });
db.projects.createIndex({ ownerId: 1, "summary.lastActivityAt": -1 });
db.projects.createIndex({ ownerId: 1, stage: 1 });
// Rotation reminders (UX v1.2: 90 days) and revoked-credential sweeps.
db.projects.createIndex({ "repository.credential.rotationDueAt": 1 });
db.projects.createIndex({ "repository.credential.status": 1 });

// events — the two hot reads: replay-after-seq, and the milestone feed
db.events.createIndex({ projectId: 1, seq: 1 }, { unique: true });
db.events.createIndex({ projectId: 1, level: 1, seq: -1 });
db.events.createIndex({ idempotencyKey: 1 }, { unique: true, sparse: true });

// graph
db.graph_nodes.createIndex({ projectId: 1, nodeId: 1 }, { unique: true });
db.graph_nodes.createIndex({ projectId: 1, sequence: 1 });   // ordered reveal
db.graph_edges.createIndex({ projectId: 1, edgeId: 1 }, { unique: true });
db.graph_edges.createIndex({ projectId: 1, fromNodeId: 1 });
db.graph_edges.createIndex({ projectId: 1, toNodeId: 1 });   // reverse traversal

// findings & recommendations
db.findings.createIndex({ projectId: 1, dedupeKey: 1 }, { unique: true });
db.findings.createIndex({ projectId: 1, category: 1, severity: 1 });
db.recommendations.createIndex({ recommendationId: 1 }, { unique: true });
db.recommendations.createIndex({ projectId: 1, status: 1 });

// evidence
db.evidence.createIndex({ projectId: 1, evidenceId: 1 }, { unique: true });

// discovery & migration
db.discovery_runs.createIndex({ projectId: 1, startedAt: -1 });
db.migration_runs.createIndex({ projectId: 1, startedAt: -1 });
db.migration_runs.createIndex({ status: 1, "lease.expiresAt": 1 });  // lease reaping
db.migration_attempts.createIndex({ migrationRunId: 1, attemptNumber: 1 }, { unique: true });
db.migration_changes.createIndex({ migrationRunId: 1, sequence: 1 }, { unique: true });
db.execution_runs.createIndex({ projectId: 1, startedAt: -1 });
db.execution_runs.createIndex({ "provider.cloudBuildId": 1 }, { sparse: true });
db.problem_threads.createIndex({ migrationRunId: 1, problemKey: 1 }, { unique: true });

// gates & artifacts
db.human_gates.createIndex({ projectId: 1, status: 1, openedAt: -1 });
db.artifacts.createIndex({ projectId: 1, kind: 1, generatedAt: -1 });

// policy
db.migration_policies.createIndex({ policyId: 1 }, { unique: true });

// audit
db.agent_actions.createIndex({ projectId: 1, startedAt: -1 });
// The only TTL in the model. agent_actions is the highest-volume collection and
// the least product-facing; events, migration_changes and verification_results
// ARE the audit trail and are never expired.
db.agent_actions.createIndex({ startedAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 });
```

---

## 6. How this satisfies "status must survive a browser refresh"

The workflow is a **server-side state machine persisted in Mongo**; the browser is
a viewer. Five separate concerns, five mechanisms:

**(a) Reopening a project — pure reads, no replay needed.**

```
GET /projects/{id}                → stage, stageDetail, summary, lastEventSeq
GET /projects/{id}/graph          → nodes + edges, ordered by sequence
GET /projects/{id}/findings       → findings + hydrated evidence
GET /projects/{id}/assessment     → assessment + plan items + recommendations
GET /projects/{id}/migration      → run + attempts + changes + verification + sandbox
GET /projects/{id}/events?level=MILESTONE&limit=100
then: SSE /projects/{id}/stream?fromSeq={lastEventSeq}
```

The client reads state, then subscribes for deltas. The stream is a *tail*, never
a source.

**(b) Stream reconnect — `seq` is the whole answer.** Every SSE frame sets
`id: <seq>`. On reconnect the browser sends `Last-Event-ID` automatically; the
server replays `db.events.find({ projectId, seq: { $gt: n } }).sort({ seq: 1 })`
then continues live. Nothing is lost to a dropped connection or a closed laptop.

**(c) Backend restart mid-run.** Both `discovery_runs` and `migration_runs` carry
`checkpoint` (updated at each stage boundary, so a restarted worker resumes at the
last completed milestone) and `lease` (a TTL lease refreshed every ~30 s, so
exactly one instance drives a run).

**(d) Where the work actually runs.** Long-running work is not tied to an HTTP
request. Approval enqueues the run; a **Cloud Run Job** executes it, writing
`checkpoint` and refreshing `lease` as it goes. This is what makes "the workflow
must not depend on the browser remaining open" literally true — the user can close
the tab during `RUNNING_TESTS` and reopen at `SANDBOX_DEPLOYING`.

**(e) Getting events to the right container.** The instance writing events and the
instance holding a given user's SSE connection are, under any scale-out,
*different containers* — so an in-process EventEmitter silently delivers nothing.
Each SSE handler tails a **Mongo change stream** on `events` filtered by
`projectId`: no new infrastructure, correct across instances, roughly twenty
lines. It needs a replica set; Atlas provides one by default. The fallback under
time pressure is pinning to `min=1, max=1` — zero code, but it stops being true
the moment the service scales.

---

## 7. Graph: storage, traversal, and the layout question

**Storage.** The graph is small (14 nodes, 15 edges in the reference scenario) but
written incrementally and read whole. That profile suits a document store; it does
not need a graph database, and the spec correctly says so.

**Traversal — blast radius of a finding:**

```js
db.graph_edges.aggregate([
  { $match: { projectId, toNodeId: "crypto-implementation:cryptoservice" } },
  { $graphLookup: {
      from: "graph_edges",
      startWith: "$fromNodeId",
      connectFromField: "fromNodeId",
      connectToField: "toNodeId",
      as: "upstream",
      maxDepth: 5,
      restrictSearchWithMatch: { projectId }
  }}
]);
```

`$graphLookup` caps at 100 MB per stage and does not work across shards; at this
scale neither matters, and the traversal is one function to swap if it ever does.

**Options considered, and the call:**

| Option | Verdict |
|---|---|
| **Mongo `graph_nodes` + `graph_edges` — chosen** | Zero new infra; idempotent upserts map 1:1 to streamed graph deltas; `$graphLookup` covers impact traversal; edges carry their own evidence and impact, which a nested-JSON blob cannot index. |
| Single embedded `graph: { nodes[], edges[] }` inside `projects` | Every discovery write rewrites the whole array (lost-update races between concurrent tool calls), you cannot index or query edges, and the project doc becomes the contention point. Not recommended even for the hackathon. |
| Neo4j / AuraDB | Explicitly a non-goal in the tech stack, and this graph is far too small to justify a second datastore and a second consistency story. |
| Frontend `react-flow` / `cytoscape` | The rendering layer, not persistence. **React Flow**, fed the same `{nodes, edges}` the API returns. |

**Node identity is the thing to get right.** The deterministic `nodeId` slug is
what keeps the graph from growing duplicates as the agent re-observes the same HSM
across three documents. Compute it in one helper and make node creation always an
upsert.

### The layout question — resolved

The UX offers three graph styles (force, radial, blueprint), each with its own
node positions. **Computed positions are not persisted.**

The client derives positions from a deterministic, seeded layout per style, keyed
off `nodeId`. Persisting three coordinate maps would mean storing derived data
that goes stale on every node insertion — and nodes are inserted continuously
during discovery, which is the entire point of that screen. Stale coordinates on a
live graph are worse than no coordinates.

What *is* persisted is `GraphNode.pin` — a position a user deliberately dragged,
scoped to the style they dragged it in. That is user intent, it does not go stale,
and it is the only part worth surviving a refresh. `sequence` covers the other
half of visual stability: nodes always appear in the order the agent found them.

---

## 8. Adopted decisions

Each closes a gap the base spec leaves open — recorded with the reasoning, because
in six weeks the reasoning is the part that will be missing.

**Enforcement moved out of the prompt and into the schema.** Three product rules
are stated in the spec as instructions to the agent, which means they hold only as
long as the model behaves. They are write-boundary constraints instead:

| Rule | Spec | Enforced by |
|---|---|---|
| Only tools establish facts | §46, Arch §3 | `evidence`: `OBSERVED` requires `producedBy.actor` of `TOOL` or `USER`; `INFERRED` cannot carry confidence 1.0 |
| Never weaken a test to pass | §26 | `migration_changes`: `testIntegrity` required on every `TEST` / `MOCK` / `FIXTURE` change, and `baselineRequirementChanged: true` requires a `gateId` |
| Success is never declared by reasoning | §34, §35 | `verification_results`: a check cannot be `PASS` without an `executionRunId` or evidence; `overall` is computed from `checks` in code, and `cryptoAssertions` cannot influence it |

A prompt asking Gemini not to cheat is a request. A schema that rejects the write
is a guarantee, and it keeps working when the model is swapped.

**`migration_policies` as data, not prose.** Deterministic verification needs a
machine-readable definition of "migrated". In a collection,
`PROHIBITED_CRYPTO_ABSENT` is a grep with a rule id attached — re-runnable,
diffable, citable. In a prompt it is an opinion.

**`problem_threads` with a normalized `problemKey`.** Without a stable failure
signature, `MAX_MEANINGFUL_AUTONOMOUS_ATTEMPTS = 4` never fires: every retry
carries a fresh timestamp, path and duration, so the fourth swing at one problem
looks like a first swing at a fourth problem.

**`events.level` and `events.stage`.** `level` splits the live feed from the audit
trail as one write path and two reads. `stage` stamps each line with the milestone
it happened in — deriving that from the run's *current* stage would relabel
history every time the run advances.

**Human gates are one shape, including the approval.** One component, one
endpoint, one audit record for both the single up-front decision and every
mid-migration pause.

**The approved scope is frozen and versioned.** Regenerating an assessment
produces version N+1. `migration_runs.approval` pins `assessmentId` *and*
`assessmentVersion`, so "what exactly did the human approve?" cannot drift — and
`planItems[].expectedChanges` makes it checkable against what was actually touched.

**Deterministic identity for graph nodes and findings.** Node ids are a pure
function of type plus canonical name; findings dedupe on primitive plus usage plus
location; every graph write is an upsert. This is the single decision that keeps a
long discovery run from degenerating into visual noise.

**Plan mode is separated from finding disposition.** The UX uses different
vocabularies in the two places and it is right to: a disposition says what kind of
problem a finding is, a mode says what the agent will do about it. One
`AUTONOMOUS_MIGRATION` finding produces an `AUTONOMOUS_GENERATION` plan item.

**Recommendations replace "exclusions" and "unresolved items".** UX v1.1 collapsed
two half-overlapping lists into one object with a `disposition`, an `action` and an
`owner`. It is strictly better: the earlier lists said what would not be done
without saying who should do it, and the same items were modelled twice because
they appeared on two screens.

**Live counters are denormalized; everything else is derived.** `migration_runs.
metrics`, `discovery_runs.progress` and `projects.summary.autonomy` are stored
because they update on nearly every event and a live screen reads them per frame.
Stage labels, breadcrumbs, progress rails, CTA text and tile actions are computed.

**Zod as the single source of truth.** Defined once in `schema/`; TypeScript types
via `z.infer`; the same schemas serve as Genkit tool signatures. Gemini's
structured output lands pre-validated in exactly the shape Mongo stores.

---

## 9. UX coverage

Every screen in `requirements/ux design/v1.1/`, and what serves it:

| Screen | Reads |
|---|---|
| Login | `users` |
| Projects | `projects` (one query — `summary` is the tile) |
| Create project | `projects`, `project_files`, `repository.profile`, `repository.credential` (token write-only in; `displayPrefix` + `status` out) |
| Live discovery | `discovery_runs.progress`, `graph_nodes`/`graph_edges` by `sequence`, `events` (MILESTONE + ACTIVITY), `evidence` for the inspector |
| Assessment | `assessments` + `planItems`, `findings` (+ `agentIntent`, `summaryLine`), `evidence` excerpts, `recommendations` |
| Live migration | `migration_runs` (stage, `metrics`, `branch.commitCount`), `events` stamped with `stage`, `migration_attempts`, `problem_threads`, `baselines.invariants`, `verification_results.checks` |
| Sandbox & report | `sandbox_deployments`, `verification_results.cryptoAssertions`, `artifacts`, `recommendations`, `summary.autonomy` |

Persistent header (`AUTONOMOUS COMPLETION`, `HUMAN ENGINEERING ACTIONS`, stage
pill, elapsed) reads `projects.summary.autonomy`, `projects.stage`, and the active
run's `startedAt`.

---

## 10. Build-order shortcut

If time gets tight, this is the collapse that costs least:

| Collapse | Cost |
|---|---|
| `baselines` → embed in `migration_runs` | None. Always 1:1. |
| `discovery_runs` → embed in `projects` | Low. Loses re-run history; discovery runs once in the demo. |
| `verification_results` → embed in `migration_runs` | Low. Loses per-attempt verification history. |
| `problem_threads` → `attempts[].problemKey` + count query | Low. More query work per attempt. |
| `agent_actions` → drop, keep only GCS files | Medium. Weakens the audit report. |
| `users` → derive from the Firebase token per request | Medium. Loses persisted preferences; the graph style resets each session. |
| `recommendations` → embed in `assessments` | **Don't.** They are rendered on four surfaces across two phases; embedding means copying. |
| `evidence` → embed in findings/nodes/edges | **Don't.** Breaks the shared evidence browser and triplicates every citation. |
| `graph_nodes`/`graph_edges` → embed in `projects` | **Don't.** See §7. |

**Minimum viable set for the end-to-end demo (17 collections):** `users`,
`projects`, `project_files`, `evidence`, `discovery_runs`, `findings`,
`graph_nodes`, `graph_edges`, `recommendations`, `assessments`, `migration_runs`,
`migration_attempts`, `migration_changes`, `execution_runs`,
`verification_results`, `human_gates`, `events` — plus `counters`, which is
plumbing. `sandbox_deployments`, `artifacts`, `problem_threads`,
`migration_policies`, `baselines` and `agent_actions` complete the model.
