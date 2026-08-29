import type { EventLevel, GraphEdge, GraphNode, GraphStyle, Project } from '@proteus/schema';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ActivityFeed } from '../../components/activity/ActivityFeed';
import { GraphCanvas } from '../../components/graph/GraphCanvas';
import { Inspector } from '../../components/graph/Inspector';
import { useAuth } from '../../app/AuthContext';
import { useProjectStream } from '../../hooks/useProjectStream';
import { IMPACT_COLOR } from '../../lib/impact';

/**
 * Live discovery and dependency mapping.
 *
 * Everything on this screen is server state replayed: the graph, the feed, the
 * counts and the progress bar all come from what discovery persisted. A refresh
 * mid-run restores the same picture, because none of it lives in the browser.
 */

const STYLES: GraphStyle[] = ['force', 'radial', 'blueprint'];
type Split = 'graph' | 'split';

/** The legend collapses vendor and hardware into one swatch; the data keeps them apart. */
const LEGEND = [
  { label: 'REQUIRED', color: IMPACT_COLOR.MIGRATION_REQUIRED },
  { label: 'LIKELY', color: IMPACT_COLOR.MIGRATION_LIKELY },
  { label: 'INVESTIGATE', color: IMPACT_COLOR.DEPENDENCY_REQUIRES_INVESTIGATION },
  { label: 'NO CHANGE', color: IMPACT_COLOR.NO_PQC_CHANGE_REQUIRED },
  { label: 'VENDOR / HW', color: IMPACT_COLOR.VENDOR_CONTROLLED },
];

