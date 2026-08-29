import type { Project } from '@proteus/schema';
import { NavLink } from 'react-router-dom';
import { useAuth } from '../../app/AuthContext';
import { useTheme } from '../../app/ThemeContext';
import { STAGE_COLOR, STAGE_LABEL, autonomyDisplay, isLive, mix } from '../../lib/impact';
import { screenAvailability, type ProjectScreen } from '../../lib/lifecycle';

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
/**
 * Everything that exists whether or not a project is selected.
 *
 * Above the separator, because they are how you get somewhere else — and
 * `Projects` in particular must stay reachable without giving up the project you
 * are working on.
 */
const GLOBAL = [
  { to: '/projects', label: 'Projects', end: true },
  { to: '/projects/new', label: 'Create project', end: false },
  { to: '/activity', label: 'Activity', end: true },
] as const;

/** The selected project's own screens, in the order the work happens. */
const SCOPED = [
  { to: 'discovery', label: 'Live discovery' },
  { to: 'assessment', label: 'Assessment' },
  { to: 'migration', label: 'Live migration' },
  { to: 'sandbox', label: 'Sandbox & report' },
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
      <div className="nav-items">
        {GLOBAL.map((d) => (
          <NavLink
            key={d.to}
            to={d.to}
            end={d.end}
            className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
          >
            <span className="nav-dot" />
            <span className="nav-label">{d.label}</span>
          </NavLink>
        ))}
      </div>


      {/* Below a rule, so the rail reads as "where you can go" and then "what
          you are working on" rather than as one undifferentiated list. */}
      <div className="nav-sep" />

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
          <NavLink className="mono nav-project-edit" to={`/projects/${project.projectId}/edit`}>
            EDIT DETAILS
          </NavLink>
        </div>
      )}

      {/*
        Always rendered, never conditionally present.
        A menu whose items appear and disappear makes the product feel like it
        is changing shape underneath you, and gives no clue that the screens
        exist at all before a project is selected. They are shown and disabled,
        each carrying the reason it cannot be opened yet.
      */}
      <div className="nav-items">
        {SCOPED.map((d) => {
          const availability = project
            ? screenAvailability(project, d.to as ProjectScreen)
            : { enabled: false, reason: 'Select a project first.' };
          const badge = project ? badgeFor(d.to) : null;

          if (!availability.enabled) {
            return (
              <span
                key={d.to}
                className="nav-item disabled"
                aria-disabled="true"
                title={availability.reason}
              >
                <span className="nav-dot" />
                <span className="nav-label">{d.label}</span>
              </span>
            );
          }
          return (
            <NavLink
              key={d.to}
              to={`/projects/${project!.projectId}/${d.to}`}
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
