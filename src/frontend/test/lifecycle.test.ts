import type { Project } from '@proteus/schema';
import { describe, expect, it } from 'vitest';
import {
  READ_ONLY_NOTICE, canArchive, canDelete, confirmMatches, isArchived, isReadOnly,
  previewSummary, screenAvailability, handoff, NO_HANDOFF,
} from '../src/lib/lifecycle';

/**
 * PRD-17 — what the screen offers.
 *
 * None of this is the guarantee: the API refuses the writes whatever these
 * return. It decides what to show, and specifically what to say when an action
 * is unavailable, because a disabled control with no explanation is worse than
 * an enabled one that fails.
 */

const p = (lifecycle: string, stage = 'COMPLETED') =>
  ({ lifecycle, stage } as Pick<Project, 'lifecycle' | 'stage'>);

describe('read-only state', () => {
  it('treats archived and deleted as read-only, active as not', () => {
    expect(isReadOnly(p('ACTIVE'))).toBe(false);
    expect(isReadOnly(p('ARCHIVED'))).toBe(true);
    expect(isReadOnly(p('DELETED'))).toBe(true);
    expect(isArchived(p('ARCHIVED'))).toBe(true);
    expect(isArchived(p('DELETED'))).toBe(false);
  });

  it('tells the reader the evidence survives', () => {
    // The fear an archive banner has to answer immediately.
    expect(READ_ONLY_NOTICE).toContain('remain available');
    expect(READ_ONLY_NOTICE).toContain('sandbox has been released');
  });
});

describe('canArchive', () => {
  it('offers archiving on a finished project', () => {
    expect(canArchive(p('ACTIVE', 'COMPLETED')).enabled).toBe(true);
    expect(canArchive(p('ACTIVE', 'FAILED')).enabled).toBe(true);
  });

  it('refuses while a run may still be writing, and says which run', () => {
    for (const stage of ['ANALYZING', 'MIGRATING', 'VERIFYING']) {
      const a = canArchive(p('ACTIVE', stage));
      expect(a.enabled, stage).toBe(false);
      expect(a.reason, stage).toContain(stage.toLowerCase());
    }
  });

  it('refuses an already-archived project without pretending it is an error', () => {
    expect(canArchive(p('ARCHIVED')).reason).toBe('Already archived.');
  });
});

describe('canDelete', () => {
  it('needs the platform admin role, and says so', () => {
    const d = canDelete(p('ACTIVE'), false);
    expect(d.enabled).toBe(false);
    expect(d.reason).toContain('platform admin');
  });

  it('is offered to an admin on an active or archived project', () => {
    expect(canDelete(p('ACTIVE'), true).enabled).toBe(true);
    expect(canDelete(p('ARCHIVED'), true).enabled).toBe(true);
  });

  it('is offered on a failed project — clearing those is why it exists', () => {
    expect(canDelete(p('ACTIVE', 'FAILED'), true).enabled).toBe(true);
  });

  it('refuses while a run holds a lease', () => {
    expect(canDelete(p('ACTIVE', 'MIGRATING'), true).enabled).toBe(false);
  });
});

describe('confirmMatches', () => {
  it('accepts the exact id, trimmed', () => {
    expect(confirmMatches('PQC-0184', 'PQC-0184')).toBe(true);
    expect(confirmMatches('  PQC-0184  ', 'PQC-0184')).toBe(true);
  });

  it('rejects anything else, including a near miss', () => {
    // The whole value of typing it is that a near miss does not pass.
    expect(confirmMatches('PQC-0185', 'PQC-0184')).toBe(false);
    expect(confirmMatches('pqc-0184', 'PQC-0184')).toBe(false);
    expect(confirmMatches('', 'PQC-0184')).toBe(false);
  });
});

