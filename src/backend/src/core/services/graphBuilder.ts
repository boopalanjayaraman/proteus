import { makeNodeId, type NodeType, type RelationshipType } from '@proteus/schema';
import type { Candidate, DependencyFinding } from '../discovery/detect';
import type { EnvironmentFact } from '../discovery/environment';
import type { RepositoryProfile } from '@proteus/schema';
import type { GraphService } from './graph';

/**
 * Turns detection results into a graph.
 *
 * The graph answers one question — what depends on what, cryptographically — so
 * this deliberately does not mirror the source tree. A package with no crypto in
 * it is not a node; a class that wraps a session key is.
 */

export interface BuildInput {
  projectId: string;
  profile: RepositoryProfile;
  repositoryName: string;
  candidates: Candidate[];
  dependencies: DependencyFinding[];
  /** Protocols, certificates and boundaries the repository declares. */
  environment?: EnvironmentFact[];
  /** Persists an evidence record and returns its id. */
  saveEvidence: (e: EnvironmentFact['evidence']) => Promise<string>;
  /** Evidence and findings already persisted, keyed by the candidate that produced them. */
  evidenceFor: (c: Candidate) => string[];
  findingFor: (c: Candidate) => string[];
  /** Called for each node and edge the build newly creates, so the feed can narrate it. */
  onCreated?: (kind: 'NODE' | 'EDGE', id: string, label: string) => Promise<void>;
}

/** Which node type a usage belongs to. */
function nodeTypeForUsage(usage: string): NodeType {
  switch (usage) {
    case 'KEY_TRANSPORT':
    case 'KEY_ESTABLISHMENT': return 'ALGORITHM';
    case 'DIGITAL_SIGNATURE': return 'ALGORITHM';
    default: return 'CRYPTO_IMPLEMENTATION';
  }
}

/** How a component relates to the algorithm it uses. */
function relationshipForUsage(usage: string): RelationshipType {
  switch (usage) {
    case 'KEY_TRANSPORT':
    case 'KEY_ESTABLISHMENT': return 'ENCRYPTS_WITH';
    case 'DIGITAL_SIGNATURE': return 'SIGNS_WITH';
    case 'MAC':
    case 'HASHING': return 'USES';
    default: return 'USES';
  }
}

/**
 * The node name for a source file.
 *
 * Exported because `persistCandidates` has to derive the same id when it writes
 * a finding's `nodeIds`. Two spellings of the same component would give the
 * inspector a node id that resolves to nothing — silently, since a missing node
 * looks exactly like a finding with no graph presence.
 */
export const componentName = (path: string): string =>
  path.split('/').pop()?.replace(/\.\w+$/, '') ?? path;

/** The node type a path produces. Test code is a mock, not a component. */
export const componentType = (path: string): 'SOURCE_COMPONENT' | 'TEST_MOCK' =>
  path.includes('/test/') ? 'TEST_MOCK' : 'SOURCE_COMPONENT';

