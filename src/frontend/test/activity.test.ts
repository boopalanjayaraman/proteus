import type { UserActivity } from '@proteus/schema';
import { describe, expect, it } from 'vitest';
import {
  CATEGORY_ORDER, appendPage, emptyMessage, isFiltered, rowsFrom, screenForPath, toQuery,
} from '../src/lib/activity';

/**
 * PRD-15 — the screen's logic, without the DOM.
 *
 * `screenForPath` is the whole page-view mechanism: the backend records a visit
 * from the header this produces, so a path it gets wrong is a visit attributed
 * to the wrong screen or not recorded at all.
 */

const entry = (over: Partial<UserActivity> = {}): UserActivity => ({
  _schemaVersion: 1,
  createdAt: new Date('2026-08-29T14:32:11Z'),
  updatedAt: new Date('2026-08-29T14:32:11Z'),
  activityId: 'act_1',
  userId: 'uid-1',
  userEmail: 'a@example.test',
  category: 'MIGRATION',
  action: 'MIGRATION_APPROVED',
  summary: 'Approved the migration',
  outcome: 'SUCCESS',
  provenance: 'OBSERVED',
  at: new Date('2026-08-29T14:32:11Z'),
  ...over,
} as UserActivity);

describe('screenForPath', () => {
  it('maps every route the router declares', () => {
    expect(screenForPath('/projects')).toBe('PROJECTS');
    expect(screenForPath('/projects/new')).toBe('PROJECT_CREATE');
    expect(screenForPath('/activity')).toBe('ACTIVITY');
    expect(screenForPath('/projects/PQC-0001/discovery')).toBe('DISCOVERY');
    expect(screenForPath('/projects/PQC-0001/assessment')).toBe('ASSESSMENT');
    expect(screenForPath('/projects/PQC-0001/migration')).toBe('MIGRATION');
    expect(screenForPath('/projects/PQC-0001/sandbox')).toBe('SANDBOX');
  });

  it('tolerates a trailing slash and treats the root as the project list', () => {
    expect(screenForPath('/projects/')).toBe('PROJECTS');
    expect(screenForPath('/projects/PQC-0001/sandbox/')).toBe('SANDBOX');
    expect(screenForPath('/')).toBe('PROJECTS');
  });

  it('returns nothing for a path it does not know', () => {
    // No header, so no page visit — better than recording a guess, and the one
    // place the browser could otherwise invent a screen.
    expect(screenForPath('/projects/PQC-0001')).toBeUndefined();
    expect(screenForPath('/projects/PQC-0001/settings')).toBeUndefined();
    expect(screenForPath('/admin')).toBeUndefined();
  });

  it('does not confuse a project id with a route segment', () => {
    expect(screenForPath('/projects/discovery')).toBeUndefined();
    expect(screenForPath('/projects/PQC-0001/discovery/extra')).toBeUndefined();
  });
});

describe('toQuery', () => {
  it('sends nothing for an empty filter', () => {
    expect(toQuery({})).toEqual({});
  });

  it('widens the end date to the end of that day', () => {
    // A bare date parses as midnight, which excludes everything that happened
    // today — the rows a user picking "to: today" is most likely looking for.
    expect(toQuery({ to: '2026-08-29' })['to']).toBe('2026-08-29T23:59:59.999Z');
    expect(toQuery({ from: '2026-08-29' })['from']).toBe('2026-08-29T00:00:00.000Z');
  });

  it('drops blank values rather than sending empty filters', () => {
    expect(toQuery({ q: '   ', projectId: '', userId: '  ' })).toEqual({});
  });

  it('trims what it does send', () => {
    expect(toQuery({ q: '  payments  ' })['q']).toBe('payments');
  });

  it('sends the navigation toggle only when it is on', () => {
    expect(toQuery({ includeNavigation: false })['includeNavigation']).toBeUndefined();
    expect(toQuery({ includeNavigation: true })['includeNavigation']).toBe(true);
  });
});

describe('isFiltered', () => {
  it('is false for an untouched form and true for any narrowing', () => {
    expect(isFiltered({})).toBe(false);
    expect(isFiltered({ q: '  ' })).toBe(false);
    expect(isFiltered({ category: 'MIGRATION' })).toBe(true);
    expect(isFiltered({ includeNavigation: true })).toBe(true);
    expect(isFiltered({ from: '2026-08-29' })).toBe(true);
  });
});

describe('rowsFrom', () => {
  it('prefers the server-rendered timestamp', () => {
    const [row] = rowsFrom([{ ...entry(), atUtc: '2026-08-29T14:32:11Z' }]);
    expect(row?.at).toBe('2026-08-29T14:32:11Z');
  });

  it('formats one itself when the server did not, to the same shape', () => {
    const [row] = rowsFrom([entry()]);
    // Two paths that disagreed about an instant would put two readers in
    // different timezones without either of them knowing.
    expect(row?.at).toBe('2026-08-29T14:32:11Z');
  });

  it('marks a declared entry and leaves an observed one alone', () => {
    const rows = rowsFrom([
      entry({ provenance: 'DECLARED', category: 'NAVIGATION', action: 'PAGE_VIEWED' }),
      entry({ activityId: 'act_2' }),
    ]);
    expect(rows[0]?.declared).toBe(true);
    expect(rows[1]?.declared).toBe(false);
  });

  it('gives a denied entry its own glyph and tone', () => {
    const [row] = rowsFrom([entry({ outcome: 'DENIED', action: 'ACCESS_DENIED', category: 'ACCESS' })]);
    expect(row?.glyph).toBe('✗');
    expect(row?.tone).toBe('var(--warn)');
  });

  it('flattens detail into printable pairs', () => {
    const [row] = rowsFrom([entry({ detail: { approvedItems: 3, atCeiling: false } })]);
    expect(row?.detail).toEqual([
      { key: 'approvedItems', value: '3' },
      { key: 'atCeiling', value: 'false' },
    ]);
  });

  it('omits absent optional fields rather than rendering undefined', () => {
    const [row] = rowsFrom([entry()]);
    expect(row?.target).toBeUndefined();
    expect(row?.projectId).toBeUndefined();
    expect(row?.detail).toEqual([]);
  });
});

describe('appendPage', () => {
  it('appends in order', () => {
    const a = rowsFrom([entry({ activityId: 'act_1' })]);
    const b = rowsFrom([entry({ activityId: 'act_2' })]);
    expect(appendPage(a, b).map((r) => r.activityId)).toEqual(['act_1', 'act_2']);
  });

  it('never repeats a key', () => {
    // A duplicated key in a React list is a rendering bug, not a cosmetic one,
    // and a double click on "load more" is enough to cause one.
    const a = rowsFrom([entry({ activityId: 'act_1' })]);
    expect(appendPage(a, a).map((r) => r.activityId)).toEqual(['act_1']);
  });
});

describe('empty states', () => {
  it('distinguishes "nothing yet" from "nothing matching"', () => {
    expect(emptyMessage(true, 'SELF')).toContain('matches these filters');
    expect(emptyMessage(false, 'SELF')).toContain('Everything you do here');
    expect(emptyMessage(false, 'ALL')).toContain('this platform');
  });
});

describe('category ordering', () => {
  it('lists every category exactly once, with navigation last', () => {
    expect(new Set(CATEGORY_ORDER).size).toBe(CATEGORY_ORDER.length);
    // Most of the rows, least of the meaning.
    expect(CATEGORY_ORDER.at(-1)).toBe('NAVIGATION');
    expect(CATEGORY_ORDER[0]).toBe('MIGRATION');
  });
});
