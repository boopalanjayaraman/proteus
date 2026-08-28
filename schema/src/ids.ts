import type { CryptoUsage, FailureClassification, NodeType, RelationshipType } from './enums';

/**
 * Deterministic identity.
 *
 * A streaming discovery agent re-observes the same HSM across three documents and
 * the same crypto call from two different tools. Identity therefore has to be a
 * pure function of *what the thing is*, so every graph write can be an idempotent
 * upsert that enriches an existing record instead of creating a duplicate.
 *
 * These keys are deliberately readable rather than hashed: you can look at a
 * `dedupeKey` in the database and know exactly which finding it is, and there is
 * no crypto import, so this module is safe to bundle into the browser.
 */

const MAX_KEY_SEGMENT = 120;

/** Lowercase, ASCII-collapsed, punctuation-stripped. Stable across re-observation. */
export function slugify(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_KEY_SEGMENT);
}

/**
 * `crypto-implementation:cryptoservice`
 *
 * `canonicalName` must be the node's real identifier — the class, service or
 * device model — never a paraphrase, because the slug is the upsert key.
 */
export function makeNodeId(type: NodeType, canonicalName: string): string {
  return `${slugify(type)}:${slugify(canonicalName)}`;
}

/** `service:payments-api|STORES_KEY_IN|hsm:thales-p400` */
export function makeEdgeId(
  fromNodeId: string,
  relationship: RelationshipType,
  toNodeId: string,
): string {
  return `${fromNodeId}|${relationship}|${toNodeId}`;
}

/**
 * Findings dedupe on primitive + usage + location. Two RSA-2048 hits in the same
 * file at different lines are two findings; the same hit rediscovered by the
 * document analyzer is one.
 */
export function makeFindingDedupeKey(input: {
  algorithm?: string;
  usage?: CryptoUsage;
  path?: string;
  startLine?: number;
  title: string;
}): string {
  return [
    slugify(input.algorithm ?? 'na'),
    input.usage ?? 'UNKNOWN',
    input.path ? input.path.replace(/^\/+/, '') : slugify(input.title),
    input.startLine != null ? String(input.startLine) : 'na',
  ].join('|');
}

/**
 * Collapses cosmetic variation so the fourth attempt at one problem is
 * recognisable as such. Without this, MAX_MEANINGFUL_AUTONOMOUS_ATTEMPTS is
 * unenforceable — every retry carries a fresh timestamp, path and duration, so
 * it looks like a brand new failure.
 */
export function normalizeErrorSignature(error: string): string {
  return error
    .toLowerCase()
    .replace(/\b[0-9a-f]{7,}\b/g, '<hash>') // commit shas, object ids
    .replace(/\d{4}-\d{2}-\d{2}[t ][\d:.]+z?/g, '<ts>') // timestamps
    .replace(/(?:\/[\w.-]+)+\.\w+/g, '<path>') // absolute paths
    .replace(/:\d+(?::\d+)?/g, ':<n>') // line:col
    .replace(/\d+(?:\.\d+)*/g, '<n>') // versions, counts, durations — no \b:
    //                                     "1203ms" has no word boundary before "ms"
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

/** `MOCK_INCOMPATIBILITY|PartnerHandshakeIntegrationTest|unsupported key exchange ...` */
export function makeProblemKey(input: {
  classification: FailureClassification;
  failedTest?: string;
  error: string;
}): string {
  return [
    input.classification,
    input.failedTest ?? 'na',
    normalizeErrorSignature(input.error),
  ].join('|');
}

/** Per-project event sequence counter id, consumed by `counters`. */
export function eventCounterId(projectId: string): string {
  return `event:${projectId}`;
}

/** Per-run change sequence counter id — produces "Modification #3". */
export function changeCounterId(migrationRunId: string): string {
  return `change:${migrationRunId}`;
}

export const PROJECT_COUNTER_ID = 'project';

/** `PQC-0184` */
export function formatProjectId(seq: number): string {
  return `PQC-${String(seq).padStart(4, '0')}`;
}

/** Avatar monogram: "Amara Osei" → "AO". */
export function initialsOf(displayName: string): string {
  const parts = displayName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase();
}
