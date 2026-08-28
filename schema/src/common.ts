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
  uploadedFile: (projectId: string, fileId: string, name: string) =>
    `projects/${projectId}/files/${fileId}/${name}`,
  extractedText: (projectId: string, fileId: string) =>
    `projects/${projectId}/extracted/${fileId}.txt`,
  executionLog: (projectId: string, executionRunId: string) =>
    `projects/${projectId}/runs/${executionRunId}/log.txt`,
  testReport: (projectId: string, executionRunId: string) =>
    `projects/${projectId}/runs/${executionRunId}/tests.xml`,
  changeDiff: (projectId: string, changeId: string) =>
    `projects/${projectId}/changes/${changeId}.patch`,
  artifact: (projectId: string, artifactId: string, ext: string) =>
    `projects/${projectId}/artifacts/${artifactId}.${ext}`,
  agentAction: (projectId: string, agentActionId: string) =>
    `projects/${projectId}/agent/${agentActionId}.json`,
} as const;
