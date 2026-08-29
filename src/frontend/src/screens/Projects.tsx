import type { Project } from '@proteus/schema';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../app/AuthContext';
import { STAGE_COLOR, STAGE_LABEL, actionLabel, isLive, mix } from '../lib/impact';

type Tile = Project & { rail: number };

/** Where a project tile takes you, given how far it has got. */
function destinationFor(p: Project): string {
  switch (p.stage) {
    case 'CREATED':
    case 'ANALYZING': return `/projects/${p.projectId}/discovery`;
    case 'ASSESSMENT_READY':
    case 'AWAITING_APPROVAL': return `/projects/${p.projectId}/assessment`;
    case 'MIGRATING':
    case 'VERIFYING': return `/projects/${p.projectId}/migration`;
    default: return `/projects/${p.projectId}/sandbox`;
  }
}

function ago(at: Date | string): string {
  const s = Math.max(0, (Date.now() - new Date(at).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} hours ago`;
  return `${Math.floor(s / 86400)} days ago`;
}

export function Projects() {
  const { api } = useAuth();
  const navigate = useNavigate();
  const [data, setData] = useState<{ count: number; awaitingApproval: number; needsHumanAction: number; projects: Tile[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.projects().then(setData).catch((e) => setError(e.message));
  }, [api]);

  if (error) return <div className="placeholder"><h2>Could not load projects</h2><p className="sub">{error}</p></div>;
  if (!data) return <div className="label">Loading projects…</div>;

  return (
    <div className="projects">
      <div className="projects-head">
        <div>
          <h2>Migration projects</h2>
          <p className="sub">
            {data.count} {data.count === 1 ? 'project' : 'projects'}
            {data.awaitingApproval > 0 && ` · ${data.awaitingApproval} awaiting approval`}
            {data.needsHumanAction > 0 && ` · ${data.needsHumanAction} needs human action`}
          </p>
        </div>
        <Link to="/projects/new" className="primary compact">+ New migration project</Link>
      </div>

      {data.projects.length === 0 ? (
        <div className="placeholder">
          <h2>No projects yet</h2>
          <p className="sub">
            Point Proteus at a repository and it will work out what needs to change.
          </p>
          <Link to="/projects/new" className="primary compact">Create your first project</Link>
        </div>
      ) : (
        <div className="tiles">
          {data.projects.map((p) => {
            const colour = STAGE_COLOR[p.stage];
            return (
              <button
                key={p.projectId}
                className="tile"
                style={{ borderColor: isLive(p.stage) ? mix(colour, 40) : 'var(--line)' }}
                onClick={() => navigate(destinationFor(p))}
              >
                <div className="tile-top">
                  <div>
                    <div className="tile-name">{p.name}</div>
                    <div className="label mono">{p.repository.url.replace(/^https?:\/\/github\.com\//, '')}</div>
                  </div>
                  <span className="pill mono" style={{ color: colour, background: mix(colour, 13) }}>
                    {STAGE_LABEL[p.stage]}
                  </span>
                </div>

                <p className="tile-activity">{p.summary.lastActivityText}</p>

                {/* Eight segments, one per user-facing stage. Derived, not stored. */}
                <div className="rail">
                  {Array.from({ length: 8 }, (_, i) => (
                    <span key={i} style={{ background: i < p.rail ? colour : 'var(--rai)' }} />
                  ))}
                </div>

                <div className="tile-foot label">
                  <span>{ago(p.summary.lastActivityAt)} · {p.projectId}</span>
                  <span style={{ color: p.actionRequired ? 'var(--bad)' : 'var(--fg3)' }}>
                    {actionLabel(p.stage, p.actionRequired)}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
