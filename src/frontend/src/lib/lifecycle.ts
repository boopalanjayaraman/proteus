import type { Project } from '@proteus/schema';

/**
 * Project lifecycle, on the screen side (PRD-17).
 *
 * The rule these encode: a disabled button is a courtesy and the API's 409 is
 * the actual guarantee. Everything here decides what to *show*; nothing here
 * decides what is allowed.
 */

/** Stages where a run may still be writing, so neither action is offered. */
const BUSY_STAGES = ['ANALYZING', 'MIGRATING', 'VERIFYING'];

/**
 * A project written before `lifecycle` existed reads back without it. Absent
 * means ACTIVE — the opposite reading would put an archived banner on every
 * older project and disable every action on it.
 */
const lifecycleOf = (p: Pick<Project, 'lifecycle'>) => p.lifecycle ?? 'ACTIVE';

export const isArchived = (p: Pick<Project, 'lifecycle'>): boolean =>
  lifecycleOf(p) === 'ARCHIVED';

/** Read-only: the project can be looked at, and nothing more. */
export const isReadOnly = (p: Pick<Project, 'lifecycle'>): boolean =>
  lifecycleOf(p) !== 'ACTIVE';

export interface ActionAvailability {
  enabled: boolean;
  /** Why not, in words a person can act on. Absent when enabled. */
  reason?: string;
}

/**
 * Whether archiving is offered, and why not when it is not.
 *
 * A disabled control with no explanation is worse than an enabled one that
 * fails: the user cannot tell whether they lack permission, picked the wrong
 * project, or need to wait.
 */
export function canArchive(p: Pick<Project, 'lifecycle' | 'stage'>): ActionAvailability {
  const lifecycle = lifecycleOf(p);
  if (lifecycle === 'ARCHIVED') return { enabled: false, reason: 'Already archived.' };
  if (lifecycle === 'DELETED') return { enabled: false, reason: 'This project is deleted.' };
  if (BUSY_STAGES.includes(p.stage)) {
    return {
      enabled: false,
      reason: `Wait for ${p.stage.toLowerCase()} to finish — archiving now would leave a `
        + 'run writing to a project nobody can open.',
    };
  }
  return { enabled: true };
}

export function canDelete(
  p: Pick<Project, 'lifecycle' | 'stage'>,
  isPlatformAdmin: boolean,
): ActionAvailability {
  if (!isPlatformAdmin) {
    return { enabled: false, reason: 'Deleting a project needs the platform admin role.' };
  }
  if (lifecycleOf(p) === 'DELETED') return { enabled: false, reason: 'Already deleted.' };
  if (BUSY_STAGES.includes(p.stage)) {
    return { enabled: false, reason: `Wait for ${p.stage.toLowerCase()} to finish.` };
  }
  return { enabled: true };
}

/**
 * Whether stopping is offered.
 *
 * Only while there is a run to stop. A project that never started one, or whose
 * run already ended, has nothing to interrupt — offering it would suggest the
 * product is doing something it is not.
 */
export function canStop(
  p: Pick<Project, 'lifecycle' | 'stage' | 'summary'>,
): ActionAvailability {
  if (p.lifecycle === 'DELETED') return { enabled: false, reason: 'This project is deleted.' };
  if (!p.summary.migrationApproved) {
    return { enabled: false, reason: 'No migration has been started.' };
  }
  if (p.summary.migrationComplete) {
    return { enabled: false, reason: 'The migration has already finished.' };
  }
  return { enabled: true };
}

/** The confirmation gate: the id, typed exactly. */
export const confirmMatches = (typed: string, projectId: string): boolean =>
  typed.trim() === projectId;

/** What the banner on an archived project says. */
export const READ_ONLY_NOTICE =
  'This project is archived and cannot be changed. Its reports, evidence and diff '
  + 'remain available to download. The sandbox has been released.';

