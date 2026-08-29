import type { Project } from '@proteus/schema';
import { useEffect, useState } from 'react';
import { elapsed, isLive } from '../../lib/impact';

/**
 * The breadcrumb bar (UX v1.3).
 *
 * Deliberately thin. Everything that used to live up here — brand, theme,
 * account, the autonomy figure — moved into the left rail, leaving this with
 * three things: where you are, how long the current phase has been running, and
 * the count that has to stay at zero for the product's claim to hold.
 *
 * All three are derived from project state. Nothing is stored as a label, so
 * nothing can drift from what it describes.
 */
export function Header({ crumb, project }: { crumb: string; project?: Project | null }) {
  const live = project ? isLive(project.stage) : false;
  const [, tick] = useState(0);

  // Only runs on the two live screens; elsewhere there is no timer to advance.
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [live]);

  const actions = project?.summary.autonomy?.humanEngineeringActions;

  return (
    <header className="hdr">
      <span className="mono hdr-crumb">{crumb}</span>
      <span className="hdr-spacer" />

      {live && (
        <span className="mono hdr-elapsed">
          {/* Pulses only while something is actually running. */}
          <span className="hdr-pulse" aria-hidden="true" />
          ELAPSED {elapsed(project?.stageEnteredAt)}
        </span>
      )}

      {actions !== undefined && (
        <span className="mono hdr-actions">
          HUMAN ENGINEERING ACTIONS <b>{actions}</b>
        </span>
      )}
    </header>
  );
}
