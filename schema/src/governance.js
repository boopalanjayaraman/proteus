import { z } from 'zod';
import { FirebaseUid, GcsUri, Id, ProjectId, Timestamp, baseDocFields } from './common';
import { EventActor, EventLevel, EventPhase, EventSeverity, EventType, HumanGateType, Stage, } from './enums';
/** Human gates, the event log, and the full agent audit trail. */
/**
 * Screen 3's migration approval is modelled as a gate too, so one component, one
 * endpoint and one audit shape cover both the single up-front approval and every
 * mid-migration pause (spec §20, §30; Architecture §23).
 */
export const HumanGate = z.object({
    ...baseDocFields,
    gateId: Id,
    projectId: ProjectId,
    migrationRunId: Id.optional(),
    attemptId: Id.optional(),
    type: HumanGateType,
    /** False lets unrelated approved work continue while this waits. */
    blocking: z.boolean().default(true),
    title: z.string(),
    question: z.string(),
    context: z.string(),
    evidenceIds: z.array(Id).default([]),
    relatedFindingIds: z.array(Id).default([]),
    relatedChangeIds: z.array(Id).default([]),
    options: z
        .array(z.object({
        optionId: z.string(),
        label: z.string(),
        detail: z.string().optional(),
        consequence: z.string().optional(),
    }))
        .min(1),
    status: z.enum(['OPEN', 'RESOLVED', 'EXPIRED', 'WITHDRAWN']),
    resolution: z
        .object({
        optionId: z.string(),
        note: z.string().optional(),
        resolvedBy: FirebaseUid,
        resolvedAt: Timestamp,
    })
        .optional(),
    openedAt: Timestamp,
});
export const ResolveGateInput = z.object({
    optionId: z.string(),
    note: z.string().max(5000).optional(),
});
// ---------------------------------------------------------------------------
// Events (spec §38, §41, §42)
// ---------------------------------------------------------------------------
/** Sparse cross-references — this is what makes a feed line clickable. */
export const EventRefs = z.object({
    findingId: Id.optional(),
    nodeId: z.string().optional(),
    edgeId: z.string().optional(),
    attemptId: Id.optional(),
    changeId: Id.optional(),
    executionRunId: Id.optional(),
    gateId: Id.optional(),
    assessmentId: Id.optional(),
    recommendationId: Id.optional(),
    sandboxDeploymentId: Id.optional(),
    evidenceIds: z.array(Id).optional(),
    /**
     * File chips rendered on the feed line. Denormalized from the change so a
     * streaming feed does not need a lookup per row.
     */
    paths: z.array(z.string()).optional(),
});
export const ProjectEvent = z.object({
    _schemaVersion: z.number().int().default(1),
    eventId: Id,
    projectId: ProjectId,
    /**
     * Per-project monotonic. Serves as the SSE `id:` frame, so a reconnecting
     * browser's Last-Event-ID header is all the server needs to replay exactly what
     * was missed. This is the whole resumability story for the stream.
     */
    seq: z.number().int().positive(),
    ts: Timestamp,
    type: EventType,
    phase: EventPhase,
    /**
     * The fine-grained stage at emission. Every line in the migration feed is
     * stamped with the stage it happened in ("APPLYING CHANGES", "REPAIRING"), and
     * reconstructing that from the run's *current* stage would relabel history
     * every time the run advances.
     */
    stage: Stage.optional(),
    level: EventLevel,
    severity: EventSeverity.default('INFO'),
    title: z.string().min(1),
    /** The detail block. May carry a JSON string — structured failure evidence is
     *  rendered verbatim in the feed. */
    message: z.string().optional(),
    payload: z.record(z.string(), z.unknown()).optional(),
    refs: EventRefs.default({}),
    actor: EventActor,
    /** Unique when present — makes agent retries safe against double emission. */
    idempotencyKey: z.string().optional(),
});
/** What an emitter supplies; `eventId`, `seq` and `ts` are assigned server-side. */
export const EmitEventInput = ProjectEvent.omit({
    _schemaVersion: true,
    eventId: true,
    seq: true,
    ts: true,
    projectId: true,
});
/** Levels the live activity feed renders; DETAIL is audit-drawer only (spec §38). */
export const LIVE_FEED_LEVELS = ['MILESTONE', 'ACTIVITY'];
// ---------------------------------------------------------------------------
// Audit trail (spec §39)
// ---------------------------------------------------------------------------
/**
 * Every model turn and every tool call. This is the collection that lets the
 * migration report show the exact command, commit and build output without
 * bloating any product-facing document.
 */
export const AgentAction = z.object({
    ...baseDocFields,
    agentActionId: Id,
    projectId: ProjectId,
    migrationRunId: Id.optional(),
    attemptId: Id.optional(),
    kind: z.enum(['MODEL_TURN', 'TOOL_CALL']),
    toolName: z.string().optional(),
    input: z.record(z.string(), z.unknown()).optional(),
    output: z.record(z.string(), z.unknown()).optional(),
    /** Large payloads spill to GCS rather than into the document. */
    outputGcsUri: GcsUri.optional(),
    model: z
        .object({
        name: z.string(),
        promptTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
        latencyMs: z.number().int().nonnegative(),
    })
        .optional(),
    promptGcsUri: GcsUri.optional(),
    status: z.enum(['SUCCESS', 'ERROR']),
    error: z.string().optional(),
    startedAt: Timestamp,
    endedAt: Timestamp,
});
/** Sequence allocation for projects, events and change numbering. */
export const Counter = z.object({
    _id: z.string(),
    seq: z.number().int().nonnegative(),
});