describe('previewSummary', () => {
  const base = {
    totalRows: 42,
    rows: [{ collection: 'findings', count: 40 }, { collection: 'artifacts', count: 2 }],
    sandbox: { present: false },
    credential: { present: false },
  };

  it('says records become unreachable rather than erased', () => {
    // The distinction the whole soft delete rests on.
    const [first] = previewSummary(base);
    expect(first).toContain('42 records across 2 collections');
    expect(first).toContain('Nothing is erased');
  });

  it('names the sandbox and the token separately from the count', () => {
    const lines = previewSummary({
      ...base, sandbox: { present: true }, credential: { present: true },
    });
    // The token is the one genuinely destructive part; it must not be lost
    // inside a row count.
    expect(lines.some((l) => l.includes('token is destroyed'))).toBe(true);
    expect(lines.some((l) => l.includes('slot freed'))).toBe(true);
  });

  it('omits what is not there', () => {
    expect(previewSummary(base)).toHaveLength(1);
  });

  it('gets the singular right', () => {
    const [line] = previewSummary({
      ...base, totalRows: 1, rows: [{ collection: 'findings', count: 1 }],
    });
    expect(line).toContain('1 record across 1 collection');
    expect(line).not.toContain('records');
  });
});

describe('what the kebab menu offers', () => {
  /** Mirrors ProjectMenu's construction, which is the part worth pinning. */
  const menuFor = (project: Pick<Project, 'lifecycle' | 'stage'>, isAdmin: boolean) => [
    { id: 'archive', availability: canArchive(project) },
    ...(isAdmin ? [{ id: 'delete', availability: canDelete(project, true) }] : []),
  ];

  it('hides delete entirely from a non-admin rather than greying it', () => {
    // A disabled Delete tells a user the action exists and they are not allowed
    // it, which is an invitation to go looking.
    expect(menuFor(p('ACTIVE'), false).map((a) => a.id)).toEqual(['archive']);
  });

  it('shows both to a platform admin', () => {
    expect(menuFor(p('ACTIVE'), true).map((a) => a.id)).toEqual(['archive', 'delete']);
  });

  it('leaves delete usable on an archived project, and archive not', () => {
    const menu = menuFor(p('ARCHIVED'), true);
    expect(menu.find((a) => a.id === 'archive')?.availability.enabled).toBe(false);
    expect(menu.find((a) => a.id === 'delete')?.availability.enabled).toBe(true);
  });

  it('gives every disabled item a reason to show on hover', () => {
    for (const a of menuFor(p('ACTIVE', 'MIGRATING'), true)) {
      expect(a.availability.enabled).toBe(false);
      expect(a.availability.reason, a.id).toBeTruthy();
    }
  });

  it('offers a non-admin nothing at all on an archived project', () => {
    // ProjectMenu renders no trigger when every action is gone.
    const menu = menuFor(p('ARCHIVED'), false);
    expect(menu.every((a) => !a.availability.enabled)).toBe(true);
  });
});

describe('projects that predate the lifecycle field', () => {
  // Absent means ACTIVE. The opposite reading would put an archived banner on
  // every project created before PRD-17 and disable every action on it.
  const old = { lifecycle: undefined, stage: 'COMPLETED' } as unknown as
    Pick<Project, 'lifecycle' | 'stage'>;

  it('is not archived and not read-only', () => {
    expect(isArchived(old)).toBe(false);
    expect(isReadOnly(old)).toBe(false);
  });

  it('can still be archived and deleted', () => {
    expect(canArchive(old).enabled).toBe(true);
    expect(canDelete(old, true).enabled).toBe(true);
  });
});