export function Discovery() {
  const { id } = useParams<{ id: string }>();
  const { api } = useAuth();
  const navigate = useNavigate();

  const [project, setProject] = useState<Project | null>(null);
  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const [edges, setEdges] = useState<GraphEdge[]>([]);
  const [style, setStyle] = useState<GraphStyle>('force');
  const [split, setSplit] = useState<Split>('graph');
  const [selected, setSelected] = useState<string | null>(null);
  const [highlighted, setHighlighted] = useState<Set<string>>(new Set());
  const [level, setLevel] = useState<EventLevel | 'ALL'>('ALL');
  const version = useRef(-1);

  const { events, status } = useProjectStream(id);

  const refetch = useCallback(async () => {
    if (!id) return;
    const g = await api.graph(id);
    // `graphVersion` is the divergence signal: if the server has moved on, take
    // its version of the graph rather than patching the local one from events.
    if (g.graphVersion === version.current) return;
    version.current = g.graphVersion;
    setNodes(g.nodes);
    setEdges(g.edges);
  }, [api, id]);

  useEffect(() => {
    if (!id) return;
    void refetch();
    api.project(id).then(setProject).catch(() => undefined);
  }, [id, api, refetch]);

  // A graph event means the server wrote something. Refetching on the event
  // rather than polling keeps the canvas in step with the feed beside it.
  const graphEventCount = events.filter((e) => e.type.startsWith('GRAPH_')).length;
  useEffect(() => { void refetch(); }, [graphEventCount, refetch]);

  // The stage moves, the header follows.
  const stageEventCount = events.filter((e) => e.level === 'MILESTONE').length;
  useEffect(() => {
    if (!id || stageEventCount === 0) return;
    api.project(id).then(setProject).catch(() => undefined);
  }, [id, api, stageEventCount]);

  const onPin = useCallback(
    (nodeId: string, pin: { x: number; y: number; style: GraphStyle } | null) => {
      if (!id) return;
      // Optimistic: the drag has already happened on screen, and a failed write
      // should not make the node jump back mid-gesture.
      setNodes((prev) => prev.map((n) => (n.nodeId === nodeId ? { ...n, pin: pin ?? undefined } : n)));
      void api.pinNode(id, nodeId, pin);
    },
    [api, id],
  );

  const onBlastRadius = useCallback(
    async (nodeId: string) => {
      if (!id) return;
      const r = await api.blastRadius(id, nodeId);
      setHighlighted(new Set([nodeId, ...r.upstream]));
    },
    [api, id],
  );

  const selectedNode = useMemo(
    () => nodes.find((n) => n.nodeId === selected) ?? null,
    [nodes, selected],
  );

  const findings = project?.summary.counts.findings ?? 0;
  const filesAnalyzed = events.filter((e) => e.type === 'FILE_ANALYZED').length;
  const blockers = events.filter((e) => e.severity === 'WARN' || e.severity === 'ERROR').length;
  const percent = project?.stage === 'CREATED'
    ? 0
    : project && project.stage !== 'ANALYZING'
    ? 100
    : Math.min(96, Math.round((nodes.length / Math.max(12, nodes.length + 4)) * 100));
  const done = Boolean(project?.summary.discoveryComplete);

  const stats = [
    { value: filesAnalyzed, label: 'FILES ANALYZED', fg: 'var(--fg)' },
    { value: findings, label: 'FINDINGS', fg: 'var(--bad)' },
    { value: nodes.length, label: 'GRAPH NODES', fg: 'var(--acc)' },
    { value: blockers, label: 'BLOCKERS', fg: 'var(--warn)' },
  ];

  return (
    <div className="discovery">
      <header className="discovery-head">
        <div className="discovery-title">
          <div className="discovery-h1">Live discovery &amp; dependency mapping</div>
          <div className="mono discovery-guarantee">
            READ-ONLY · NO BRANCH · NO SOURCE MODIFICATION
          </div>
        </div>
        <div className="discovery-spacer" />
        {stats.map((s) => (
          <div key={s.label} className="discovery-stat">
            <div className="discovery-stat-value" style={{ color: s.fg }}>{s.value}</div>
            <div className="mono discovery-stat-label">{s.label}</div>
          </div>
        ))}
        <div className="discovery-progress">
          <div className="mono discovery-progress-top">
            <span>{done ? 'ASSESSMENT READY' : 'ANALYZING'}</span>
            <span>{percent}%</span>
          </div>
          <div className="discovery-progress-rail">
            <div className="discovery-progress-fill" style={{ width: `${percent}%` }} />
          </div>
        </div>
      </header>

      <div className={`discovery-body ${split}`}>
        <section className="discovery-graph">
          <div className="graph-toolbar">
            <div className="tabs">
              {STYLES.map((s) => (
                <button
                  key={s}
                  className={`mono tab ${style === s ? 'on' : ''}`}
                  // No server call: the layout is a pure function of the graph.
                  onClick={() => setStyle(s)}
                >
                  {s.toUpperCase()}
                </button>
              ))}
            </div>
            <div className="tabs">
              {(['graph', 'split'] as Split[]).map((k) => (
                <button
                  key={k}
                  className={`mono tab ${split === k ? 'on' : ''}`}
                  onClick={() => setSplit(k)}
                >
                  {k === 'graph' ? 'GRAPH-LED' : 'SPLIT 50/50'}
                </button>
              ))}
            </div>
            <div className="graph-toolbar-spacer" />
            {highlighted.size > 0 && (
              <button className="mono tab on" onClick={() => setHighlighted(new Set())}>
                CLEAR BLAST RADIUS
              </button>
            )}
            {LEGEND.map((g) => (
              <span key={g.label} className="mono legend-item">
                <span className="legend-swatch" style={{ background: g.color }} />
                {g.label}
              </span>
            ))}
          </div>

          <div className="graph-stage">
            {nodes.length === 0 ? (
              <div className="mono graph-empty">
                The graph builds itself as discovery finds cryptography.
              </div>
            ) : (
              <GraphCanvas
                nodes={nodes}
                edges={edges}
                style={style}
                selected={selected}
                highlighted={highlighted}
                onSelect={setSelected}
                onPin={onPin}
              />
            )}

            {selectedNode && id && (
              <Inspector
                projectId={id}
                node={selectedNode}
                nodes={nodes}
                edges={edges}
                onClose={() => setSelected(null)}
                onSelect={setSelected}
                onBlastRadius={onBlastRadius}
              />
            )}

            {done && (
              <div className="discovery-done">
                <div>
                  <div className="discovery-done-title">
                    Discovery complete — assessment and proposed migration plan generated
                  </div>
                  <div className="mono discovery-done-sub">
                    {nodes.length} GRAPH NODES · {edges.length} RELATIONSHIPS · {findings} FINDINGS
                  </div>
                </div>
                <button
                  className="primary compact"
                  onClick={() => navigate(`/projects/${id}/assessment`)}
                >
                  Open assessment
                </button>
              </div>
            )}
          </div>
        </section>

        <ActivityFeed
          events={events}
          since={project?.current?.discoveryRunId ? project.createdAt : undefined}
          level={level}
          onLevel={setLevel}
          status={status}
        />
      </div>
    </div>
  );
}
