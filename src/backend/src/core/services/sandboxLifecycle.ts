import type { SandboxDeployment } from '@proteus/schema';
import type { SandboxDeployer } from '../../integrations/cloudrun/sandbox';
import type { Repositories } from '../repositories';
import { releaseSandbox } from './sandboxCapacity';

/**
 * When a sandbox goes away (PRD-16 §11).
 *
 * Two clocks, because one of them alone gets it wrong. An absolute TTL from
 * deployment reclaims a sandbox somebody is still reviewing; a pure inactivity
 * clock lets one live forever if it is opened weekly. So: seven days from the
 * last time it was opened, and thirty days from first deployment whatever
 * happens.
 *
 * "Inactivity" here means *opened through Proteus*, not traffic. True traffic
 * inactivity would need Cloud Monitoring's request_count, another client and
 * another role. The approximation is stated rather than hidden: someone who
 * bookmarks the raw URL and visits it directly will not refresh the clock — and
 * for a sandbox that exists to be reviewed from the completion screen, that is
 * the access path that matters.
 */

export interface LifecycleLimits {
  ttlDays: number;
  hardTtlDays: number;
}

const DAY_MS = 86_400_000;

export class SandboxLifecycleService {
  constructor(
    private readonly repos: Repositories,
    private readonly limits: LifecycleLimits,
  ) {}

  /** The two dates a new deployment starts with. */
  windowFor(now = new Date()): { expiresAt: Date; hardExpiresAt: Date } {
    return {
      expiresAt: new Date(now.getTime() + this.limits.ttlDays * DAY_MS),
      hardExpiresAt: new Date(now.getTime() + this.limits.hardTtlDays * DAY_MS),
    };
  }

  /**
   * Records an access and pushes the expiry out — never past the ceiling.
   *
   * `min` is the whole rule. Without it a sandbox opened once a week lives
   * forever, which is precisely the outcome a TTL exists to prevent.
   */
  async extend(
    projectId: string,
    now = new Date(),
  ): Promise<{ deployment: SandboxDeployment; extended: boolean; atCeiling: boolean } | null> {
    const rows = await this.repos.sandboxDeployments.collection
      .find({ projectId } as never).sort({ createdAt: -1 }).limit(1).toArray();
    const deployment = rows[0] as SandboxDeployment | undefined;
    if (!deployment || deployment.status === 'TORN_DOWN') return null;

    const ceiling = deployment.hardExpiresAt
      ?? new Date(deployment.createdAt.getTime() + this.limits.hardTtlDays * DAY_MS);
    const wanted = new Date(now.getTime() + this.limits.ttlDays * DAY_MS);
    const expiresAt = wanted < ceiling ? wanted : ceiling;
    const atCeiling = wanted >= ceiling;

    await this.repos.sandboxDeployments.collection.updateOne(
      { sandboxDeploymentId: deployment.sandboxDeploymentId } as never,
      {
        $set: {
          expiresAt, hardExpiresAt: ceiling, lastAccessedAt: now, updatedAt: now,
        } as never,
      },
    );

    return {
      deployment: { ...deployment, expiresAt, hardExpiresAt: ceiling, lastAccessedAt: now },
      extended: expiresAt > (deployment.expiresAt ?? new Date(0)),
      atCeiling,
    };
  }

  /** Everything past its expiry, or past its ceiling whatever its expiry says. */
  async expired(now = new Date(), limit = 100): Promise<SandboxDeployment[]> {
    return this.repos.sandboxDeployments.collection
      .find({
        status: { $in: ['BUILDING_IMAGE', 'DEPLOYING', 'STARTING', 'READY'] },
        $or: [{ expiresAt: { $lte: now } }, { hardExpiresAt: { $lte: now } }],
      } as never)
      .limit(limit)
      .toArray() as unknown as Promise<SandboxDeployment[]>;
  }
}

export interface SweepResult {
  scanned: number;
  reclaimed: string[];
  failed: Array<{ projectId: string; reason: string }>;
}

/**
 * The scheduled reclaim.
 *
 * Deliberately tolerant: one sandbox whose service has already been deleted by
 * hand must not stop the sweep reclaiming the other twenty-nine. A failure is
 * recorded and the loop continues.
 */
export async function sweepSandboxes(
  repos: Repositories,
  lifecycle: SandboxLifecycleService,
  deployerFor: (deployment: SandboxDeployment) => SandboxDeployer | null,
  now = new Date(),
): Promise<SweepResult> {
  const expired = await lifecycle.expired(now);
  const result: SweepResult = { scanned: expired.length, reclaimed: [], failed: [] };

  for (const deployment of expired) {
    const deployer = deployerFor(deployment);
    if (!deployer) {
      // A LOCAL sandbox recorded by a process that is no longer running has
      // nothing here that can reclaim it. Marked so it stops being counted,
      // rather than left to be retried forever.
      await repos.sandboxDeployments.collection.updateOne(
        { sandboxDeploymentId: deployment.sandboxDeploymentId } as never,
        { $set: { status: 'TORN_DOWN', tornDownReason: 'EXPIRED', updatedAt: now } as never },
      );
      result.reclaimed.push(deployment.projectId);
      continue;
    }
    try {
      await releaseSandbox(repos, deployer, deployment, 'EXPIRED');
      result.reclaimed.push(deployment.projectId);
    } catch (e) {
      result.failed.push({ projectId: deployment.projectId, reason: (e as Error).message });
    }
  }

  return result;
}
