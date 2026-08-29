import { z } from 'zod';
import {
  CommitSha,
  FirebaseUid,
  GcsUri,
  Id,
  ProjectId,
  Timestamp,
  baseDocFields,
} from './common';
import {
  ChangeType,
  ExecutionKind,
  ExecutionPhase,
  FailureClassification,
  MigrationStage,
  TEST_ENGINEERING_CHANGE_TYPES,
} from './enums';

/** Autonomous migration: runs, baselines, attempts, changes, executions. */

/**
 * What the user is told the migration will do, as data (spec §20).
 *
 * Stored here rather than written into the modal because two surfaces need the
 * same words: the confirmation dialog that obtains consent, and the approval
 * record that proves what was consented to. A list that lives only in JSX can
 * drift from behaviour with nothing to catch it.
 *
 * Each item names the migration stages that carry it out, which turns "the
 * wording matches the behaviour" into an assertion: every `MigrationStage` must
 * be disclosed by something here before the user is asked to approve it.
 *
 * The list is the union of spec §20's sixteen bullets and the UX v1.2 modal.
 * Where they differ the longer list wins in both directions — under-disclosing
 * is the only failure mode that matters, so the spec's "validate the existing
 * tests" and "rebuild and retest" are kept even though the mock drops them, and
 * the mock's end-to-end verification is kept even though §20 omits it.
 */
export const MIGRATION_DISCLOSURE = [
  { text: 'create a migration branch', stages: ['PREPARING_MIGRATION', 'CREATING_BRANCH'] },
  { text: 'capture and validate the behavioural baseline', stages: ['CAPTURING_BASELINE'] },
  {
    text: 'assess test coverage and generate or extend automated tests where required',
    stages: ['ASSESSING_TEST_COVERAGE', 'CREATING_TESTS'],
  },
  { text: 'generate or modify mocks', stages: ['PREPARING_MOCKS'] },
  { text: 'validate the existing tests', stages: ['VALIDATING_BASELINE_TESTS'] },
  { text: 'modify source code', stages: ['APPLYING_MIGRATION_CHANGES'] },
  {
    text: 'modify dependencies and configuration when appropriate',
    stages: ['APPLYING_MIGRATION_CHANGES'],
  },
  { text: 'build the application', stages: ['BUILDING'] },
  { text: 'execute the test suite', stages: ['RUNNING_TESTS'] },
  { text: 'inspect and classify failures', stages: ['ANALYZING_FAILURE'] },
  { text: 'autonomously attempt repairs', stages: ['REPAIRING'] },
  { text: 'rebuild and retest', stages: ['REBUILDING', 'RETESTING'] },
  { text: 'verify the resulting cryptographic state', stages: ['CRYPTO_VERIFYING'] },
  { text: 'deploy a verified build into a sandbox environment', stages: ['SANDBOX_DEPLOYING'] },
  {
    text: 'run end-to-end verification against the sandbox deployment',
    stages: ['END_TO_END_VERIFYING'],
  },
  // An output of the sandbox stage rather than a stage of its own, but disclosed
  // because it is the thing the user is handed at the end of it.
  { text: 'provide a link to the sandbox-deployed application', stages: [] },
  { text: 'produce a complete migration evidence report', stages: ['COMPLETED'] },
] as const satisfies readonly { text: string; stages: readonly MigrationStage[] }[];

/** The disclosure as the modal renders it and the approval record stores it. */
export const MIGRATION_DISCLOSURE_TEXT: readonly string[] =
  MIGRATION_DISCLOSURE.map((d) => d.text);

/**
 * The counterweight to the list above, and the reason one approval is enough.
 *
 * Shown beneath the disclosure and stored on the gate: the boundary is part of
 * what was agreed, not a reassurance added at render time.
 */
export const MIGRATION_UNTOUCHED_STATEMENT =
  'The original branch, production systems, HSM configuration and vendor-controlled '
  + 'devices remain untouched. A new human gate is raised only if a consequential '
  + 'boundary is crossed.';

/** The two answers to the approval gate. Modelled so the audit record names one. */
export const APPROVE_OPTION_ID = 'APPROVE';
export const DECLINE_OPTION_ID = 'DECLINE';

