/**
 * Collection names and index definitions.
 *
 * Typed structurally so this module stays dependency-free and safe to import from
 * the browser bundle; the backend passes these straight to the driver.
 */
export const COLLECTIONS = {
    users: 'users',
    projects: 'projects',
    projectFiles: 'project_files',
    evidence: 'evidence',
    discoveryRuns: 'discovery_runs',
    findings: 'findings',
    graphNodes: 'graph_nodes',
    graphEdges: 'graph_edges',
    recommendations: 'recommendations',
    assessments: 'assessments',
    migrationPolicies: 'migration_policies',
    migrationRuns: 'migration_runs',
    baselines: 'baselines',
    migrationAttempts: 'migration_attempts',
    problemThreads: 'problem_threads',
    migrationChanges: 'migration_changes',
    executionRuns: 'execution_runs',
    verificationResults: 'verification_results',
    sandboxDeployments: 'sandbox_deployments',
    humanGates: 'human_gates',
    events: 'events',
    agentActions: 'agent_actions',
    artifacts: 'artifacts',
    counters: 'counters',
};
/**
 * Nearly every index leads with `projectId`, because that is both the access path
 * and the authorization boundary — no query in this product legitimately crosses
 * projects.
 */
export const INDEXES = {
    [COLLECTIONS.users]: [{ name: 'userId_unique', key: { userId: 1 }, unique: true }],
    [COLLECTIONS.projects]: [
        { name: 'projectId_unique', key: { projectId: 1 }, unique: true },
        // The landing screen: this user's projects, most recently active first.
        { name: 'owner_activity', key: { ownerId: 1, 'summary.lastActivityAt': -1 } },
        { name: 'owner_stage', key: { ownerId: 1, stage: 1 } },
    ],
    [COLLECTIONS.projectFiles]: [
        { name: 'fileId_unique', key: { fileId: 1 }, unique: true },
        { name: 'project_kind', key: { projectId: 1, kind: 1 } },
    ],
    [COLLECTIONS.evidence]: [
        { name: 'evidenceId_unique', key: { projectId: 1, evidenceId: 1 }, unique: true },
        { name: 'project_class', key: { projectId: 1, evidenceClass: 1 } },
    ],
    [COLLECTIONS.discoveryRuns]: [
        { name: 'discoveryRunId_unique', key: { discoveryRunId: 1 }, unique: true },
        { name: 'project_started', key: { projectId: 1, startedAt: -1 } },
    ],
    [COLLECTIONS.findings]: [
        { name: 'findingId_unique', key: { findingId: 1 }, unique: true },
        // Idempotent re-discovery: the same finding from a second tool is an update.
        { name: 'project_dedupe', key: { projectId: 1, dedupeKey: 1 }, unique: true },
        { name: 'project_category_severity', key: { projectId: 1, category: 1, severity: 1 } },
        { name: 'project_status', key: { projectId: 1, status: 1 } },
    ],
    [COLLECTIONS.graphNodes]: [
        { name: 'node_unique', key: { projectId: 1, nodeId: 1 }, unique: true },
        // Ordered reveal — the graph rebuilds in the order the agent found things.
        { name: 'project_sequence', key: { projectId: 1, sequence: 1 } },
        { name: 'project_impact', key: { projectId: 1, impact: 1 } },
    ],
    [COLLECTIONS.graphEdges]: [
        { name: 'edge_unique', key: { projectId: 1, edgeId: 1 }, unique: true },
        { name: 'project_sequence', key: { projectId: 1, sequence: 1 } },
        { name: 'project_from', key: { projectId: 1, fromNodeId: 1 } },
        // Reverse traversal — "what depends on this?" is the blast-radius query.
        { name: 'project_to', key: { projectId: 1, toNodeId: 1 } },
    ],
    [COLLECTIONS.recommendations]: [
        { name: 'recommendationId_unique', key: { recommendationId: 1 }, unique: true },
        { name: 'project_status', key: { projectId: 1, status: 1 } },
    ],
    [COLLECTIONS.assessments]: [
        { name: 'assessmentId_unique', key: { assessmentId: 1 }, unique: true },
        { name: 'project_version', key: { projectId: 1, version: -1 } },
    ],
    [COLLECTIONS.migrationPolicies]: [
        { name: 'policyId_unique', key: { policyId: 1 }, unique: true },
    ],
    [COLLECTIONS.migrationRuns]: [
        { name: 'migrationRunId_unique', key: { migrationRunId: 1 }, unique: true },
        { name: 'project_started', key: { projectId: 1, startedAt: -1 } },
        // Lease reaping: find runs whose holder died mid-migration.
        { name: 'lease_expiry', key: { status: 1, 'lease.expiresAt': 1 } },
    ],
    [COLLECTIONS.baselines]: [
        { name: 'baselineId_unique', key: { baselineId: 1 }, unique: true },
        { name: 'run_captured', key: { migrationRunId: 1, capturedAt: -1 } },
    ],
    [COLLECTIONS.migrationAttempts]: [
        { name: 'attemptId_unique', key: { attemptId: 1 }, unique: true },
        { name: 'run_attempt', key: { migrationRunId: 1, attemptNumber: 1 }, unique: true },
        { name: 'run_problem', key: { migrationRunId: 1, problemKey: 1 }, sparse: true },
    ],
    [COLLECTIONS.problemThreads]: [
        { name: 'run_problem_unique', key: { migrationRunId: 1, problemKey: 1 }, unique: true },
        { name: 'project_status', key: { projectId: 1, status: 1 } },
    ],
    [COLLECTIONS.migrationChanges]: [
        { name: 'changeId_unique', key: { changeId: 1 }, unique: true },
        { name: 'run_sequence', key: { migrationRunId: 1, sequence: 1 }, unique: true },
        { name: 'run_attempt', key: { migrationRunId: 1, attemptId: 1 } },
    ],
    [COLLECTIONS.executionRuns]: [
        { name: 'executionRunId_unique', key: { executionRunId: 1 }, unique: true },
        { name: 'project_started', key: { projectId: 1, startedAt: -1 } },
        // Cloud Build status callbacks arrive knowing only the build id.
        { name: 'cloudbuild_lookup', key: { 'provider.cloudBuildId': 1 }, sparse: true },
    ],
    [COLLECTIONS.verificationResults]: [
        { name: 'verificationResultId_unique', key: { verificationResultId: 1 }, unique: true },
        { name: 'run_verified', key: { migrationRunId: 1, verifiedAt: -1 } },
    ],
    [COLLECTIONS.sandboxDeployments]: [
        { name: 'sandboxDeploymentId_unique', key: { sandboxDeploymentId: 1 }, unique: true },
        { name: 'run_deployed', key: { migrationRunId: 1, deployedAt: -1 } },
    ],
    [COLLECTIONS.humanGates]: [
        { name: 'gateId_unique', key: { gateId: 1 }, unique: true },
        { name: 'project_status', key: { projectId: 1, status: 1, openedAt: -1 } },
    ],
    [COLLECTIONS.events]: [
        // The two hot reads: replay-after-seq, and the milestone feed.
        { name: 'project_seq_unique', key: { projectId: 1, seq: 1 }, unique: true },
        { name: 'project_level_seq', key: { projectId: 1, level: 1, seq: -1 } },
        { name: 'idempotency', key: { idempotencyKey: 1 }, unique: true, sparse: true },
    ],
    [COLLECTIONS.agentActions]: [
        { name: 'agentActionId_unique', key: { agentActionId: 1 }, unique: true },
        { name: 'project_started', key: { projectId: 1, startedAt: -1 } },
        // The only TTL in the model. Events, changes and verification results ARE the
        // audit trail and are never expired.
        { name: 'ttl_30d', key: { startedAt: 1 }, expireAfterSeconds: 60 * 60 * 24 * 30 },
    ],
    [COLLECTIONS.artifacts]: [
        { name: 'artifactId_unique', key: { artifactId: 1 }, unique: true },
        { name: 'project_kind', key: { projectId: 1, kind: 1, generatedAt: -1 } },
    ],
    [COLLECTIONS.counters]: [],
};
