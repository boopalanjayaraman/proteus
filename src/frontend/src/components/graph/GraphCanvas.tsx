import type { GraphEdge, GraphNode, GraphStyle } from '@proteus/schema';
import { useMemo, useRef, useState } from 'react';
import { IMPACT_COLOR, mix } from '../../lib/impact';
import { layout, withPins, type Positions } from '../../lib/layout';

/**
 * The dependency graph canvas.
 *
 * Edges are drawn in SVG under absolutely-positioned node chips, which is what
 * the design calls for and what keeps the chips selectable, hoverable HTML
 * rather than SVG text that would need its own layout.
 */

interface Props {
  nodes: GraphNode[];
  edges: GraphEdge[];
  style: GraphStyle;
  selected: string | null;
  highlighted: Set<string>;
  onSelect: (nodeId: string | null) => void;
  onPin: (nodeId: string, pin: { x: number; y: number; style: GraphStyle } | null) => void;
}

const REL_LABEL = (e: GraphEdge) => e.label ?? e.relationship.replace(/_/g, ' ').toLowerCase();

export function GraphCanvas({
  nodes, edges, style, selected, highlighted, onSelect, onPin,
}: Props) {
  const surface = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<{ nodeId: string; moved: boolean } | null>(null);
  const [live, setLive] = useState<Positions>({});

  const computed = useMemo(
    () => withPins(layout(nodes, edges, style), nodes, style),
    [nodes, edges, style],
  );
  // A node being dragged reads from `live`; everything else from the layout, so
  // a drag never triggers a re-layout of the rest of the graph.
  const positions: Positions = { ...computed, ...live };

  const visible = new Set(nodes.map((n) => n.nodeId));
  const drawable = edges.filter((e) => visible.has(e.fromNodeId) && visible.has(e.toNodeId));
  // Blueprint labels every edge; the others label only what the selection touches,
  // or the canvas becomes unreadable at thirty nodes.
  const labelAll = style === 'blueprint';

  const pointFor = (id: string) => positions[id] ?? { x: 50, y: 50 };

  function onPointerDown(e: React.PointerEvent, nodeId: string) {
    e.preventDefault();
    (e.target as Element).setPointerCapture(e.pointerId);
    setDragging({ nodeId, moved: false });
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!dragging || !surface.current) return;
    const box = surface.current.getBoundingClientRect();
    const x = Math.min(96, Math.max(4, ((e.clientX - box.left) / box.width) * 100));
    const y = Math.min(96, Math.max(4, ((e.clientY - box.top) / box.height) * 100));
    setLive((prev) => ({ ...prev, [dragging.nodeId]: { x, y } }));
    if (!dragging.moved) setDragging({ ...dragging, moved: true });
  }

  function onPointerUp(nodeId: string) {
    if (!dragging) return;
    const drag = dragging;
    setDragging(null);
    // A click selects; a drag pins. Distinguished by whether the pointer moved,
    // so selecting a node never leaves an accidental pin behind.
    if (!drag.moved) {
      onSelect(selected === nodeId ? null : nodeId);
      return;
    }
    const at = live[nodeId];
    if (at) onPin(nodeId, { x: at.x, y: at.y, style });
  }

  return (
    <div
      className="graph-surface"
      ref={surface}
      onPointerMove={onPointerMove}
      onClick={(e) => { if (e.target === e.currentTarget) onSelect(null); }}
    >
      <svg viewBox="0 0 1000 560" preserveAspectRatio="none" className="graph-edges">
        {drawable.map((e) => {
          const a = pointFor(e.fromNodeId);
          const b = pointFor(e.toNodeId);
          const touched = selected === e.fromNodeId || selected === e.toNodeId;
          return (
            <line
              key={e.edgeId}
              x1={a.x * 10} y1={a.y * 5.6} x2={b.x * 10} y2={b.y * 5.6}
              stroke={touched ? 'var(--acc)' : 'var(--line2)'}
              strokeWidth={touched ? 1.6 : 1}
              // FR-4 — an inferred relationship is visibly not an observed one.
              strokeDasharray={e.evidenceClass === 'INFERRED' ? '4 4' : undefined}
              vectorEffect="non-scaling-stroke"
            />
          );
        })}
      </svg>

      {drawable
        .filter((e) => labelAll || selected === e.fromNodeId || selected === e.toNodeId)
        .map((e) => {
          const a = pointFor(e.fromNodeId);
          const b = pointFor(e.toNodeId);
          return (
            <div
              key={e.edgeId}
              className="graph-edge-label mono"
              style={{
                left: `${(a.x + b.x) / 2}%`, top: `${(a.y + b.y) / 2}%`,
                color: e.evidenceClass === 'INFERRED' ? 'var(--fg4)' : 'var(--fg3)',
              }}
            >
              {REL_LABEL(e)}
            </div>
          );
        })}

      {nodes.map((n) => {
        const p = pointFor(n.nodeId);
        const colour = IMPACT_COLOR[n.impact];
        const isSelected = selected === n.nodeId;
        const isHighlighted = highlighted.has(n.nodeId);
        return (
          <div
            key={n.nodeId}
            className="graph-node"
            style={{
              left: `${p.x}%`, top: `${p.y}%`,
              borderColor: isSelected || isHighlighted ? colour : 'var(--line2)',
              boxShadow: isSelected
                ? `0 0 0 1px ${colour}, 0 8px 24px rgba(0,0,0,.3)`
                : isHighlighted
                ? `0 0 0 1px ${mix(colour, 60)}`
                : n.impact === 'MIGRATION_REQUIRED'
                ? `0 0 22px ${mix(colour, 16)}`
                : undefined,
            }}
            onPointerDown={(e) => onPointerDown(e, n.nodeId)}
            onPointerUp={() => onPointerUp(n.nodeId)}
            title={n.subtitle ?? n.name}
          >
            <div className="graph-node-top">
              <span
                className="graph-dot"
                style={{
                  background: colour,
                  // Vendor and hardware draw square, so the one swatch the legend
                  // collapses them into is still tellable apart on the canvas.
                  borderRadius: n.impact === 'VENDOR_CONTROLLED' || n.impact === 'HARDWARE_CONTROLLED'
                    ? '1px' : '50%',
                }}
              />
              <span className="graph-node-name">{n.name}</span>
            </div>
            <div className="graph-node-type mono" style={{ color: colour }}>{n.type}</div>
          </div>
        );
      })}
    </div>
  );
}