export const MigrationRun = z.object({
  ...baseDocFields,
  migrationRunId: Id,
  projectId: ProjectId,

  /** Exactly what the human authorized, frozen (spec §20). */
  approval: z.object({
    assessmentId: Id,
    assessmentVersion: z.number().int().positive(),
    approvedPlanItemIds: z.array(Id),
    approvedBy: FirebaseUid,
    approvedAt: Timestamp,
    /** The 14-item disclosure list the user confirmed — consent, auditable. */
    acknowledgedActions: z.array(z.string()),
  }),

  branch: z.object({
    name: z.string(), // "agent/pqc/PQC-0184"
    baseCommitSha: CommitSha,
    headCommitSha: CommitSha.optional(),
    createdAt: Timestamp.optional(),
    pushed: z.boolean().default(false),
    prUrl: z.string().url().optional(),
    /** Rendered as "BASE 7c41ab9 · 6 COMMITS". */
    commitCount: z.number().int().nonnegative().default(0),
  }),

  stage: MigrationStage,
  stageEnteredAt: Timestamp,
  status: z.enum(['RUNNING', 'PAUSED_FOR_HUMAN', 'COMPLETED', 'FAILED', 'ABANDONED']),

  baselineId: Id.optional(),
  attemptCount: z.number().int().nonnegative().default(0),
  currentAttemptId: Id.optional(),

  /**
   * The live tiles above the migration feed. Denormalized deliberately: they
   * change on almost every event, and joining three collections per SSE frame to
   * recompute them is the one case where storing derived data is cheaper than
   * deriving it.
   */
  metrics: z.object({
    testsPassing: z.number().int().nonnegative().default(0),
    testsFailing: z.number().int().nonnegative().default(0),
    autonomousRepairs: z.number().int().nonnegative().default(0),
    humanGatesOpened: z.number().int().nonnegative().default(0),
    cloudBuildAttempts: z.number().int().nonnegative().default(0),
  }),

  /**
   * Written at every stage boundary. Cloud Run can evict the instance running the
   * agent loop mid-migration; this is what lets a restarted worker resume at the
   * last completed milestone instead of from scratch.
   */
  checkpoint: z.object({
    stage: MigrationStage,
    cursor: z.record(z.string(), z.unknown()).optional(),
    at: Timestamp,
  }),

  /**
   * TTL lease, refreshed while working. Guarantees a single writer, so neither a
   * double-clicked Approve nor a scale-out event can start two migrations.
   */
  lease: z.object({ holder: z.string(), expiresAt: Timestamp }).optional(),

  outcome: z.enum(['VERIFIED', 'PARTIALLY_MIGRATED', 'HUMAN_ACTION_REQUIRED']).optional(),
  startedAt: Timestamp,
  /** With `startedAt`, yields the "11:42 END TO END" figure. */
  completedAt: Timestamp.optional(),
});
export type MigrationRun = z.infer<typeof MigrationRun>;

// ---------------------------------------------------------------------------
// Baseline behavioural contract (spec §24)
// ---------------------------------------------------------------------------

export const BehavioralInvariant = z.object({
  invariantId: Id,
  kind: z.enum([
    'API_BEHAVIOR',
    'CRYPTO_OUTCOME',
    'FAILURE_MODE',
    'MESSAGE_FORMAT',
    'FUNCTIONAL_OUTCOME',
  ]),
  description: z.string(), // "Malformed peer key → 400"
  /** Executable predicate or test id — re-run verbatim during verification. */
  assertion: z.string(),
  capturedFrom: z.enum(['EXISTING_TEST', 'GENERATED_PROBE', 'RUNTIME_OBSERVATION']),

  /**
   * Whether the migration must preserve this, or is expected to change it.
   *
   * The baseline observes two different kinds of thing and they cannot share a
   * verdict. `POST /settlements` returning 201 must survive; the wrapped key
   * being 256 bytes must NOT — RSA-2048 wraps to 256, ML-KEM-768 produces 1088,
   * and that difference is the migration working.
   *
   * Verification ASSERTS the MUST_PRESERVE set and REPORTS the
   * EXPECTED_TO_CHANGE set before-and-after. Asserting both would fail a correct
   * migration; recording only the first would hide a material change from the
   * report. See EXEC-INV-003 and EXEC-VER-005.
   */
  disposition: z.enum(['MUST_PRESERVE', 'EXPECTED_TO_CHANGE']),

  /** Set on an EXPECTED_TO_CHANGE invariant once verification has re-run it. */
  observedAfter: z.string().optional(),

  evidenceIds: z.array(Id).default([]),
});
export type BehavioralInvariant = z.infer<typeof BehavioralInvariant>;

