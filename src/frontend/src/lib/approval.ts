import {
  AUTONOMOUS_PLAN_MODES,
  MIGRATION_DISCLOSURE_TEXT,
  type Assessment,
  type PlanItem,
} from '@proteus/schema';

/**
 * What the approval bar and the confirmation dialog say.
 *
 * Kept out of the components because these are the sentences the user reads
 * before authorising code changes, and a sentence that can be tested is one that
 * cannot quietly stop matching what the server will do.
 */

export const isAutonomous = (item: PlanItem): boolean =>
  (AUTONOMOUS_PLAN_MODES as readonly string[]).includes(item.mode);

export interface ApprovalScope {
  /** The items the agent will execute. */
  autonomous: PlanItem[];
  /** Everything else in the plan, which approval does not authorise. */
  excluded: PlanItem[];
  /** Distinct files the agent claims it will touch. Its own contract. */
  paths: string[];
  approvable: boolean;
}

/**
 * What one approval actually authorises.
 *
 * `paths` comes from the plan's `expectedChanges`, not from a guess: it is the
 * same list verification later holds the migration to, so showing it here means
 * the user approves a scope they can afterwards check the agent stayed inside.
 */
export function scopeOf(assessment: Assessment): ApprovalScope {
  const autonomous = assessment.planItems.filter(isAutonomous);
  const paths = [
    ...new Set(autonomous.flatMap((p) => p.expectedChanges.flatMap((c) => c.paths))),
  ].sort();

  return {
    autonomous,
    excluded: assessment.planItems.filter((p) => !isAutonomous(p)),
    paths,
    // Nothing inside the boundary means there is nothing to authorise. Offering
    // the button anyway would create a migration run with no work in it.
    approvable: autonomous.length > 0 && assessment.status === 'READY',
  };
}

/** The bar's subtitle — the counts the user is agreeing to, in one line. */
export function approvalSubtitle(assessment: Assessment, recommendations: number): string {
  const { autonomous } = scopeOf(assessment);
  return [
    `${assessment.planItems.length} PLAN ITEMS`,
    `${autonomous.length} AUTONOMOUS`,
    `${recommendations} RECOMMENDATIONS RAISED`,
    'ONE-TIME HUMAN GATE',
  ].join(' · ');
}

/**
 * The request body.
 *
 * The disclosure is sent back rather than implied. The server compares it to its
 * own copy and refuses a mismatch, which is what makes a stale tab unable to
 * record consent to a list it never showed.
 */
export function approvalRequest(assessment: Assessment) {
  return {
    assessmentId: assessment.assessmentId,
    assessmentVersion: assessment.version,
    acknowledgedActions: [...MIGRATION_DISCLOSURE_TEXT],
  };
}

/**
 * Turns a rejected approval into something worth reading.
 *
 * The three refusals a user can actually cause each have a next step, and a bare
 * "409 Conflict" tells them none of it.
 */
export function approvalErrorMessage(status: number, message: string): string {
  if (status === 409) return `${message} Reload the assessment to see the current scope.`;
  if (status === 404) return 'This project is no longer available.';
  return message;
}