/** Plain-English summary of a deletion preview, so numbers are not the whole answer. */
export function previewSummary(preview: {
  totalRows: number;
  rows: Array<{ collection: string; count: number }>;
  sandbox: { present: boolean };
  credential: { present: boolean };
}): string[] {
  const lines = [
    `${preview.totalRows} record${preview.totalRows === 1 ? '' : 's'} across `
    + `${preview.rows.length} collection${preview.rows.length === 1 ? '' : 's'} `
    + 'become unreachable. Nothing is erased.',
  ];
  if (preview.sandbox.present) lines.push('The sandbox is torn down and its slot freed.');
  // The one genuinely destructive part, said separately so it is not lost in a count.
  if (preview.credential.present) lines.push('The stored GitHub token is destroyed.');
  return lines;
}

// ---------------------------------------------------------------------------
// Which screens a project can reach
// ---------------------------------------------------------------------------

export type ProjectScreen = 'discovery' | 'assessment' | 'migration' | 'sandbox';

export interface ScreenAvailability {
  enabled: boolean;
  /** Why not. Rendered on the nav item, so a greyed row is never a mystery. */
  reason?: string;
}

/**
 * A screen is reachable once the work it shows has started.
 *
 * The rule, stated once: **a page that has done its job stays available for
 * ever.** Discovery remains readable after the migration finishes, because the
 * graph it built is still the evidence. Nothing is hidden once it exists.
 *
 * The converse is what was missing: every project-scoped item was enabled the
 * moment a project was selected, so the sandbox screen was reachable before a
 * migration had been approved and answered "nothing to review yet" — which
 * reads as a broken screen rather than as a step not yet taken.
 *
 * Derived from `summary` flags rather than from `stage`, because stage is a
 * cursor — it says where the project is now, not what it has been through. A
 * COMPLETED project has a discovery graph and a stage that no longer mentions it.
 */
export function screenAvailability(
  project: Pick<Project, 'stage' | 'summary'>,
  screen: ProjectScreen,
): ScreenAvailability {
  const s = project.summary;

  switch (screen) {
    // Always reachable: it starts the moment the project is created, and it is
    // where a failure is explained.
    case 'discovery':
      return { enabled: true };

    case 'assessment':
      return s.discoveryComplete || s.assessmentComplete
        ? { enabled: true }
        : { enabled: false, reason: 'Available once discovery finishes.' };

    // The migration screen shows a run. Before approval there is no run, and
    // the approval lives on the assessment screen.
    case 'migration':
      return s.migrationApproved
        ? { enabled: true }
        : { enabled: false, reason: 'Available once you approve the migration.' };

    // Both the sandbox and the report come out of a completed migration.
    case 'sandbox':
      return s.migrationComplete || s.verificationComplete || s.sandboxDeployed
        ? { enabled: true }
        : { enabled: false, reason: 'Available once the migration completes.' };
  }
}

// ---------------------------------------------------------------------------
// Handing the user from discovery to the assessment
// ---------------------------------------------------------------------------

export interface HandoffState {
  /** We have seen this project loaded, and not finished. */
  sawRunning: boolean;
}

export const NO_HANDOFF: HandoffState = { sawRunning: false };

/**
 * Whether the work is finished enough to carry the user to the assessment.
 *
 * `done` must mean **the assessment exists**, not merely that discovery
 * finished. Discovery completing starts the assessment; it does not produce
 * one. Navigating on `discoveryComplete` lands on a screen that says "no
 * assessment has been generated yet" and then needs a refresh — which is
 * exactly what it did.
 *
 * Only on the transition from running to finished, never on arrival: a project
 * that finished days ago is `done` from the first render, and navigating on that
 * would make the discovery graph unreachable — bounced out every time you tried
 * to look at the evidence.
 *
 * `loaded` is the part that is easy to miss and the reason this is a function
 * rather than two lines in an effect. The project arrives asynchronously, so the
 * first render of *any* visit has no project and therefore `done === false`.
 * Treating that as "running" makes every visit look like a completion, which is
 * exactly the bounce the guard existed to prevent.
 */
export function handoff(
  state: HandoffState,
  input: { loaded: boolean; done: boolean },
): { state: HandoffState; navigate: boolean } {
  // Nothing observed yet. Not evidence of anything.
  if (!input.loaded) return { state, navigate: false };

  if (!input.done) return { state: { sawRunning: true }, navigate: false };

  // Finished, and we watched it get there.
  if (state.sawRunning) return { state: { sawRunning: false }, navigate: true };

  // Finished before we arrived. Stay put.
  return { state, navigate: false };
}