export const Baseline = z.object({
  ...baseDocFields,
  baselineId: Id,
  projectId: ProjectId,
  migrationRunId: Id,
  commitSha: CommitSha,

  build: z.object({
    executionRunId: Id,
    passed: z.boolean(),
    durationMs: z.number().int().nonnegative(),
  }),

  tests: z.object({
    executionRunId: Id,
    total: z.number().int().nonnegative(),
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    /**
     * Pre-existing failures. The migration is never blamed for these, and the
     * final report states explicitly that they are unchanged.
     */
    knownFailures: z
      .array(z.object({ testId: z.string(), name: z.string(), message: z.string().optional() }))
      .default([]),
    inventory: z
      .array(
        z.object({
          testId: z.string(),
          name: z.string(),
          suite: z.string(),
          status: z.enum(['PASSED', 'FAILED', 'SKIPPED']),
        }),
      )
      .default([]),
  }),

  /** Rendered as the "BASELINE CONTRACT" checklist. */
  invariants: z.array(BehavioralInvariant).default([]),
  capturedAt: Timestamp,
});
export type Baseline = z.infer<typeof Baseline>;

// ---------------------------------------------------------------------------
// Attempts (spec §27, §28, §31, §33)
// ---------------------------------------------------------------------------

/**
 * Compact by construction: full logs stay in GCS, this is what Gemini sees — and
 * what the migration feed renders verbatim as a JSON block.
 */
export const StructuredFailure = z.object({
  phase: ExecutionPhase,
  command: z.string(),
  exitCode: z.number().int(),
  failedTests: z
    .array(
      z.object({
        name: z.string(),
        message: z.string(),
        stackHead: z.string().optional(),
      }),
    )
    .default([]),
  error: z.string(),
  /** Deterministically extracted, capped — never the raw log dump. */
  relevantLogs: z.array(z.string()).max(20).default([]),
  fullLogGcsUri: GcsUri.optional(),
});
export type StructuredFailure = z.infer<typeof StructuredFailure>;

export const Diagnosis = z.object({
  classification: FailureClassification,
  rootCause: z.string(),
  reasoning: z.string(),
  withinAutonomousBoundary: z.boolean(),
  /** Spec §26 — if true, the agent must open a gate, not edit the test. */
  baselineRequirementChanged: z.boolean(),
  proposedAction: z.string(),
  evidenceIds: z.array(Id).default([]),
  modelRef: z.object({ model: z.string(), agentActionId: Id }),
});
export type Diagnosis = z.infer<typeof Diagnosis>;

export const MigrationAttempt = z.object({
  ...baseDocFields,
  attemptId: Id,
  projectId: ProjectId,
  migrationRunId: Id,
  /** One document per meaningful engineering cycle, not per command. */
  attemptNumber: z.number().int().positive(),

  intent: z.string(),
  planItemIds: z.array(Id).default([]),
  changeIds: z.array(Id).default([]),
  executionRunIds: z.array(Id).default([]),

  failure: StructuredFailure.optional(),
  diagnosis: Diagnosis.optional(),

  /** Groups repeated swings at the same unresolved problem. */
  problemKey: z.string().optional(),

  result: z.enum(['PENDING', 'SUCCEEDED', 'FAILED', 'ABANDONED', 'ESCALATED']),
  startedAt: Timestamp,
  endedAt: Timestamp.optional(),
});
export type MigrationAttempt = z.infer<typeof MigrationAttempt>;

/**
 * Makes MAX_MEANINGFUL_AUTONOMOUS_ATTEMPTS enforceable, and drives the
 * "1 / 4 MEANINGFUL ATTEMPTS" counter. Without a stable problem signature you
 * cannot tell a fresh failure from the fourth attempt at the same one, and the
 * retry budget silently never fires.
 */
export const ProblemThread = z.object({
  ...baseDocFields,
  problemKey: z.string(),
  projectId: ProjectId,
  migrationRunId: Id,
  classification: FailureClassification,
  signature: z.string(),
  meaningfulAttempts: z.number().int().nonnegative().default(0),
  attemptIds: z.array(Id).default([]),
  status: z.enum(['ACTIVE', 'RESOLVED', 'ESCALATED']),
  firstSeenAt: Timestamp,
});
export type ProblemThread = z.infer<typeof ProblemThread>;

// ---------------------------------------------------------------------------
// Changes (spec §25, §26, §27)
// ---------------------------------------------------------------------------

/**
 * Anti-test-cheating record. Required on every TEST, MOCK or FIXTURE change, so
 * "why was it safe to edit this test?" is answerable months later from data
 * rather than from a transcript. The migration feed renders it verbatim.
 */
