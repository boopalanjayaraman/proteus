import type { Project } from '@proteus/schema';
import { NavLink } from 'react-router-dom';
import { isLive } from '../../lib/impact';

/**
 * Left navigation.
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
] as const;

export function Nav({ project }: { project?: Project | null }) {
  const live = project ? isLive(project.stage) : false;

  const badgeFor = (to: string): { text: string; color: string } | null => {
    if (!project) return null;
    if (to === 'discovery' && project.stage === 'ANALYZING') return { text: 'LIVE', color: 'var(--acc)' };
    if (to === 'migration' && project.stage === 'MIGRATING') return { text: 'LIVE', color: 'var(--acc)' };
    if (to === 'assessment' && project.actionRequired) return { text: 'GATE', color: 'var(--warn)' };
    return null;
  };

  return (
    <nav className="nav">
      {DESTINATIONS.map((d) => {
        const disabled = d.scoped && !project;
        const badge = badgeFor(d.to);
        const path = d.scoped && project ? `/projects/${project.projectId}/${d.to}` : d.to;

        if (disabled) {
          return (
            <span key={d.to} className="nav-item disabled" aria-disabled="true">
              {d.label}
            </span>
          );
        }
        return (
          <NavLink
            key={d.to}
            to={path}
            className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
          >
            <span>{d.label}</span>
            {badge && (
              <span className="nav-badge mono" style={{ color: badge.color }}>
                {badge.text}
              </span>
            )}
          </NavLink>
        );
      })}
      {live && <span className="nav-foot label">Working unattended</span>}
    </nav>
  );
}
