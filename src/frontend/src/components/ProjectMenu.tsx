import type { Project } from '@proteus/schema';
import { useEffect, useRef, useState } from 'react';
import { canArchive, canDelete, type ActionAvailability } from '../lib/lifecycle';

/**
 * The per-project actions menu (PRD-17).
 *
 * A kebab in the tile's corner rather than a control elsewhere on the page:
 * these actions belong to one project, and anything that makes you name the
 * project separately from the thing you are looking at is a way to act on the
 * wrong one.
 *
 * Rendered as a sibling of the tile button, never a child — a button inside a
 * button is invalid, and the browser's recovery from it is to drop one of them.
 */

export interface MenuAction {
  id: 'archive' | 'delete';
  label: string;
  danger: boolean;
  availability: ActionAvailability;
}

export function ProjectMenu({ project, isPlatformAdmin, onChoose }: {
  project: Project;
  isPlatformAdmin: boolean;
  onChoose: (action: 'archive' | 'delete') => void;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  // Closes on an outside click and on Escape. Both are what people expect of a
  // popover, and neither is free.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const actions: MenuAction[] = [
    { id: 'archive', label: 'Archive', danger: false, availability: canArchive(project) },
    ...(isPlatformAdmin
      ? [{
          id: 'delete' as const, label: 'Delete', danger: true,
          availability: canDelete(project, true),
        }]
      : []),
  ];

  // A menu with nothing in it is a button that does nothing.
  if (actions.length === 0) return null;

  return (
    <div className="menu" ref={wrap}>
      <button
        type="button"
        className="menu-trigger"
        aria-label={`Actions for ${project.name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
      >
        <span aria-hidden="true">⋮</span>
      </button>

      {open && (
        <div className="menu-pop" role="menu">
          {actions.map((a) => (
            <button
              key={a.id}
              type="button"
              role="menuitem"
              className={`menu-item${a.danger ? ' danger' : ''}`}
              disabled={!a.availability.enabled}
              // The reason lives on the item, so a greyed row is never a
              // mystery — hovering it says why.
              title={a.availability.reason}
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
                onChoose(a.id);
              }}
            >
              <span className="menu-item-label">{a.label}</span>
              {a.availability.reason && (
                <span className="menu-item-why">{a.availability.reason}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
