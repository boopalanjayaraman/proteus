import type { Disposition, MigrationImpact, ProjectStage } from '@proteus/schema';

/**
 * Display mappings.
 *
 * All derived, never stored — the data model is explicit that stage labels,
 * progress rails and CTA text are functions of state (§0 rule 9). Keeping them
 * here rather than in components means the derivation is testable and there is
 * one place to look when a label is wrong.
 */

/** The graph legend collapses vendor and hardware into one swatch; the data keeps them apart. */
export const IMPACT_COLOR: Record<MigrationImpact, string> = {
  MIGRATION_REQUIRED: 'var(--bad)',
  MIGRATION_LIKELY: 'var(--warn)',
  DEPENDENCY_REQUIRES_INVESTIGATION: 'var(--acc)',
  NO_PQC_CHANGE_REQUIRED: 'var(--ok)',
  VENDOR_CONTROLLED: 'var(--vio)',
  HARDWARE_CONTROLLED: 'var(--vio)',
  BLOCKED: 'var(--bad)',
  UNKNOWN: 'var(--fg3)',
};

export const IMPACT_LABEL: Record<MigrationImpact, string> = {
  MIGRATION_REQUIRED: 'MIGRATION REQUIRED',
  MIGRATION_LIKELY: 'MIGRATION LIKELY',
  DEPENDENCY_REQUIRES_INVESTIGATION: 'DEPENDENCY REQUIRES INVESTIGATION',
  NO_PQC_CHANGE_REQUIRED: 'NO PQC CHANGE REQUIRED',
  VENDOR_CONTROLLED: 'VENDOR / HARDWARE CONTROLLED',
  HARDWARE_CONTROLLED: 'VENDOR / HARDWARE CONTROLLED',
  BLOCKED: 'BLOCKED',
  UNKNOWN: 'UNKNOWN',
};

export const STAGE_LABEL: Record<ProjectStage, string> = {
  CREATED: 'CREATED',
  ANALYZING: 'ANALYZING',
  ASSESSMENT_READY: 'ASSESSMENT READY',
  AWAITING_APPROVAL: 'AWAITING APPROVAL',
  MIGRATING: 'MIGRATING',
  VERIFYING: 'VERIFYING',
  SANDBOX_READY: 'SANDBOX READY',
  COMPLETED: 'COMPLETED',
  NEEDS_HUMAN_ACTION: 'NEEDS HUMAN ACTION',
  FAILED: 'FAILED',
};

export const STAGE_COLOR: Record<ProjectStage, string> = {
  CREATED: 'var(--fg3)',
  ANALYZING: 'var(--acc)',
  ASSESSMENT_READY: 'var(--ok)',
  AWAITING_APPROVAL: 'var(--warn)',
  MIGRATING: 'var(--acc)',
  VERIFYING: 'var(--acc)',
  SANDBOX_READY: 'var(--ok)',
  COMPLETED: 'var(--ok)',
  NEEDS_HUMAN_ACTION: 'var(--bad)',
  FAILED: 'var(--bad)',
};

export const DISPOSITION_COLOR: Record<Disposition, string> = {
  AUTONOMOUS_MIGRATION: 'var(--bad)',
  ASSISTED_MIGRATION: 'var(--warn)',
  NO_CHANGE_REQUIRED: 'var(--ok)',
  VENDOR_DEPENDENCY: 'var(--vio)',
  HARDWARE_REPLACEMENT: 'var(--vio)',
  HUMAN_DECISION_REQUIRED: 'var(--vio)',
  NEEDS_FURTHER_INVESTIGATION: 'var(--acc)',
};

/** A translucent wash of a token colour, for badge backgrounds. */
export const mix = (color: string, percent: number): string =>
  `color-mix(in srgb, ${color} ${percent}%, transparent)`;

/** Two stages are live; the nav badges them and the header shows an elapsed timer. */
export const isLive = (stage: ProjectStage): boolean =>
  stage === 'ANALYZING' || stage === 'MIGRATING';

/**
 * The tile's call to action. Derived, never stored — a stored label would drift
 * from the stage it describes.
 */
export function actionLabel(stage: ProjectStage, actionRequired: boolean): string {
  if (actionRequired) return 'DECISION REQUIRED';
  switch (stage) {
    case 'AWAITING_APPROVAL': return 'REVIEW & APPROVE';
    case 'ASSESSMENT_READY': return 'REVIEW ASSESSMENT';
    case 'ANALYZING':
    case 'MIGRATING':
    case 'VERIFYING': return 'IN PROGRESS';
    case 'SANDBOX_READY': return 'REVIEW SANDBOX';
    case 'COMPLETED': return 'VIEW REPORT';
    case 'FAILED': return 'VIEW FAILURE';
    default: return 'OPEN';
  }
}

/** `mm:ss`, for the elapsed timer on the two live screens. */
export function elapsed(since: Date | string | undefined, now = Date.now()): string {
  if (!since) return '00:00';
  const ms = now - new Date(since).getTime();
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/** Renders as an em dash before a migration starts — never as "0%". */
export function autonomyDisplay(pct: number | null | undefined): string {
  return pct === null || pct === undefined ? '—' : `${Math.round(pct)}%`;
}
