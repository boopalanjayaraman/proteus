import type { GraphEdge, GraphNode, GraphStyle } from '@proteus/schema';
import { describe, expect, it } from 'vitest';
import { layout, withPins } from '../src/lib/layout';

/**
 * PRD-08 FR-5, FR-6 and AC-5.
 *
 * Layout is the one piece of graph behaviour with no server involvement, so it
 * is also the one piece that has to be provably deterministic on its own.
 */

const node = (id: string, over: Partial<GraphNode> = {}): GraphNode => ({
  _schemaVersion: 1,
  createdAt: new Date(), updatedAt: new Date(), firstSeenAt: new Date(),
  nodeId: id, projectId: 'proj_1', type: 'SOURCE_COMPONENT', name: id,
  note: '', impact: 'UNKNOWN', attributes: {},
  evidenceIds: [], findingIds: [], confidence: 0, evidenceClass: 'INFERRED',
  sequence: 0,
  ...over,
} as GraphNode);

const edge = (from: string, to: string): GraphEdge => ({
  _schemaVersion: 1, createdAt: new Date(), updatedAt: new Date(),
  edgeId: `${from}|DEPENDS_ON|${to}`, projectId: 'proj_1',
  fromNodeId: from, toNodeId: to, relationship: 'DEPENDS_ON',
  impact: 'UNKNOWN', evidenceIds: [], findingIds: [], confidence: 0,
  evidenceClass: 'INFERRED', sequence: 0,
} as unknown as GraphEdge);

const graph = () => {
  const nodes = [
    node('service:payments-api', { type: 'SERVICE', sequence: 0 }),
    node('source-component:cryptoservice', { sequence: 1 }),
    node('algorithm:rsa-key-transport', { type: 'ALGORITHM', sequence: 2 }),
    node('crypto-library:bcprov-1-70', { type: 'CRYPTO_LIBRARY', sequence: 3 }),
  ];
  const edges = [
    edge('service:payments-api', 'source-component:cryptoservice'),
    edge('source-component:cryptoservice', 'algorithm:rsa-key-transport'),
    edge('service:payments-api', 'crypto-library:bcprov-1-70'),
  ];
  return { nodes, edges };
};

const STYLES: GraphStyle[] = ['force', 'radial', 'blueprint'];

describe('AC-5 · layouts are computed, not fetched', () => {
  it.each(STYLES)('%s places every node inside the canvas', (style) => {
    const { nodes, edges } = graph();
    const p = layout(nodes, edges, style);
    expect(Object.keys(p)).toHaveLength(nodes.length);
    for (const point of Object.values(p)) {
      expect(point.x).toBeGreaterThanOrEqual(0);
      expect(point.x).toBeLessThanOrEqual(100);
      expect(point.y).toBeGreaterThanOrEqual(0);
      expect(point.y).toBeLessThanOrEqual(100);
    }
  });

  it.each(STYLES)('%s is deterministic — switching away and back returns the same picture', (style) => {
    const { nodes, edges } = graph();
    expect(layout(nodes, edges, style)).toEqual(layout(nodes, edges, style));
    // And independent of the order the nodes arrive in.
    expect(layout([...nodes].reverse(), edges, style)).toEqual(layout(nodes, edges, style));
  });

  it('gives the three styles genuinely different arrangements', () => {
    const { nodes, edges } = graph();
    const [force, radial, blueprint] = STYLES.map((s) => layout(nodes, edges, s));
    expect(force).not.toEqual(radial);
    expect(radial).not.toEqual(blueprint);
  });
});

describe('Risk 2 · a growing graph does not shuffle', () => {
  it('leaves existing force positions untouched when a node is added', () => {
    const { nodes, edges } = graph();
    const before = layout(nodes, edges, 'force');

    // A new leaf, hanging off a node that already had a position.
    const grown = [...nodes, node('certificate:cn-pay-api', { type: 'CERTIFICATE', sequence: 4 })];
    const grownEdges = [...edges, edge('service:payments-api', 'certificate:cn-pay-api')];
    const after = layout(grown, grownEdges, 'force');

    for (const n of nodes) expect(after[n.nodeId]).toEqual(before[n.nodeId]);
  });
});

describe('FR-6 · pins are scoped to the style they were made in', () => {
  it('applies a pin in its own style and ignores it in the others', () => {
    const { nodes, edges } = graph();
    const pinned = nodes.map((n) =>
      n.nodeId === 'algorithm:rsa-key-transport'
        ? ({ ...n, pin: { x: 12, y: 88, style: 'radial' as const } })
        : n,
    );

    const radial = withPins(layout(pinned, edges, 'radial'), pinned, 'radial');
    expect(radial['algorithm:rsa-key-transport']).toEqual({ x: 12, y: 88 });

    const force = withPins(layout(pinned, edges, 'force'), pinned, 'force');
    expect(force['algorithm:rsa-key-transport']).not.toEqual({ x: 12, y: 88 });
  });
});

describe('blueprint groups by type', () => {
  it('puts every node of a type in one column, ordered by discovery sequence', () => {
    const nodes = [
      node('service:app', { type: 'SERVICE', sequence: 0 }),
      node('source-component:b', { sequence: 2 }),
      node('source-component:a', { sequence: 1 }),
    ];
    const p = layout(nodes, [], 'blueprint');
    expect(p['source-component:a']!.x).toBe(p['source-component:b']!.x);
    expect(p['service:app']!.x).not.toBe(p['source-component:a']!.x);
    // Sequence, not name: the column reads in the order discovery found things.
    expect(p['source-component:a']!.y).toBeLessThan(p['source-component:b']!.y);
  });
});
