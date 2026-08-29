import type { Project, SandboxDeployment } from '@proteus/schema';
import type { Repositories } from '../repositories';
import type { SandboxDeployer } from '../../integrations/cloudrun/sandbox';

/**
 * How many sandboxes are kept, and what happens past that (D-020).
 *
 * The decision that shapes this file: **the caps limit what is RETAINED, never
 * what is deployed.** Every migration deploys, probes and exercises a real
 * sandbox, because spec §35 lists a started sandbox and a passing end-to-end
 * scenario among the conditions for VERIFIED. Refusing to deploy past a cap
 * would report a correct migration as unverified because the platform was busy —
 * a statement about our capacity dressed up as a statement about someone's code.
 *
 * So past a cap the sandbox is released immediately after the scenarios pass.
 * It exists for about a minute, costs nothing, and the verdict is untouched;
 * only the shareable link is absent, and the report says why.
 */

/** A deployment that is still holding a service and an image. */
const LIVE: ReadonlyArray<SandboxDeployment['status']> = [
  'BUILDING_IMAGE', 'DEPLOYING', 'STARTING', 'READY',
];

export interface CapacityLimits {
  perUser: number;
  total: number;
}

export interface CapacityState {
  perUserUsed: number;
  perUserLimit: number;
  totalUsed: number;
  totalLimit: number;
  /** Retained if deployed now — the question the caller is actually asking. */
  canRetain: boolean;
  /** Which cap bound, when it cannot. */
  boundBy?: 'USER' | 'PLATFORM';
  /** Names the user's own sandboxes, so a refusal says which to release. */
  ownProjects: string[];
  /** When the earliest slot frees, so a wait can be quoted rather than guessed. */
  nextExpiryAt?: Date;
}

export class SandboxCapacityError extends Error {
  constructor(
    readonly code: 'SANDBOX_USER_CAP_REACHED' | 'SANDBOX_PLATFORM_CAP_REACHED',
    readonly state: CapacityState,
    message: string,
  ) {
    super(message);
    this.name = 'SandboxCapacityError';
  }
}

export class SandboxCapacityService {
  constructor(
    private readonly repos: Repositories,
    private readonly limits: CapacityLimits,
  ) {}

  /**
   * What is used and what is free.
   *
   * A project counts once however often it has been migrated, because a rerun
   * replaces its container rather than adding one (FR-9). That is what makes
   * "3 per user" a count of projects rather than of runs.
   */
  async state(ownerId: string, excludingProjectId?: string): Promise<CapacityState> {
    const live = await this.repos.sandboxDeployments.collection
      .find({ status: { $in: LIVE }, placement: 'CLOUD_RUN' } as never)
      .toArray() as unknown as SandboxDeployment[];

    const projectIds = [...new Set(live.map((d) => d.projectId))]
      .filter((id) => id !== excludingProjectId);

    const owned = projectIds.length === 0
      ? []
      : (await this.repos.projects.collection
          // Deliberately includes archived and deleted projects. A deployment
          // that is still live counts against its owner whatever happened to
          // the project — dropping it here is the leak PRD-17 exists to fix.
          .find({ projectId: { $in: projectIds }, ownerId } as never)
          .toArray() as unknown as Project[]).map((p) => p.projectId);

    const expiries = live
      .map((d) => d.expiresAt)
      .filter((d): d is Date => d instanceof Date)
      .sort((a, b) => a.getTime() - b.getTime());

    const perUserUsed = owned.length;
    const totalUsed = projectIds.length;
    const boundBy = perUserUsed >= this.limits.perUser
      ? 'USER' as const
      : totalUsed >= this.limits.total ? 'PLATFORM' as const : undefined;

    return {
      perUserUsed,
      perUserLimit: this.limits.perUser,
      totalUsed,
      totalLimit: this.limits.total,
      canRetain: !boundBy,
      ...(boundBy ? { boundBy } : {}),
      ownProjects: owned,
      ...(expiries[0] ? { nextExpiryAt: expiries[0] } : {}),
    };
  }

  /**
   * Reclaims anything already past its expiry, then reports capacity.
   *
   * Reclaiming first is what stops the caps being a ratchet: a platform that
   * only ever counts upward reaches thirty and stays there, whatever has since
   * been abandoned. A live sandbox is never evicted to make room — someone may
   * be reviewing it.
   */
  async reclaimThenCheck(
    ownerId: string,
    projectId: string,
    reclaim: (deployment: SandboxDeployment) => Promise<void>,
    now = new Date(),
  ): Promise<CapacityState> {
    const expired = await this.repos.sandboxDeployments.collection
      .find({
        status: { $in: LIVE },
        placement: 'CLOUD_RUN',
        expiresAt: { $lte: now },
      } as never)
      .toArray() as unknown as SandboxDeployment[];

    for (const deployment of expired) await reclaim(deployment);

    return this.state(ownerId, projectId);
  }
}

/**
 * Marks a deployment released and frees what it held.
 *
 * `reason` is the field that keeps a capacity release distinguishable from a
 * failure. Both end with no link; only one is a defect, and the report has to be
 * able to tell a reader which.
 */
export async function releaseSandbox(
  repos: Repositories,
  deployer: SandboxDeployer,
  deployment: SandboxDeployment,
  reason: 'CAPACITY' | 'EXPIRED' | 'REQUESTED' | 'PROJECT_DELETED',
): Promise<void> {
  await deployer.teardown({
    serviceName: deployment.service.name,
    ...(deployment.imageUri ? { imageUri: deployment.imageUri } : {}),
  }).catch(() => undefined);

  const now = new Date();
  await repos.sandboxDeployments.collection.updateOne(
    { sandboxDeploymentId: deployment.sandboxDeploymentId } as never,
    { $set: { status: 'TORN_DOWN', tornDownReason: reason, updatedAt: now } as never },
  );

  // The completion screen reads `summary.sandboxUrl`; leaving it set after
  // teardown offers a link that 404s.
  await repos.projects.collection.updateOne(
    { projectId: deployment.projectId } as never,
    {
      $unset: { 'summary.sandboxUrl': '' } as never,
      $set: { 'summary.sandboxDeployed': false, updatedAt: now } as never,
    },
  );

  await repos.events.emit(deployment.projectId, {
    type: 'SANDBOX_DEPLOYMENT_READY', phase: 'SANDBOX', level: 'ACTIVITY',
    severity: reason === 'CAPACITY' ? 'WARN' : 'INFO',
    title: reason === 'CAPACITY'
      ? 'Sandbox released — hosting capacity reached'
      : `Sandbox torn down — ${reason.replace(/_/g, ' ').toLowerCase()}`,
    message: reason === 'CAPACITY'
      ? 'The application was deployed, started and exercised end to end, so the '
        + 'migration is fully verified. The service was then released because the '
        + 'platform is at its retained-sandbox limit, so no shareable link remains.'
      : `${deployment.service.name} removed, with its image.`,
    actor: 'SYSTEM', refs: { sandboxDeploymentId: deployment.sandboxDeploymentId },
  });
}
