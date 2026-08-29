import type { Project } from '@proteus/schema';
import type { Repositories } from '../repositories';

/**
 * Credential rotation reminders (PRD-05 risk 4).
 *
 * A repository token is stored once at project creation and used for the life of
 * the project. Nothing expires it and nothing asks about it again, so the only
 * thing standing between a demo and a year-old PAT with write access is a
 * reminder somebody sees.
 *
 * Deliberately a reminder rather than an expiry: revoking a credential mid-run
 * would break a migration to solve a hygiene problem. The event goes in the
 * audit trail and the tile shows it; the decision stays with the owner.
 */

export interface SweepResult {
  scanned: number;
  reminded: string[];
  /** Already reminded and not yet rotated — counted, not re-emitted. */
  alreadyReminded: string[];
}

/**
 * Emits `CREDENTIAL_ROTATION_DUE` for every project past its rotation date.
 *
 * Idempotent through the event log's own uniqueness: the key names the project
 * and the stored secret version, so a sweep that runs hourly emits once per
 * credential rather than once per hour. Rotating the secret produces a new
 * version and therefore a new key, which is exactly when a fresh reminder is
 * wanted again.
 */
export async function sweepRotations(
  repos: Repositories,
  now = new Date(),
): Promise<SweepResult> {
  const due = await repos.projects.collection
    .find({
      'repository.credential.rotationDueAt': { $lte: now },
      'repository.credential.status': { $ne: 'REVOKED' },
    } as never)
    .limit(200)
    .toArray() as unknown as Project[];

  const reminded: string[] = [];
  const alreadyReminded: string[] = [];

  for (const project of due) {
    const credential = project.repository.credential;
    if (!credential) continue;

    const idempotencyKey =
      `rotation:${project.projectId}:${credential.secretName}@${credential.secretVersion}`;

    const before = await repos.events.findOne({ idempotencyKey } as never);
    const daysOverdue = Math.floor(
      (now.getTime() - credential.rotationDueAt.getTime()) / 86_400_000,
    );

    await repos.events.emit(project.projectId, {
      type: 'CREDENTIAL_ROTATION_DUE', phase: 'SYSTEM', level: 'ACTIVITY', severity: 'WARN',
      title: 'Repository credential is due for rotation',
      // The reference, never the value — the same discipline that applies
      // everywhere else this credential is mentioned.
      message: `${credential.secretName}@${credential.secretVersion} was stored `
        + `${credential.storedAt.toISOString().slice(0, 10)} and became due `
        + `${daysOverdue === 0 ? 'today' : `${daysOverdue} day(s) ago`}. `
        + 'Rotate it in Secret Manager and update the project.',
      actor: 'SYSTEM', refs: {},
      idempotencyKey,
    });

    (before ? alreadyReminded : reminded).push(project.projectId);
  }

  return { scanned: due.length, reminded, alreadyReminded };
}