export async function buildGraph(graph: GraphService, input: BuildInput): Promise<number> {
  const { projectId } = input;
  let seq = 0;

  const note = async (kind: 'NODE' | 'EDGE', r: { id: string; created: boolean }, label: string) => {
    if (r.created) await input.onCreated?.(kind, r.id, label);
    return r.id;
  };

  // The application itself, so every dependency has something to hang from.
  const appNode = await graph.upsertNode(projectId, {
    type: 'SERVICE',
    canonicalName: input.repositoryName,
    subtitle: [input.profile.framework, input.profile.languageVersion && `Java ${input.profile.languageVersion}`]
      .filter(Boolean).join(' · '),
    note: `The application under assessment. ${input.profile.fileCount ?? 0} files analysed.`,
    impact: 'UNKNOWN',
  }, seq++);
  const appId = await note('NODE', appNode, input.repositoryName);

  for (const c of input.candidates) {
    const evidenceIds = input.evidenceFor(c);
    const findingIds = input.findingFor(c);

    // The component that holds the call.
    const component = await graph.upsertNode(projectId, {
      type: componentType(c.path),
      canonicalName: componentName(c.path),
      subtitle: c.path,
      note: `Cryptographic implementation found at ${c.path}:${c.line}.`,
      impact: c.quantumVulnerable ? 'MIGRATION_REQUIRED' : 'NO_PQC_CHANGE_REQUIRED',
      attributes: { path: c.path },
      evidenceIds, findingIds,
    }, seq++);

    await note('NODE', component, componentName(c.path));
    await note('EDGE', await graph.upsertEdge(projectId, {
      fromNodeId: appId, toNodeId: component.id, relationship: 'DEPENDS_ON',
      evidenceIds, findingIds,
    }, seq++), `${input.repositoryName} depends on ${componentName(c.path)}`);

    if (!c.algorithm) continue;

    // The algorithm, named by what it is and how it is used — RSA for key
    // transport and RSA for signing are different nodes, because they are
    // different migration questions.
    const algorithmLabel = c.usage === 'UNKNOWN'
      ? c.algorithm
      : `${c.algorithm.split('/')[0]} ${c.usage.replace(/_/g, ' ').toLowerCase()}`;

    const algorithm = await graph.upsertNode(projectId, {
      type: nodeTypeForUsage(c.usage),
      canonicalName: algorithmLabel,
      subtitle: c.algorithm,
      note: c.usage === 'UNKNOWN'
        ? 'Usage not determined from the source. Flagged for investigation.'
        : `Usage classified as ${c.usage.replace(/_/g, ' ').toLowerCase()} by ${c.ruleId}.`,
      impact: c.quantumVulnerable
        ? (c.usage === 'DIGITAL_SIGNATURE' ? 'NO_PQC_CHANGE_REQUIRED' : 'MIGRATION_REQUIRED')
        : 'NO_PQC_CHANGE_REQUIRED',
      attributes: { algorithm: c.algorithm, usage: c.usage, ...(c.keySize ? { keySize: c.keySize } : {}) },
      evidenceIds, findingIds,
    }, seq++);

    await note('NODE', algorithm, algorithmLabel);
    await note('EDGE', await graph.upsertEdge(projectId, {
      fromNodeId: component.id, toNodeId: algorithm.id,
      relationship: relationshipForUsage(c.usage),
      label: c.usage === 'UNKNOWN' ? 'usage undetermined' : undefined,
      impact: c.quantumVulnerable ? 'MIGRATION_REQUIRED' : 'NO_PQC_CHANGE_REQUIRED',
      evidenceIds, findingIds,
    }, seq++), `${componentName(c.path)} → ${algorithmLabel}`);
  }

  // Crypto libraries, and which components depend on them.
  for (const d of input.dependencies) {
    const lib = await graph.upsertNode(projectId, {
      type: 'CRYPTO_LIBRARY',
      canonicalName: `${d.dependencyName} ${d.version}`,
      subtitle: `${d.path}:${d.line}`,
      note: d.capability.reason,
      impact: d.capability.capability === 'NOT_SUPPORTED' ? 'MIGRATION_LIKELY'
        : d.capability.capability === 'UNKNOWN' ? 'DEPENDENCY_REQUIRES_INVESTIGATION'
        : 'NO_PQC_CHANGE_REQUIRED',
      attributes: {
        library: d.dependencyName, version: d.version,
        // Read back by the disposition facts: EXEC-DISP-011 and -012 turn on it.
        capability: d.capability.capability,
      },
    }, seq++);

    await note('NODE', lib, `${d.dependencyName} ${d.version}`);
    await note('EDGE', await graph.upsertEdge(projectId, {
      fromNodeId: appId, toNodeId: lib.id, relationship: 'DEPENDS_ON',
    }, seq++), `${input.repositoryName} depends on ${d.dependencyName}`);
  }

  // What the repository declares rather than calls: the transport it is served
  // over, the certificate that authenticates it, the counterparty it hands a key
  // to. None of this appears in a code scan, and all of it decides a migration.
  for (const f of input.environment ?? []) {
    const evidenceIds = [await input.saveEvidence(f.evidence)];
    const node = await graph.upsertNode(projectId, {
      type: f.kind,
      canonicalName: f.name,
      subtitle: f.detail,
      note: f.note,
      impact: f.kind === 'CERTIFICATE'
        // The CA owns the certificate's algorithm; the repository cannot change it.
        ? (f.quantumVulnerable ? 'VENDOR_CONTROLLED' : 'NO_PQC_CHANGE_REQUIRED')
        : f.kind === 'EXTERNAL_SERVICE'
        ? 'DEPENDENCY_REQUIRES_INVESTIGATION'
        : f.quantumVulnerable ? 'MIGRATION_LIKELY' : 'NO_PQC_CHANGE_REQUIRED',
      attributes: { path: f.path },
      evidenceIds,
    }, seq++);
    await note('NODE', node, f.name);

    // A protocol protects the service; the service reaches out to a boundary.
    // SECURES exists precisely so the TLS → API edge does not lose its direction.
    const edge = f.kind === 'PROTOCOL'
      ? { fromNodeId: node.id, toNodeId: appId, relationship: 'SECURES' as const }
      : f.kind === 'EXTERNAL_SERVICE'
      ? { fromNodeId: appId, toNodeId: node.id, relationship: 'CONNECTS_TO' as const }
      : { fromNodeId: appId, toNodeId: node.id, relationship: 'AUTHENTICATES_WITH' as const };

    await note('EDGE', await graph.upsertEdge(projectId, {
      ...edge,
      impact: f.quantumVulnerable ? 'MIGRATION_LIKELY' : 'NO_PQC_CHANGE_REQUIRED',
      evidenceIds,
    }, seq++), `${f.kind === 'PROTOCOL' ? f.name : input.repositoryName} → ${f.kind === 'PROTOCOL' ? input.repositoryName : f.name}`);
  }

  // Tests, joined to what they cover.
  //
  // The link is by name — `PaymentCipherTest` covers `PaymentCipher` — which is
  // a convention, not a fact, so the edge is only drawn when the covered node
  // actually exists. Guessing an edge into a node nobody observed would put an
  // invented component on the canvas.
  const observed = new Set(
    input.candidates.map((c) => componentName(c.path)),
  );
  for (const name of observed) {
    const covered = name.replace(/(Test|Tests|IT|IntegrationTest)$/, '');
    if (covered === name || !observed.has(covered)) continue;
    await note('EDGE', await graph.upsertEdge(projectId, {
      fromNodeId: makeNodeId('SOURCE_COMPONENT', covered),
      toNodeId: makeNodeId('TEST_MOCK', name),
      relationship: 'TESTED_BY',
    }, seq++), `${covered} tested by ${name}`);
  }

  return seq;
}

export { makeNodeId };