export const TestIntegrityRecord = z.object({
  failureClassification: FailureClassification,
  reason: z.string(),
  baselineRequirementChanged: z.boolean(),
  safeAutonomousModification: z.boolean(),
  /** Set when baselineRequirementChanged is true — the change needs a gate. */
  gateId: Id.optional(),
});
export type TestIntegrityRecord = z.infer<typeof TestIntegrityRecord>;

export const MigrationChange = z
  .object({
    ...baseDocFields,
    changeId: Id,
    projectId: ProjectId,
    migrationRunId: Id,
    attemptId: Id,
    /** Renders as "Modification #3". */
    sequence: z.number().int().positive(),

    changeType: ChangeType,
    intent: z.enum(['MIGRATION', 'REPAIR', 'TEST_ENGINEERING', 'ROLLBACK']),

    summary: z.string(), // "Migrated CryptoService to ML-KEM-768"
    rationale: z.string(),
    findingIds: z.array(Id).default([]),
    planItemIds: z.array(Id).default([]),

    files: z
      .array(
        z.object({
          path: z.string(),
          operation: z.enum(['ADDED', 'MODIFIED', 'DELETED']),
          linesAdded: z.number().int().nonnegative().default(0),
          linesRemoved: z.number().int().nonnegative().default(0),
        }),
      )
      .default([]),
    commitSha: CommitSha.optional(),
    /** Full patch in GCS; Mongo keeps the shape and the reasoning. */
    diffGcsUri: GcsUri.optional(),

    testIntegrity: TestIntegrityRecord.optional(),

    verificationOutcome: z
      .enum(['PENDING', 'BUILD_PASS', 'TEST_PASS', 'FAILED', 'REVERTED'])
      .default('PENDING'),
    revertedByChangeId: Id.optional(),
    appliedAt: Timestamp,
  })
  .superRefine((change, ctx) => {
    const needsIntegrity = (TEST_ENGINEERING_CHANGE_TYPES as readonly string[]).includes(
      change.changeType,
    );
    if (needsIntegrity && !change.testIntegrity) {
      ctx.addIssue({
        code: 'custom',
        path: ['testIntegrity'],
        message: `${change.changeType} changes require a testIntegrity record (spec §26)`,
      });
    }
    if (change.testIntegrity?.baselineRequirementChanged === true && !change.testIntegrity.gateId) {
      ctx.addIssue({
        code: 'custom',
        path: ['testIntegrity', 'gateId'],
        message: 'changing a baseline behavioural requirement requires an open human gate',
      });
    }
  });
export type MigrationChange = z.infer<typeof MigrationChange>;

// ---------------------------------------------------------------------------
// Executions — where tools establish truth
// ---------------------------------------------------------------------------

export const ExecutionRun = z.object({
  ...baseDocFields,
  executionRunId: Id,
  projectId: ProjectId,
  migrationRunId: Id.optional(),
  attemptId: Id.optional(),

  kind: ExecutionKind,
  environment: z.enum(['CLOUD_BUILD', 'CLOUD_RUN_SANDBOX']),

  provider: z.object({
    cloudBuildId: z.string().optional(),
    cloudRunService: z.string().optional(),
    region: z.string().optional(),
    logUrl: z.string().url().optional(),
  }),

  commitSha: CommitSha,
  command: z.string(), // "mvn -q verify"
  exitCode: z.number().int().optional(),
  status: z.enum(['QUEUED', 'RUNNING', 'SUCCESS', 'FAILURE', 'TIMEOUT', 'CANCELLED']),

  tests: z
    .object({
      total: z.number().int().nonnegative(),
      passed: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
      skipped: z.number().int().nonnegative(),
      failures: z
        .array(
          z.object({
            testId: z.string(),
            name: z.string(),
            suite: z.string(),
            message: z.string(),
            stackHead: z.string().optional(),
          }),
        )
        .default([]),
      reportGcsUri: GcsUri.optional(),
    })
    .optional(),

  artifacts: z
    .object({ imageUri: z.string().optional(), imageDigest: z.string().optional() })
    .optional(),

  logGcsUri: GcsUri.optional(),
  logExcerpt: z.array(z.string()).max(50).default([]),

  startedAt: Timestamp,
  finishedAt: Timestamp.optional(),
  durationMs: z.number().int().nonnegative().optional(),
});
export type ExecutionRun = z.infer<typeof ExecutionRun>;