describe('screenAvailability', () => {
  const project = (over: Partial<Project['summary']> = {}, stage = 'CREATED') => ({
    stage,
    summary: {
      discoveryComplete: false, assessmentComplete: false, migrationApproved: false,
      migrationComplete: false, verificationComplete: false, sandboxDeployed: false,
      ...over,
    },
  } as unknown as Pick<Project, 'stage' | 'summary'>);

  it('always allows discovery — it is where a failure is explained', () => {
    expect(screenAvailability(project(), 'discovery').enabled).toBe(true);
    expect(screenAvailability(project({}, 'FAILED'), 'discovery').enabled).toBe(true);
  });

  it('opens the assessment once discovery finishes', () => {
    expect(screenAvailability(project(), 'assessment').enabled).toBe(false);
    expect(screenAvailability(project({ discoveryComplete: true }), 'assessment').enabled).toBe(true);
  });

  it('opens the migration only after approval', () => {
    // The approval lives on the assessment screen; before it there is no run.
    expect(screenAvailability(project({ discoveryComplete: true }), 'migration').enabled)
      .toBe(false);
    expect(screenAvailability(project({ migrationApproved: true }), 'migration').enabled)
      .toBe(true);
  });

  it('opens the sandbox only after the migration completes', () => {
    // The bug this replaces: the sandbox screen was reachable from the moment a
    // project was selected and answered "nothing to review yet".
    expect(screenAvailability(project({ migrationApproved: true }), 'sandbox').enabled)
      .toBe(false);
    expect(screenAvailability(project({ migrationComplete: true }), 'sandbox').enabled)
      .toBe(true);
  });

  it('keeps every finished screen available for ever', () => {
    // A page that has done its job stays readable — the discovery graph is
    // still the evidence after the migration is done.
    const finished = project({
      discoveryComplete: true, assessmentComplete: true, migrationApproved: true,
      migrationComplete: true, verificationComplete: true, sandboxDeployed: true,
    }, 'COMPLETED');
    for (const s of ['discovery', 'assessment', 'migration', 'sandbox'] as const) {
      expect(screenAvailability(finished, s).enabled, s).toBe(true);
    }
  });

  it('gives every unavailable screen a reason', () => {
    for (const s of ['assessment', 'migration', 'sandbox'] as const) {
      expect(screenAvailability(project(), s).reason, s).toBeTruthy();
    }
  });
});

describe('handoff from discovery to the assessment', () => {
  /** Replays a sequence of renders and reports where it navigated. */
  const replay = (steps: Array<{ loaded: boolean; done: boolean }>) => {
    let state = NO_HANDOFF;
    const navigations: number[] = [];
    steps.forEach((step, i) => {
      const r = handoff(state, step);
      state = r.state;
      if (r.navigate) navigations.push(i);
    });
    return navigations;
  };

  it('navigates when a running discovery finishes', () => {
    expect(replay([
      { loaded: false, done: false },  // first render, project not fetched
      { loaded: true, done: false },   // running
      { loaded: true, done: false },
      { loaded: true, done: true },    // finished, while watching
    ])).toEqual([3]);
  });

  it('does not navigate when arriving at a finished project', () => {
    // The bug: `project` loads asynchronously, so the first render of every
    // visit has no project and therefore `done === false`. Reading that as
    // "running" made every visit look like a completion, and clicking
    // "Live discovery" bounced straight to the assessment.
    expect(replay([
      { loaded: false, done: false },
      { loaded: true, done: true },
    ])).toEqual([]);
  });

  it('never navigates twice for one completion', () => {
    expect(replay([
      { loaded: true, done: false },
      { loaded: true, done: true },
      { loaded: true, done: true },
      { loaded: true, done: true },
    ])).toEqual([1]);
  });

  it('lets the user come back and stay', () => {
    // Navigate away on completion, return to the graph, and stay there.
    let state = NO_HANDOFF;
    for (const step of [{ loaded: true, done: false }, { loaded: true, done: true }]) {
      state = handoff(state, step).state;
    }
    // A fresh mount on the same finished project.
    expect(replay([{ loaded: false, done: false }, { loaded: true, done: true }])).toEqual([]);
  });

  it('treats an unloaded project as no evidence either way', () => {
    expect(replay([{ loaded: false, done: false }, { loaded: false, done: true }])).toEqual([]);
  });
});
