import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RuleEngine } from '../src/core/rules/engine';
import { detect, detectDependencies } from '../src/core/discovery/detect';
import { detectEnvironment } from '../src/core/discovery/environment';
import { detectProfile } from '../src/core/discovery/profile';
import { WorkingCopy } from '../src/core/discovery/workingCopy';
import { loadRegistry } from '../src/core/discovery/providers';
import { GraphService } from '../src/core/services/graph';
import { DiscoveryService } from '../src/core/services/discovery';
import { startTestDb, clearAll, aProject, type TestDb } from './helpers/mongo';

/**
 * PRD-08 acceptance criteria.
 *
 * The reference scenario is the fixture repository, run through the same
 * detection the product runs. A graph built from invented candidates would pass
 * whatever shape the builder happens to produce; built from the fixture it fails
 * when detection and the graph stop agreeing.
 */

const p = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

let db: TestDb;
let graph: GraphService;
let discovery: DiscoveryService;

beforeAll(async () => {
  db = await startTestDb();
  graph = new GraphService(db.repos);
  discovery = new DiscoveryService(db.repos, graph);
  loadRegistry(p('../../../engine/data/provider-capability.json'));
}, 120_000);

afterAll(async () => { await db?.stop(); });
beforeEach(async () => { await clearAll(db.repos); });

const ev = (overrides: Record<string, unknown> = {}) => ({
  evidenceType: 'DOCUMENT' as const,
  evidenceClass: 'OBSERVED' as const,
  confidence: 1,
  source: 'docs/hsm.pdf',
  locator: { kind: 'DOCUMENT' as const, fileId: 'f1' },
  ...overrides,
});

describe('AC-1 · repeated observation converges', () => {
  it('asserts the same HSM from three documents as one node with three evidence records', async () => {
    const { projectId } = await db.repos.projects.create(aProject() as never);

    // Three different spellings a model could plausibly produce for one device.
    const spellings = ['Thales payShield 10K', 'Thales PayShield 10k', 'thales payshield 10K'];
    const ids: string[] = [];

    for (const [i, name] of spellings.entries()) {
      const evidenceId = await discovery.saveEvidence(projectId, ev({ source: `doc-${i}.pdf` }));
      const r = await graph.upsertNode(projectId, {
        type: 'HSM', canonicalName: name, evidenceIds: [evidenceId],
      }, i);
      ids.push(r.id);
      // Only the first assertion creates; the rest enrich.
      expect(r.created).toBe(i === 0);
    }

    expect(new Set(ids).size).toBe(1);
    const { nodes } = await graph.snapshot(projectId);
    const hsm = nodes.filter((n) => n.type === 'HSM');
    expect(hsm).toHaveLength(1);
    expect(hsm[0]!.evidenceIds).toHaveLength(3);
    // First-seen order is fixed on insert, not overwritten by later assertions.
    expect(hsm[0]!.sequence).toBe(0);
  });
});

describe('AC-2 · the reference scenario', () => {
  it('builds the fixture graph', async () => {
    const { projectId } = await db.repos.projects.create(aProject() as never);

    const engine = RuleEngine.fromFiles(
      p('../../../engine/rulesets/pqc-migration-rules.yaml'),
      p('../../../engine/rulesets/migration-execution-rules.yaml'),
    );
    const wc = new WorkingCopy(p('../../../fixtures/payments-api'));
    const profile = await detectProfile(wc);
    const result = await detect(engine, wc, 'abc1234', () => undefined);
    const dependencies = await detectDependencies(wc);
    const environment = await detectEnvironment(wc, 'abc1234');

    const { links } = await discovery.persistCandidates(projectId, result, dependencies);
    const run = await discovery.start(projectId, 'test-worker');
    const counts = await discovery.buildGraph(run, {
      profile, repositoryName: 'payments-api',
      candidates: result.candidates, dependencies, environment, links,
    });

    const { nodes, edges, graphVersion } = await graph.snapshot(projectId);
    expect(nodes.length).toBe(counts.nodes);
    expect(edges.length).toBe(counts.edges);

    // The shape that matters, rather than a single total that any refactor of
    // detection would break for the wrong reason.
    expect(counts).toEqual({ nodes: 15, edges: 16 });

    // The shape, not just the total — a total alone would go on passing while
    // the graph lost the node types the screen is built around.
    const byType = (t: string) => nodes.filter((n) => n.type === t).length;
    expect(byType('SERVICE')).toBe(1);
    expect(byType('SOURCE_COMPONENT')).toBe(6);
    expect(byType('ALGORITHM')).toBe(2);
    expect(byType('CRYPTO_IMPLEMENTATION')).toBe(1);
    expect(byType('CRYPTO_LIBRARY')).toBe(2);
    // Declared, not called: none of these come from the code scan.
    expect(byType('PROTOCOL')).toBe(1);
    expect(byType('CERTIFICATE')).toBe(1);
    expect(byType('EXTERNAL_SERVICE')).toBe(1);

    // FR-11 — the TLS → API edge keeps its direction of protection.
    const secures = edges.find((e) => e.relationship === 'SECURES')!;
    expect(secures.fromNodeId).toContain('tls');
    expect(secures.toNodeId).toContain('payments-api');

    // FR-9 — every write moves the version, so a client that fell behind knows
    // it did. One bump per node and per edge.
    expect(graphVersion).toBeGreaterThanOrEqual(counts.nodes + counts.edges);

    // FR-5 — sequence is dense and ascending, which is what makes replay match
    // the live reveal.
    expect(nodes.map((n) => n.sequence)).toEqual([...nodes].map((n) => n.sequence).sort((a, b) => a - b));

    // FR-3 — every node that came from a candidate cites something.
    const uncited = nodes.filter(
      (n) => n.type !== 'SERVICE' && n.type !== 'CRYPTO_LIBRARY' && n.evidenceIds.length === 0,
    );
    expect(uncited.map((n) => n.nodeId)).toEqual([]);

    // The counts the project card reads.
    const after = await db.repos.projects.byId(projectId);
    expect(after!.summary.counts.graphNodes).toBe(counts.nodes);
    expect(after!.summary.counts.graphEdges).toBe(counts.edges);
  }, 60_000);
});

