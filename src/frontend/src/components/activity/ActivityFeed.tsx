import type { EventLevel, ProjectEvent } from '@proteus/schema';

/**
 * The live activity feed.
 *
 * Newest first, because during a run the newest line is the one being watched.
 * The level filter is the spec's own three-level model: MILESTONE for what a
 * stakeholder wants, ACTIVITY for what an engineer wants, DETAIL for what a
 * sceptic wants.
 */

const SEVERITY_COLOR: Record<string, string> = {
  SUCCESS: 'var(--ok)', WARN: 'var(--warn)', ERROR: 'var(--bad)', INFO: 'var(--acc)',
};

const KIND = (e: ProjectEvent): string => e.type.replace(/_/g, ' ');

const clock = (at: Date | string, since: Date | string | undefined): string => {
  if (!since) return '';
  const s = Math.max(0, Math.floor((new Date(at).getTime() - new Date(since).getTime()) / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

interface Props {
  events: ProjectEvent[];
  since?: Date | string;
  level: EventLevel | 'ALL';
  onLevel: (level: EventLevel | 'ALL') => void;
  status: string;
}

const LEVELS: Array<EventLevel | 'ALL'> = ['ALL', 'MILESTONE', 'ACTIVITY', 'DETAIL'];

export function ActivityFeed({ events, since, level, onLevel, status }: Props) {
  const shown = level === 'ALL' ? events : events.filter((e) => e.level === level);

  return (
    <div className="feed">
      <div className="feed-head">
        <span className={`feed-pulse ${status === 'open' ? 'on' : ''}`} />
        <span className="mono feed-title">LIVE ACTIVITY</span>
        <div className="feed-levels">
          {LEVELS.map((l) => (
            <button
              key={l}
              className={`mono feed-level ${level === l ? 'on' : ''}`}
              onClick={() => onLevel(l)}
            >
              {l}
            </button>
          ))}
        </div>
        <span className="mono feed-status">{status === 'open' ? 'SSE' : status.toUpperCase()}</span>
      </div>

      <div className="feed-rows">
        {shown.length === 0 && <div className="mono feed-empty">Waiting for the first event…</div>}
        {[...shown].reverse().map((e) => (
          <div key={e.eventId} className="feed-row">
            <div className="feed-rail" style={{ background: SEVERITY_COLOR[e.severity] ?? 'var(--fg3)' }} />
            <div className="feed-body">
              <div className="feed-meta">
                <span className="mono feed-kind" style={{ color: SEVERITY_COLOR[e.severity] ?? 'var(--fg3)' }}>
                  {KIND(e)}
                </span>
                <span className="mono feed-time">{clock(e.ts, since)}</span>
              </div>
              <div className="feed-text">{e.title}</div>
              {e.message && <div className="mono feed-detail">{e.message}</div>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
