import type { Project } from '@proteus/schema';
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../app/AuthContext';
import type { ApiClient } from '../api/client';
import { STAGE_COLOR, STAGE_LABEL, actionLabel, isLive, mix } from '../lib/impact';
import { confirmMatches, isArchived, previewSummary } from '../lib/lifecycle';
import { ProjectMenu } from '../components/ProjectMenu';
import { ConfirmDialog } from '../components/ConfirmDialog';

type Tile = Project & { rail: number };

/** What a delete would do, as `GET /projects/:id/deletion-preview` reports it. */
type Preview = Awaited<ReturnType<ApiClient['deletionPreview']>>;

/**
 * Where a project tile takes you, or nowhere.
 *
 * `null` for a failed project. Every screen behind this tile reads state that a
 * failure means was never produced — the discovery feed waits on a stream that
 * has ended, the assessment has no findings, the sandbox screen says "nothing to
 * review yet". Sending someone to one of those instead of telling them the
 * project failed is a dead end that looks like a bug in the screen rather than
 * what actually happened.
 *
 * `FAILED` previously fell through to the `default` and opened the sandbox
 * screen, which is the least useful of the four.
 */
export function destinationFor(p: Pick<Project, 'stage' | 'projectId'>): string | null {
  switch (p.stage) {
    case 'FAILED': return null;
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
  const { api, profile } = useAuth();
  const navigate = useNavigate();
  const [data, setData] = useState<{ count: number; awaitingApproval: number; needsHumanAction: number; projects: Tile[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * The action awaiting confirmation, and the project it belongs to.
   *
   * Reached from the tile's own menu rather than from a control elsewhere on
   * the page: anything that makes you name the project separately from the one
   * you are looking at is a way to act on the wrong one.
   */
  const [pending, setPending] = useState<{ project: Tile; action: 'archive' | 'delete' } | null>(null);
  const [typed, setTyped] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [working, setWorking] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(() => {
    api.projects().then(setData).catch((e) => setError(e.message));
  }, [api]);

  useEffect(() => { load(); }, [load]);

  const isPlatformAdmin = profile?.role === 'PLATFORM_ADMIN';

  const choose = async (project: Tile, action: 'archive' | 'delete') => {
    setPending({ project, action });
    setTyped('');
    setPreview(null);
    setActionError(null);
    if (action === 'delete') {
      // Fetched before anything is typed: the count is the reason to stop, and
      // it arrives too late if it comes after the confirmation.
      setPreview(await api.deletionPreview(project.projectId).catch(() => null));
    }
  };

  const confirm = async () => {
    if (!pending) return;
    setWorking(true);
    setActionError(null);
    try {
      if (pending.action === 'archive') await api.archiveProject(pending.project.projectId);
      else await api.deleteProject(pending.project.projectId);
      setPending(null);
      load();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setWorking(false);
    }
  };

  if (error) return <div className="placeholder"><h2>Could not load projects</h2><p className="sub">{error}</p></div>;
  if (!data) return <div className="label">Loading projects…</div>;

  return (
    <div className="projects">
      <div className="projects-head">
        <div>
          <h1>Migration projects</h1>
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
            const to = destinationFor(p);
            return (
              <div key={p.projectId} className="tile-wrap">
              <ProjectMenu
                project={p}
                isPlatformAdmin={isPlatformAdmin}
                onChoose={(action) => void choose(p, action)}
              />
              <button
                className={`tile${to ? '' : ' tile-dead'}`}
                // A failed project is not a link. Disabled rather than routed
                // somewhere that would only show an empty screen.
                disabled={!to}
                aria-disabled={!to}
                style={{ borderColor: isLive(p.stage) ? mix(colour, 40) : 'var(--line)' }}
                onClick={() => { if (to) navigate(to); }}
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

                {/* Eight segments, one per user-facing stage. Derived, not stored. */}
                <div className="rail">
                  {Array.from({ length: 8 }, (_, i) => (
                    <span key={i} style={{ background: i < p.rail ? colour : 'var(--rai)' }} />
                  ))}
                </div>

                <div className="tile-bottom">
                  <p className="tile-activity">
                    {/* The reason, where there is one. A tile that cannot be
                        opened has to say why on its face — there is nowhere
                        else left to find out. */}
                    {p.stage === 'FAILED' && p.failureReason
                      ? p.failureReason
                      : p.summary.lastActivityText}
                  </p>
                  <div className="tile-foot label">
                    <span>{ago(p.summary.lastActivityAt)} · {p.projectId}</span>
                    <span className="tile-foot-gap" />
                    <span style={{ color: p.actionRequired ? 'var(--bad)' : 'var(--fg3)' }}>
                      {isArchived(p) ? 'ARCHIVED' : actionLabel(p.stage, p.actionRequired)}
                    </span>
                  </div>
                </div>
              </button>
              </div>
            );
          })}
        </div>
      )}

      <ConfirmDialog
        open={pending !== null}
        danger={pending?.action === 'delete'}
        title={pending?.action === 'delete'
          ? `Delete ${pending.project.projectId}?`
          : `Archive ${pending?.project.projectId}?`}
        confirmLabel={pending?.action === 'delete' ? 'Delete project' : 'Archive project'}
        confirmDisabled={!pending || !confirmMatches(typed, pending.project.projectId)}
        busy={working}
        onConfirm={() => void confirm()}
        onCancel={() => setPending(null)}
      >
        {pending && (
          <>
            <p className="dialog-lede">{pending.project.name}</p>
            <p className="dialog-what">
              {pending.action === 'archive'
                ? 'The project becomes read-only. Reports, evidence and the diff stay '
                  + 'downloadable. The sandbox is released and its slot freed.'
                : 'The project is removed from the platform. Its records are retained but '
                  + 'unreachable, the sandbox is released, and the stored GitHub token is '
                  + 'destroyed.'}
            </p>

            {preview && (
              <ul className="dialog-preview">
                {previewSummary(preview).map((line) => <li key={line}>{line}</li>)}
              </ul>
            )}

            {/* Said plainly. Softening an irreversible action is how someone
                finds out afterwards that it was one. */}
            <p className="dialog-warn">This cannot be undone from the application.</p>

            <label htmlFor="confirm-id">
              Type <b className="mono">{pending.project.projectId}</b> to confirm
            </label>
            <input
              id="confirm-id" value={typed} autoComplete="off" spellCheck={false}
              autoFocus placeholder={pending.project.projectId}
              onChange={(e) => setTyped(e.target.value)}
            />

            {actionError && <div className="error">{actionError}</div>}
          </>
        )}
      </ConfirmDialog>
    </div>
  );
}
