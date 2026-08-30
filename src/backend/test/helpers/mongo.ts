import { MongoClient } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { __setHandle } from '../../src/core/db/client';
import { ensureIndexes } from '../../src/core/db/indexes';
import { runBackfills } from '../../src/core/db/migrations';
import { Repositories } from '../../src/core/repositories';

/**
 * A real replica set, not a mock.
 *
 * Change streams are the mechanism the live screens depend on, and they exist
 * only on a replica set. Testing against a standalone would leave the behaviour
 * most likely to break in production entirely unexercised.
 */
export interface TestDb {
  repos: Repositories;
  client: MongoClient;
  /** For tests that need a second connection of their own. */
  uri: string;
  stop: () => Promise<void>;
}

export async function startTestDb(): Promise<TestDb> {
  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const client = new MongoClient(replSet.getUri());
  await client.connect();
  const db = client.db('proteus_test');

  __setHandle({ client, db, supportsChangeStreams: true });
  await ensureIndexes(db);
  await runBackfills(db);

  return {
    repos: new Repositories(db),
    client,
    uri: replSet.getUri(),
    stop: async () => {
      __setHandle(null);
      await client.close();
      await replSet.stop();
    },
  };
}

/** Empties every collection between tests without dropping the indexes. */
export async function clearAll(repos: Repositories): Promise<void> {
  const names = await repos.db.listCollections().toArray();
  await Promise.all(names.map((c) => repos.db.collection(c.name).deleteMany({})));
}

let seq = 0;

export function aProject(overrides: Record<string, unknown> = {}) {
  const now = new Date();
  return {
    _schemaVersion: 1,
    createdAt: now,
    updatedAt: now,
    ownerId: 'firebase-uid-1',
    name: `Payment API PQC Migration ${++seq}`,
    repository: {
      url: 'https://github.com/northwind-pay/payments-api',
      provider: 'GITHUB' as const,
      defaultBranch: 'main',
      visibility: 'PUBLIC' as const,
    },
    stage: 'CREATED' as const,
    stageEnteredAt: now,
    actionRequired: false,
    summary: {
      lastActivityAt: now,
      lastActivityText: 'Project created',
      discoveryComplete: false,
      assessmentComplete: false,
      migrationApproved: false,
      migrationComplete: false,
      verificationComplete: false,
      sandboxDeployed: false,
      counts: {
        findings: 0, recommendations: 0, graphNodes: 0,
        graphEdges: 0, openGates: 0, migrationChanges: 0,
      },
      autonomy: {
        eligibleItems: 0, completedAutonomously: 0, completionPct: null,
        humanEngineeringActions: 0, approvals: 0,
      },
    },
    current: {},
    lastEventSeq: 0,
    graphVersion: 0,
    version: 0,
    ...overrides,
  };
}

export function anEvent(overrides: Record<string, unknown> = {}) {
  return {
    type: 'CRYPTO_FINDING_DETECTED' as const,
    phase: 'DISCOVERY' as const,
    level: 'ACTIVITY' as const,
    severity: 'INFO' as const,
    title: 'RSA-2048 detected',
    actor: 'AGENT' as const,
    refs: {},
    ...overrides,
  };
}
