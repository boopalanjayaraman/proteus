import { ActivityCategory } from '@proteus/schema';
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../app/AuthContext';
import {
  CATEGORY_LABEL, CATEGORY_ORDER, appendPage, emptyMessage, isFiltered, rowsFrom,
  toQuery, type ActivityFilters, type ActivityRow,
} from '../lib/activity';

/**
 * The activity log.
 *
 * One screen, two audiences. A user sees their own history; a platform admin
 * sees everyone's and can filter to one person. The difference is decided
 * server-side and arrives as `scope` — this screen renders what it was given
 * rather than deciding what to ask for, because a client that chooses its own
 * scope is a client that can be asked to choose differently.
 */

const OUTCOMES = ['SUCCESS', 'DENIED', 'FAILED'] as const;

export function Activity() {
  const { api } = useAuth();

  const [rows, setRows] = useState<ActivityRow[]>([]);
  const [filters, setFilters] = useState<ActivityFilters>({});
  const [scope, setScope] = useState<'ALL' | 'SELF' | 'USER'>('SELF');
  const [isAdmin, setIsAdmin] = useState(false);
  const [cursor, setCursor] = useState<string | undefined>();
  const [users, setUsers] = useState<Array<{ userId: string; userEmail: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  /** `more` appends; anything else replaces, so a filter change starts over. */
  const load = useCallback(async (mode: 'replace' | 'more', after?: string) => {
    setBusy(true);
    setError(null);
    try {
      const page = await api.activity({
        ...toQuery(filters),
        ...(mode === 'more' && after ? { cursor: after } : {}),
      } as Parameters<typeof api.activity>[0]);
      const next = rowsFrom(page.entries);
      setRows((prev) => (mode === 'more' ? appendPage(prev, next) : next));
      setCursor(page.nextCursor);
      setScope(page.scope);
      setIsAdmin(page.isAdmin);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [api, filters]);

  useEffect(() => { void load('replace'); }, [load]);

  useEffect(() => {
    api.activityUsers().then((r) => setUsers(r.users)).catch(() => undefined);
  }, [api]);

  const filtered = isFiltered(filters);
  const set = (patch: Partial<ActivityFilters>) =>
    setFilters((f) => ({ ...f, ...patch }));

  return (
    <div className="activity">
      <header className="activity-head">
        <div>
          <h1>Activity</h1>
          <p className="sub">
            {scope === 'ALL'
              ? 'Every action taken on this platform, newest first.'
              : scope === 'USER'
                ? 'One user’s activity, newest first.'
                : 'Everything you have done here, newest first.'}
            {' '}Times are UTC.
          </p>
        </div>
        {isAdmin && (
          <span className="mono activity-role" title="Seeded from PLATFORM_ADMIN_EMAILS">
            PLATFORM ADMIN
          </span>
        )}
      </header>

      <section className="activity-filters">
        <input
          className="activity-search"
          placeholder="Search summaries and targets…"
          value={filters.q ?? ''}
          onChange={(e) => set({ q: e.target.value })}
        />

        <select
          value={filters.category ?? ''}
          onChange={(e) => set({
            category: (ActivityCategory.safeParse(e.target.value).data) ?? undefined,
          })}
        >
          <option value="">All categories</option>
          {CATEGORY_ORDER.map((c) => (
            <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>
          ))}
        </select>

        <select
          value={filters.outcome ?? ''}
          onChange={(e) => set({ outcome: e.target.value || undefined })}
        >
          <option value="">Any outcome</option>
          {OUTCOMES.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>

        {/* Only an admin has more than one user to choose from; the endpoint
            returns just the caller otherwise, so the control is theirs alone. */}
        {isAdmin && users.length > 0 && (
          <select
            value={filters.userId ?? ''}
            onChange={(e) => set({ userId: e.target.value || undefined })}
          >
            <option value="">All users</option>
            {users.map((u) => (
              <option key={u.userId} value={u.userId}>{u.userEmail || u.userId}</option>
            ))}
          </select>
        )}

        <label className="activity-date">
          <span className="label">From</span>
          <input
            type="date" value={filters.from ?? ''}
            onChange={(e) => set({ from: e.target.value || undefined })}
          />
        </label>
        <label className="activity-date">
          <span className="label">To</span>
          <input
            type="date" value={filters.to ?? ''}
            onChange={(e) => set({ to: e.target.value || undefined })}
          />
        </label>

        {/* Recorded but hidden by default: page views are most of the rows and
            least of the meaning, and burying an approval under forty of them
            would make this page useless for the thing it exists for. */}
        <label className="activity-toggle">
          <input
            type="checkbox"
            checked={filters.includeNavigation ?? false}
            onChange={(e) => set({ includeNavigation: e.target.checked })}
          />
          <span>Show page visits</span>
        </label>

        {filtered && (
          <button className="ghost" onClick={() => setFilters({})}>Clear</button>
        )}
      </section>

      {error && <div className="mono activity-error">{error}</div>}

      <div className="activity-list">
        <div className="mono activity-row activity-header-row">
          <span>TIMESTAMP (UTC)</span>
          <span>CATEGORY</span>
          <span>ACTIVITY</span>
          <span>PROJECT</span>
          {scope !== 'SELF' && <span>USER</span>}
        </div>

        {rows.length === 0 && !busy && (
          <div className="mono panel-empty">{emptyMessage(filtered, scope)}</div>
        )}

        {rows.map((r) => (
          <div key={r.activityId}>
            <button
              className={`mono activity-row${open === r.activityId ? ' open' : ''}`}
              onClick={() => setOpen(open === r.activityId ? null : r.activityId)}
            >
              <span className="activity-at">{r.at}</span>
              <span className="activity-cat" style={{ color: r.colour }}>
                {r.categoryLabel}
              </span>
              <span className="activity-summary">
                <span className="activity-glyph" style={{ color: r.tone }}>{r.glyph}</span>
                {r.summary}
                {/* A page view is the one thing the browser asserted. Saying so
                    costs a word and stops a reader treating it as observed. */}
                {r.declared && <span className="activity-declared">declared</span>}
              </span>
              <span className="activity-project">{r.projectId ?? '—'}</span>
              {scope !== 'SELF' && <span className="activity-user">{r.userEmail}</span>}
            </button>

            {open === r.activityId && (
              <div className="mono activity-detail">
                {r.target && <div><span className="label">TARGET</span> {r.target}</div>}
                {r.screen && <div><span className="label">SCREEN</span> {r.screen}</div>}
                <div><span className="label">OUTCOME</span> {r.outcome}</div>
                {r.detail.map((d) => (
                  <div key={d.key}>
                    <span className="label">{d.key.toUpperCase()}</span> {d.value}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {cursor && (
        <button
          className="ghost activity-more"
          disabled={busy}
          onClick={() => void load('more', cursor)}
        >
          {busy ? 'Loading…' : 'Load more'}
        </button>
      )}
    </div>
  );
}
