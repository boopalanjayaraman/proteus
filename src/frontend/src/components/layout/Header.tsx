import type { Project } from '@proteus/schema';
import { useEffect, useState } from 'react';
import { useAuth } from '../../app/AuthContext';
import { useTheme } from '../../app/ThemeContext';
import { STAGE_COLOR, STAGE_LABEL, autonomyDisplay, elapsed, isLive, mix } from '../../lib/impact';

/**
 * The persistent header.
 *
 * Everything here is derived from project state — the stage pill, the elapsed
 * timer, the autonomy figures. Nothing is stored as a label, so nothing can
 * drift from what it describes.
 */
export function Header({ crumb, project }: { crumb: string; project?: Project | null }) {
  const { profile, signOut } = useAuth();
  const { theme, toggle } = useTheme();

  const live = project ? isLive(project.stage) : false;
  const [, tick] = useState(0);

  // Only runs on the two live screens; elsewhere there is no timer to advance.
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [live]);

  const autonomy = project?.summary.autonomy;

  return (
    <header className="hdr">
      <div className="hdr-left">
        <span className="brand mono">PROTEUS</span>
        <span className="label crumb">{crumb}</span>
      </div>

      <div className="hdr-right">
        {project && (
          <span
            className="pill mono"
            style={{
              color: STAGE_COLOR[project.stage],
              background: mix(STAGE_COLOR[project.stage], 13),
            }}
          >
            {STAGE_LABEL[project.stage]}
          </span>
        )}

        {live && (
          <span className="stat">
            <span className="label">Elapsed</span>
            <b className="mono">{elapsed(project?.stageEnteredAt)}</b>
          </span>
        )}

        {autonomy && (
          <>
            <span className="stat">
              <span className="label">Autonomous completion</span>
              <b className="mono" style={{ color: 'var(--ok)' }}>
                {autonomyDisplay(autonomy.completionPct)}
              </b>
            </span>
            <span className="stat">
              <span className="label">Human engineering actions</span>
              <b className="mono">{autonomy.humanEngineeringActions}</b>
            </span>
          </>
        )}

        <button className="ghost" onClick={toggle} title="Switch theme">
          {theme === 'dark' ? 'LIGHT' : 'DARK'}
        </button>

        {profile && (
          <div className="account">
            <span className="avatar mono">{profile.initials}</span>
            <div className="account-menu">
              <div className="account-name">{profile.displayName}</div>
              <div className="label">Google account</div>
              <button className="ghost" onClick={() => void signOut()}>LOG OUT</button>
            </div>
          </div>
        )}
      </div>
    </header>
  );
}
