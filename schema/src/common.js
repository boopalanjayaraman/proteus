import { z } from 'zod';
/** Bumped whenever a document shape changes incompatibly. Cheap now, invaluable later. */
export const SCHEMA_VERSION = 1;
/**
 * Dates arrive either as BSON Dates (from the driver) or ISO strings (from JSON
 * over the API). Coercing means one schema validates both directions.
 */
export const Timestamp = z.coerce.date();
export const baseDocFields = {
    _schemaVersion: z.number().int().default(SCHEMA_VERSION),
    createdAt: Timestamp,
    updatedAt: Timestamp,
};
export const Id = z.string().min(1).max(200);
export const ProjectId = z.string().regex(/^PQC-\d{4,}$/, 'expected PQC-####');
export const FirebaseUid = z.string().min(1);
export const GcsUri = z.string().regex(/^gs:\/\/[^/]+\/.+/, 'expected gs://bucket/object');
export const CommitSha = z.string().regex(/^[0-9a-f]{7,40}$/);
export const Confidence = z.number().min(0).max(1);
export const Percent = z.number().min(0).max(100);
/**
 * Canonical Cloud Storage layout. Every `gcsUri` in the model is produced here so
 * the bucket stays navigable by hand during a demo.
 */
export const gcsPath = {
    uploadedFile: (projectId, fileId, name) => `projects/${projectId}/files/${fileId}/${name}`,
    extractedText: (projectId, fileId) => `projects/${projectId}/extracted/${fileId}.txt`,
    executionLog: (projectId, executionRunId) => `projects/${projectId}/runs/${executionRunId}/log.txt`,
    testReport: (projectId, executionRunId) => `projects/${projectId}/runs/${executionRunId}/tests.xml`,
    changeDiff: (projectId, changeId) => `projects/${projectId}/changes/${changeId}.patch`,
    artifact: (projectId, artifactId, ext) => `projects/${projectId}/artifacts/${artifactId}.${ext}`,
    agentAction: (projectId, agentActionId) => `projects/${projectId}/agent/${agentActionId}.json`,
};
