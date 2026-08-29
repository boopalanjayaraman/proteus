import type { Project } from '@proteus/schema';
import { NavLink } from 'react-router-dom';
import { useAuth } from '../../app/AuthContext';
import { useTheme } from '../../app/ThemeContext';
import { STAGE_COLOR, STAGE_LABEL, autonomyDisplay, isLive, mix } from '../../lib/impact';

/**
 * The left rail — which in UX v1.3 is the whole chrome.
 *
 * There is no top header band in the design. Identity, theme, the selected
 * project, navigation, the autonomy figure and the account all live in this one
 * 234px column, and the main area keeps only a thin breadcrumb bar. Splitting
 * them across a header and a sidebar, as this used to, put the product's
 * headline number in the same row as a theme toggle.
 *
 * Badges are derived: LIVE while a phase is running, GATE when the project is
 * waiting on a decision. Project-scoped destinations are disabled until a
 * project is selected, so no route can be reached with nothing to show.
 */
const DESTINATIONS = [
  { to: '/projects', label: 'Projects', scoped: false },
  { to: '/projects/new', label: 'Create project', scoped: false },
  { to: 'discovery', label: 'Live discovery', scoped: true },
  { to: 'assessment', label: 'Assessment', scoped: true },
  { to: 'migration', label: 'Live migration', scoped: true },
  { to: 'sandbox', label: 'Sandbox & report', scoped: true },
  // Not project-scoped: the user's own history across every project, and a
  // platform admin's across every user.
  { to: '/activity', label: 'Activity', scoped: false },
] as const;

export function Nav({ project }: { project?: Project | null }) {
  const { profile, signOut } = useAuth();
  const { theme, toggle } = useTheme();

  const badgeFor = (to: string): { text: string; color: string } | null => {
    if (!project) return null;
    if (to === 'discovery' && project.stage === 'ANALYZING') return { text: 'LIVE', color: 'var(--acc)' };
    if (to === 'migration' && project.stage === 'MIGRATING') return { text: 'LIVE', color: 'var(--acc)' };
    if (to === 'assessment' && project.actionRequired) return { text: 'GATE', color: 'var(--warn)' };
    return null;
  };

  const stageColour = project ? STAGE_COLOR[project.stage] : 'var(--fg3)';

  return (
    <nav className="nav">
      <div className="nav-brand">
        {/* The mark. Rotated square rather than an asset, so it takes the
            accent colour from the theme like everything else. */}
        <span className="nav-mark" aria-hidden="true" />
        <span className="nav-brand-name">PROTEUS</span>
        <button className="nav-theme mono" onClick={toggle} title="Switch theme">
          {theme === 'dark' ? 'LIGHT' : 'DARK'}
        </button>
      </div>

      {/* The selected project, so which one you are working on is answerable
          without reading the breadcrumb. */}
      {project && (
        <div className="nav-project">
          <div className="nav-project-top">
            <span className="mono nav-project-id">{project.projectId}</span>
            <span
              className="mono nav-project-stage"
              style={{ background: mix(stageColour, 13), color: stageColour }}
            >
              {STAGE_LABEL[project.stage]}
            </span>
          </div>
          <div className="nav-project-name">{project.name}</div>
          <div className="mono nav-project-repo">
            {project.repository.url.replace(/^https?:\/\/github\.com\//, '')}
          </div>
        </div>
      )}

      <div className="nav-items">
        {DESTINATIONS.map((d) => {
          const disabled = d.scoped && !project;
          const badge = badgeFor(d.to);
          const path = d.scoped && project ? `/projects/${project.projectId}/${d.to}` : d.to;

          if (disabled) {
            return (
              <span key={d.to} className="nav-item disabled" aria-disabled="true">
                <span className="nav-dot" />
                <span className="nav-label">{d.label}</span>
              </span>
            );
          }
          return (
            <NavLink
              key={d.to}
              to={path}
              className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
            >
              <span className="nav-dot" />
              <span className="nav-label">{d.label}</span>
              {badge && (
                <span className="nav-badge mono" style={{ color: badge.color }}>
                  {badge.text}
                </span>
              )}
            </NavLink>
          );
        })}
      </div>

      <div className="nav-spacer" />

      {/* Spec §53's North-Star metric, given a panel of its own rather than a
          slot in a toolbar. It is the number the whole product is judged on. */}
      <div className="nav-autonomy">
        <div className="mono nav-autonomy-label">AUTONOMOUS COMPLETION</div>
        <div className="nav-autonomy-value">
          <span className="nav-autonomy-pct">
            {autonomyDisplay(project?.summary.autonomy?.completionPct)}
          </span>
          <span className="mono nav-autonomy-unit">ELIGIBLE WORK</span>
        </div>
      </div>

      {profile && (
        <div className="nav-account">
          <span className="nav-avatar">{profile.initials}</span>
          <span className="nav-account-who">
            <span className="nav-account-name">{profile.displayName}</span>
            <span className="mono nav-account-kind">GOOGLE ACCOUNT</span>
          </span>
          <button className="mono nav-logout" onClick={() => void signOut()}>LOG OUT</button>
        </div>
      )}

      {project && isLive(project.stage) && (
        <div className="mono nav-foot">Working unattended</div>
      )}
    </nav>
  );
}