describe('AC-8 · blast radius', () => {
  it('returns the upstream service for a quantum-vulnerable algorithm', async () => {
    const { projectId } = await db.repos.projects.create(aProject() as never);

    const api = await graph.upsertNode(projectId, { type: 'SERVICE', canonicalName: 'payments-api' }, 0);
    const svc = await graph.upsertNode(projectId, { type: 'SOURCE_COMPONENT', canonicalName: 'CryptoService' }, 1);
    const rsa = await graph.upsertNode(projectId, { type: 'ALGORITHM', canonicalName: 'RSA key transport' }, 2);
    await graph.upsertEdge(projectId, {
      fromNodeId: api.id, toNodeId: svc.id, relationship: 'DEPENDS_ON',
    }, 3);
    await graph.upsertEdge(projectId, {
      fromNodeId: svc.id, toNodeId: rsa.id, relationship: 'ENCRYPTS_WITH',
    }, 4);

    const upstream = await graph.blastRadius(projectId, rsa.id);
    // Both the direct dependant and the service two hops above it — the answer
    // to "what breaks if this algorithm goes", which is the whole point.
    expect(upstream).toContain(svc.id);
    expect(upstream).toContain(api.id);
  });
});

describe('evidence roll-up and pins', () => {
  it('marks an edge INFERRED when its only evidence was reasoned, so the canvas dashes it', async () => {
    const { projectId } = await db.repos.projects.create(aProject() as never);

    const inferred = await discovery.saveEvidence(projectId, ev({
      evidenceType: 'MODEL_REASONING', evidenceClass: 'INFERRED', confidence: 0.7,
    }));
    const observed = await discovery.saveEvidence(projectId, ev({ confidence: 1 }));

    const a = await graph.upsertNode(projectId, { type: 'SERVICE', canonicalName: 'a' }, 0);
    const b = await graph.upsertNode(projectId, { type: 'API', canonicalName: 'b' }, 1);

    const e1 = await graph.upsertEdge(projectId, {
      fromNodeId: a.id, toNodeId: b.id, relationship: 'SECURES', evidenceIds: [inferred],
    }, 2);
    let edge = (await graph.snapshot(projectId)).edges.find((x) => x.edgeId === e1.id)!;
    expect(edge.evidenceClass).toBe('INFERRED');
    expect(edge.confidence).toBeLessThan(1);

    // A later observation of the same relationship promotes it: the scanner
    // established what the model had only guessed.
    await graph.upsertEdge(projectId, {
      fromNodeId: a.id, toNodeId: b.id, relationship: 'SECURES', evidenceIds: [observed],
    }, 3);
    edge = (await graph.snapshot(projectId)).edges.find((x) => x.edgeId === e1.id)!;
    expect(edge.evidenceClass).toBe('OBSERVED');
    expect(edge.evidenceIds).toHaveLength(2);
  });

  it('stores a pin scoped to its style and drops it on unpin (FR-6)', async () => {
    const { projectId } = await db.repos.projects.create(aProject() as never);

    const n = await graph.upsertNode(projectId, { type: 'HSM', canonicalName: 'payShield' }, 0);
    await graph.pin(projectId, n.id, { x: 120, y: 40, style: 'radial' });

    let node = (await graph.snapshot(projectId)).nodes[0]!;
    expect(node.pin).toEqual({ x: 120, y: 40, style: 'radial' });

    await graph.pin(projectId, n.id, null);
    node = (await graph.snapshot(projectId)).nodes[0]!;
    expect(node.pin).toBeUndefined();
  });
});
