import type { Evidence, GraphEdge, GraphNode } from '@proteus/schema';
import { useEffect, useState } from 'react';
import { useAuth } from '../../app/AuthContext';
import { IMPACT_COLOR, IMPACT_LABEL, mix } from '../../lib/impact';

/**
 * The node inspector.
 *
 * The panel that makes the graph auditable rather than decorative: what this is,
 * why it matters, and — the part that counts — what established it. Evidence is
 * fetched on open rather than carried in the graph payload, so a large graph
 * does not ship every excerpt on every refetch.
 */

interface Props {
  projectId: string;
  node: GraphNode;
  edges: GraphEdge[];
  nodes: GraphNode[];
  onClose: () => void;
  onSelect: (nodeId: string) => void;
  onBlastRadius: (nodeId: string) => void;
}

export function Inspector({
  projectId, node, edges, nodes, onClose, onSelect, onBlastRadius,
}: Props) {
  const { api } = useAuth();
  const [evidence, setEvidence] = useState<Evidence[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setEvidence(null);
    api.evidence(projectId, node.evidenceIds)
      .then((r) => { if (!cancelled) setEvidence(r.evidence); })
      .catch(() => { if (!cancelled) setEvidence([]); });
    return () => { cancelled = true; };
  }, [api, projectId, node.nodeId, node.evidenceIds]);

  const colour = IMPACT_COLOR[node.impact];
  const nameOf = (id: string) => nodes.find((n) => n.nodeId === id)?.name ?? id;
  const related = edges.filter((e) => e.fromNodeId === node.nodeId || e.toNodeId === node.nodeId);

  return (
    <aside className="inspector">
      <div className="inspector-head">
        <div>
          <div className="inspector-name">{node.name}</div>
          <div className="mono inspector-type" style={{ color: colour }}>{node.type}</div>
        </div>
        <button className="inspector-close mono" onClick={onClose} aria-label="Close inspector">×</button>
      </div>

      <div className="inspector-impact mono" style={{ background: mix(colour, 12), color: colour }}>
        {IMPACT_LABEL[node.impact]}
      </div>

      {node.subtitle && <div className="mono inspector-sub">{node.subtitle}</div>}
      {node.note && <p className="inspector-note">{node.note}</p>}

      <div className="inspector-rule" />
      <div className="mono inspector-section">EVIDENCE</div>

      {evidence === null && <div className="mono inspector-empty">Loading…</div>}
      {evidence?.length === 0 && (
        <div className="mono inspector-empty">No evidence recorded for this node.</div>
      )}
      {evidence?.map((e) => {
        const observed = e.evidenceClass === 'OBSERVED';
        const accent = observed ? 'var(--ok)' : 'var(--warn)';
        return (
          <div key={e.evidenceId} className="evidence-card">
            <div className="evidence-top">
              <span className="mono evidence-class" style={{ background: mix(accent, 14), color: accent }}>
                {e.evidenceClass}
              </span>
              <span className="mono evidence-type">{e.evidenceType}</span>
              <span className="mono evidence-conf">CONF {e.confidence.toFixed(2)}</span>
            </div>
            {e.locator.kind === 'REPO' && e.locator.permalink ? (
              <a className="mono evidence-src" href={e.locator.permalink} target="_blank" rel="noreferrer">
                {e.source}
              </a>
            ) : (
              <div className="mono evidence-src">{e.source}</div>
            )}
            {e.excerpt && <pre className="mono evidence-excerpt">{e.excerpt}</pre>}
          </div>
        );
      })}

      {related.length > 0 && (
        <>
          <div className="mono inspector-section">RELATIONSHIPS</div>
          {related.map((e) => {
            const outgoing = e.fromNodeId === node.nodeId;
            const otherId = outgoing ? e.toNodeId : e.fromNodeId;
            return (
              <button key={e.edgeId} className="relationship" onClick={() => onSelect(otherId)}>
                <span
                  className="mono relationship-rel"
                  style={{ color: e.evidenceClass === 'INFERRED' ? 'var(--fg3)' : 'var(--acc)' }}
                >
                  {e.relationship.replace(/_/g, ' ').toLowerCase()}
                </span>
                <span className="relationship-arrow mono">{outgoing ? '→' : '←'}</span>
                <span className="relationship-other">{nameOf(otherId)}</span>
              </button>
            );
          })}
        </>
      )}

      <button className="ghost inspector-blast" onClick={() => onBlastRadius(node.nodeId)}>
        SHOW BLAST RADIUS
      </button>
    </aside>
  );
}
