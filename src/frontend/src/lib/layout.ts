import type { GraphEdge, GraphNode, GraphStyle, NodeType } from '@proteus/schema';

/**
 * Graph layout, computed in the browser.
 *
 * Positions are never stored (data model §7): the graph grows while discovery
 * runs, and a stored position would be stale the moment the next node arrived.
 * Only a user's deliberate pin persists, and only for the style they dragged in.
 *
 * Every style is a pure function of the graph, seeded by `nodeId`, so the same
 * graph always lays out the same way — switching styles and switching back
 * returns you to the arrangement you left, with no server call (AC-5).
 */

/** Percent of the canvas. `x` and `y` in 0–100. */
export interface Point { x: number; y: number }
export type Positions = Record<string, Point>;

/** FNV-1a. Small, stable across browsers, and good enough to spread a few dozen nodes. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** A stable pseudo-random in [0,1) for a node and a purpose. */
const rand = (id: string, salt: string): number => (hash(`${salt}:${id}`) % 10_000) / 10_000;

/**
 * Hops from the root, following edges in both directions.
 *
 * Depth is what gives every style its structure — rings in radial, distance from
 * centre in force — and it is stable: a new leaf does not change the depth of
 * anything already placed.
 */
function depths(nodes: GraphNode[], edges: GraphEdge[], rootId: string): Map<string, number> {
  const adjacent = new Map<string, string[]>();
  for (const e of edges) {
    (adjacent.get(e.fromNodeId) ?? adjacent.set(e.fromNodeId, []).get(e.fromNodeId)!).push(e.toNodeId);
    (adjacent.get(e.toNodeId) ?? adjacent.set(e.toNodeId, []).get(e.toNodeId)!).push(e.fromNodeId);
  }

  const out = new Map<string, number>([[rootId, 0]]);
  let frontier = [rootId];
  while (frontier.length) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const neighbour of adjacent.get(id) ?? []) {
        if (out.has(neighbour)) continue;
        out.set(neighbour, out.get(id)! + 1);
        next.push(neighbour);
      }
    }
    frontier = next;
  }

  // Anything the traversal never reached — an isolated node — sits on the outer
  // ring rather than at the centre, where it would read as important.
  for (const n of nodes) if (!out.has(n.nodeId)) out.set(n.nodeId, 3);
  return out;
}

/** The node everything else is arranged around: the first one discovered. */
function rootOf(nodes: GraphNode[]): string {
  const service = nodes.find((n) => n.type === 'SERVICE' || n.type === 'APPLICATION');
  return (service ?? nodes[0])?.nodeId ?? '';
}

/** Blueprint puts each type in its own column, left to right along the dependency chain. */
const COLUMN_ORDER: NodeType[] = [
  'APPLICATION', 'SERVICE', 'API', 'SOURCE_COMPONENT', 'TEST_MOCK',
  'CRYPTO_IMPLEMENTATION', 'PROTOCOL', 'ALGORITHM', 'CRYPTO_LIBRARY',
  'CERTIFICATE', 'KEY', 'HSM', 'SECURE_ELEMENT', 'SECURITY_APPLIANCE',
  'DATABASE', 'EXTERNAL_SERVICE', 'VENDOR_DEPENDENCY', 'OT_DEVICE', 'IOT_DEVICE',
];

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function layout(
  nodes: GraphNode[],
  edges: GraphEdge[],
  style: GraphStyle,
): Positions {
  const out: Positions = {};
  if (nodes.length === 0) return out;

  const root = rootOf(nodes);
  const depth = depths(nodes, edges, root);

  if (style === 'blueprint') {
    // A strict grid. Nothing organic about it — this is the style for reading
    // the graph as a structure rather than looking at it as a picture.
    const columns = new Map<NodeType, GraphNode[]>();
    for (const n of [...nodes].sort((a, b) => a.sequence - b.sequence)) {
      (columns.get(n.type) ?? columns.set(n.type, []).get(n.type)!).push(n);
    }
    const used = COLUMN_ORDER.filter((t) => columns.has(t));
    used.forEach((type, ci) => {
      const column = columns.get(type)!;
      const x = used.length === 1 ? 50 : 10 + (ci * 80) / (used.length - 1);
      column.forEach((n, ri) => {
        out[n.nodeId] = {
          x,
          y: column.length === 1 ? 50 : 12 + (ri * 76) / (column.length - 1),
        };
      });
    });
    return out;
  }

  if (style === 'radial') {
    // Concentric rings by distance from the application. Angle comes from the
    // node's position within its ring, so a ring stays evenly spread as it fills.
    const rings = new Map<number, GraphNode[]>();
    for (const n of [...nodes].sort((a, b) => a.sequence - b.sequence)) {
      const d = depth.get(n.nodeId) ?? 3;
      (rings.get(d) ?? rings.set(d, []).get(d)!).push(n);
    }
    const maxDepth = Math.max(...rings.keys(), 1);
    for (const [d, ring] of rings) {
      if (d === 0 && ring.length === 1) { out[ring[0]!.nodeId] = { x: 50, y: 50 }; continue; }
      const radius = (d / maxDepth) * 38;
      // Offset each ring by a fixed fraction so nodes do not line up on spokes.
      const offset = d * 0.37;
      ring.forEach((n, i) => {
        const angle = 2 * Math.PI * (i / ring.length + offset);
        out[n.nodeId] = {
          x: clamp(50 + radius * Math.cos(angle) * 1.5, 8, 92),
          y: clamp(50 + radius * Math.sin(angle), 10, 90),
        };
      });
    }
    return out;
  }

  // force — the default. Depth sets how far from the centre a node sits; its own
  // hash sets where on that band. Because both inputs belong to the node itself,
  // adding a node never moves one already on screen.
  const maxDepth = Math.max(...[...depth.values()], 1);
  for (const n of nodes) {
    const d = depth.get(n.nodeId) ?? maxDepth;
    if (n.nodeId === root) { out[n.nodeId] = { x: 50, y: 50 }; continue; }

    const band = d / maxDepth;
    const angle = 2 * Math.PI * rand(n.nodeId, 'angle');
    const radius = 16 + band * 26 + rand(n.nodeId, 'radius') * 8;
    out[n.nodeId] = {
      // Wider than tall: the canvas is, and a circle in a wide box wastes it.
      x: clamp(50 + radius * Math.cos(angle) * 1.55, 8, 92),
      y: clamp(50 + radius * Math.sin(angle) * 0.95, 10, 90),
    };
  }
  return out;
}

/** A user's pin wins over the computed position, in that style only (FR-6). */
export function withPins(positions: Positions, nodes: GraphNode[], style: GraphStyle): Positions {
  const out = { ...positions };
  for (const n of nodes) {
    if (n.pin && n.pin.style === style) out[n.nodeId] = { x: n.pin.x, y: n.pin.y };
  }
  return out;
}
