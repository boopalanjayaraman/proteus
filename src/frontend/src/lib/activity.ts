import { isoUtc, type ActivityCategory, type Screen, type UserActivity } from '@proteus/schema';

/**
 * Activity screen logic, kept out of the component.
 *
 * The screen is a list with filters, which is exactly the kind of thing that
 * looks too simple to test until a date range silently excludes today or a
 * cursor page repeats a row.
 */

/**
 * Which screen a path belongs to.
 *
 * Matched against the router's own six routes. Returning `undefined` for
 * anything else is deliberate: an unrecognised path sends no header, and the
 * backend records no page visit, which is better than recording a guess.
 */
export function screenForPath(pathname: string): Screen | undefined {
  const path = pathname.replace(/\/+$/, '') || '/projects';
  if (path === '/projects') return 'PROJECTS';
  if (path === '/projects/new') return 'PROJECT_CREATE';
  if (path === '/activity') return 'ACTIVITY';

  const m = /^\/projects\/[^/]+\/(discovery|assessment|migration|sandbox)$/.exec(path);
  switch (m?.[1]) {
    case 'discovery': return 'DISCOVERY';
    case 'assessment': return 'ASSESSMENT';
    case 'migration': return 'MIGRATION';
    case 'sandbox': return 'SANDBOX';
    default: return undefined;
  }
}

export const CATEGORY_LABEL: Record<ActivityCategory, string> = {
  AUTH: 'Account',
  PROJECT: 'Projects',
  CREDENTIAL: 'Credentials',
  ANALYSIS: 'Analysis',
  MIGRATION: 'Migration',
  SANDBOX: 'Sandbox',
  ARTIFACT: 'Downloads',
  ACCESS: 'Access',
  ADMIN: 'Administration',
  NAVIGATION: 'Navigation',
};

/**
 * Filter order, most consequential first.
 *
 * Navigation is last because it is the one nobody is looking for — it is most of
 * the rows and least of the meaning, and it is excluded from the default view.
 */
export const CATEGORY_ORDER: ActivityCategory[] = [
  'MIGRATION', 'PROJECT', 'CREDENTIAL', 'ACCESS', 'ARTIFACT',
  'ANALYSIS', 'SANDBOX', 'AUTH', 'ADMIN', 'NAVIGATION',
];

export const CATEGORY_COLOR: Record<ActivityCategory, string> = {
  MIGRATION: 'var(--acc)',
  PROJECT: 'var(--fg2)',
  CREDENTIAL: 'var(--vio)',
  ACCESS: 'var(--warn)',
  ARTIFACT: 'var(--fg2)',
  ANALYSIS: 'var(--acc)',
  SANDBOX: 'var(--ok)',
  AUTH: 'var(--fg3)',
  ADMIN: 'var(--vio)',
  NAVIGATION: 'var(--fg3)',
};

export const OUTCOME_GLYPH: Record<string, string> = {
  SUCCESS: '·',
  DENIED: '✗',
  FAILED: '!',
};

export const OUTCOME_TONE: Record<string, string> = {
  SUCCESS: 'var(--fg3)',
  DENIED: 'var(--warn)',
  FAILED: 'var(--bad)',
};

export interface ActivityFilters {
  category?: ActivityCategory;
  projectId?: string;
  outcome?: string;
  userId?: string;
  from?: string;
  to?: string;
  q?: string;
  includeNavigation?: boolean;
}

/**
 * Turns the form's state into query parameters.
 *
 * `to` is widened to the end of the day. A user picking today as the end of a
 * range means "up to and including today", but a bare date parses as midnight,
 * which excludes everything that has happened since — the exact rows they were
 * most likely looking for.
 */
export function toQuery(f: ActivityFilters): Record<string, string | boolean> {
  const q: Record<string, string | boolean> = {};
  if (f.category) q['category'] = f.category;
  if (f.projectId?.trim()) q['projectId'] = f.projectId.trim();
  if (f.outcome) q['outcome'] = f.outcome;
  if (f.userId?.trim()) q['userId'] = f.userId.trim();
  if (f.q?.trim()) q['q'] = f.q.trim();
  if (f.from) q['from'] = `${f.from}T00:00:00.000Z`;
  if (f.to) q['to'] = `${f.to}T23:59:59.999Z`;
  if (f.includeNavigation) q['includeNavigation'] = true;
  return q;
}

/** Whether any filter is narrowing the list, for the "clear" affordance. */
export function isFiltered(f: ActivityFilters): boolean {
  return Boolean(
    f.category || f.projectId?.trim() || f.outcome || f.userId?.trim()
    || f.q?.trim() || f.from || f.to || f.includeNavigation,
  );
}

export interface ActivityRow {
  activityId: string;
  at: string;
  category: ActivityCategory;
  categoryLabel: string;
  colour: string;
  summary: string;
  target?: string;
  projectId?: string;
  screen?: Screen;
  outcome: string;
  glyph: string;
  tone: string;
  /** Shown so a reader can tell an observation from a label the browser sent. */
  declared: boolean;
  userEmail: string;
  detail: Array<{ key: string; value: string }>;
}

/**
 * One row per entry, rendered.
 *
 * The timestamp is taken from `atUtc` where the server sent it and formatted
 * locally otherwise, so the two paths cannot disagree about what an instant is.
 */
export function rowsFrom(
  entries: Array<UserActivity & { atUtc?: string }>,
): ActivityRow[] {
  return entries.map((e) => ({
    activityId: e.activityId,
    at: e.atUtc ?? isoUtc(e.at),
    category: e.category,
    categoryLabel: CATEGORY_LABEL[e.category] ?? e.category,
    colour: CATEGORY_COLOR[e.category] ?? 'var(--fg3)',
    summary: e.summary,
    ...(e.target ? { target: e.target } : {}),
    ...(e.projectId ? { projectId: e.projectId } : {}),
    ...(e.screen ? { screen: e.screen } : {}),
    outcome: e.outcome,
    glyph: OUTCOME_GLYPH[e.outcome] ?? '·',
    tone: OUTCOME_TONE[e.outcome] ?? 'var(--fg3)',
    declared: e.provenance === 'DECLARED',
    userEmail: e.userEmail,
    detail: Object.entries(e.detail ?? {}).map(([key, value]) => ({
      key, value: String(value),
    })),
  }));
}

/**
 * Appends a page without duplicating rows.
 *
 * Cursor paging makes a repeat unlikely rather than impossible — a page can be
 * requested twice by a double click or a re-render — and a duplicated key in a
 * React list is a rendering bug, not a cosmetic one.
 */
export function appendPage(existing: ActivityRow[], next: ActivityRow[]): ActivityRow[] {
  const seen = new Set(existing.map((r) => r.activityId));
  return [...existing, ...next.filter((r) => !seen.has(r.activityId))];
}

/** "Nothing yet" versus "nothing matching", which are different problems. */
export function emptyMessage(filtered: boolean, scope: 'ALL' | 'SELF' | 'USER'): string {
  if (filtered) return 'No activity matches these filters.';
  return scope === 'ALL'
    ? 'No activity has been recorded on this platform yet.'
    : 'No activity recorded yet. Everything you do here will appear on this page.';
}
