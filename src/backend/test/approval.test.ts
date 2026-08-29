import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  MIGRATION_DISCLOSURE,
  MIGRATION_DISCLOSURE_TEXT,
  MigrationStage,
  type Assessment,
  type PlanItem,
} from '@proteus/schema';
import { ApprovalError } from '../src/core/services/approval';
import { aProject, clearAll, startTestDb, type TestDb } from './helpers/mongo';
import { authFor, startTestServer, type TestServer } from './helpers/server';

/** PRD-10 acceptance criteria — the one gate that turns a reader into a writer. */

let t: TestDb;
let s: TestServer;
const OWNER = 'firebase-uid-1';

beforeAll(async () => {
  t = await startTestDb();
  s = await startTestServer(t.repos);
}, 120_000);
afterAll(async () => {
  await s?.stop();
  await t?.stop();
});
beforeEach(async () => { await clearAll(t.repos); });

const planItem = (n: number, mode: PlanItem['mode']): PlanItem => ({
  planItemId: `plan_${n}`,
  targetName: `Target ${n}`,
  targetNodeIds: [],
  findingIds: [`fnd_${n}`],
  mode,
  action: 'Replace RSA key transport with ML-KEM-768',
  rationale: 'CNSA 2.0 requires it',
  expectedChanges: mode === 'NO_AUTONOMOUS_CHANGE'
    ? []
    : [{ changeType: 'SOURCE' as const, paths: ['src/Crypto.java'], description: 'swap' }],
  conditions: [],
  risk: 'MEDIUM',
  order: n,
});

/**
 * A project sitting at the gate, with a real assessment and a real open gate.
 *
 * Built directly rather than through the model: this increment owns what happens
 * at the gate, and driving Gemini to reach it would make these assertions depend
 * on prose.
 */
async function atTheGate(opts: { version?: number; status?: Assessment['status'] } = {}) {
  const version = opts.version ?? 1;
  const project = await t.repos.projects.create(aProject({
    ownerId: OWNER, stage: 'ASSESSMENT_READY',
  }) as never);

  const now = new Date();
  const assessment: Assessment = {
    _schemaVersion: 1, createdAt: now, updatedAt: now,
    assessmentId: `asmt_${project.projectId}_v${version}`,
    projectId: project.projectId,
    version,
    summary: {
      headline: 'One unambiguous autonomous migration scenario',
      whatExists: 'RSA-2048 key transport', whatIsVulnerable: 'Key establishment',
      whatAgentWillChange: 'CryptoService', whatAgentWillNotChange: 'The HSM',
    },
    snapshot: {
      findingIds: ['fnd_1', 'fnd_2', 'fnd_3'], recommendationIds: [],
      graphNodeIds: [], graphEdgeIds: [], inputFileIds: [],
      repoCommitSha: '7c41ab9d2f1e4c8b6a5d3e2f1a0b9c8d7e6f5a4b',
    },
    planItems: [
      planItem(1, 'AUTONOMOUS_MIGRATION'),
      planItem(2, 'TEST_ENVIRONMENT_ADAPTATION'),
      planItem(3, 'NO_AUTONOMOUS_CHANGE'),
    ],
    policyId: 'policy_mlkem_v1',
    status: opts.status ?? 'READY',
    generatedAt: now,
  };
  await t.repos.assessments.insert(assessment);

  await t.repos.projects.transition(project.projectId, 'ASSESSMENT_READY', 'AWAITING_APPROVAL');
  await s.approvals.openApprovalGate(project.projectId, assessment);

  return { project: (await t.repos.projects.byId(project.projectId))!, assessment };
}

const approvalBody = (a: Assessment, over: Record<string, unknown> = {}) => ({
  assessmentId: a.assessmentId,
  assessmentVersion: a.version,
  acknowledgedActions: [...MIGRATION_DISCLOSURE_TEXT],
  ...over,
});

const post = (projectId: string, body: unknown, uid = OWNER) =>
  fetch(`${s.url}/projects/${projectId}/migration/approve`, {
    method: 'POST',
    headers: { ...authFor(uid), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

// ---------------------------------------------------------------------------

describe('FR-2, FR-3 · the disclosure is data, and it covers what happens', () => {
  it('discloses every migration stage the agent can enter', () => {
    const disclosed = new Set(MIGRATION_DISCLOSURE.flatMap((d) => d.stages as readonly string[]));
    const undisclosed = MigrationStage.options.filter((st) => !disclosed.has(st));
    // The failure this catches: adding a stage to the migration without adding a
    // line to the list the user consents to.
    expect(undisclosed, 'migration stages nobody is told about').toEqual([]);
  });

  it('keeps both source lists whole — the union, never the intersection', () => {
    // Spec §20 has these and the UX modal drops them.
    expect(MIGRATION_DISCLOSURE_TEXT).toContain('validate the existing tests');
    expect(MIGRATION_DISCLOSURE_TEXT).toContain('rebuild and retest');
    // The UX modal has this and spec §20 omits it.
    expect(MIGRATION_DISCLOSURE_TEXT).toContain(
      'run end-to-end verification against the sandbox deployment',
    );
  });

  it('opens the gate with the disclosure frozen onto it', async () => {
    const { project } = await atTheGate();
    const [gate] = await s.approvals.gates(project.projectId);
    expect(gate!.type).toBe('MIGRATION_APPROVAL');
    expect(gate!.status).toBe('OPEN');
    for (const action of MIGRATION_DISCLOSURE_TEXT) {
      expect(gate!.context).toContain(action);
    }
    expect(gate!.context).toContain('remain untouched');
  });
});

describe('AC-3 · consent is recorded, not assumed', () => {
  it('persists every disclosed action onto the approval', async () => {
    const { project, assessment } = await atTheGate();
    const r = await post(project.projectId, approvalBody(assessment));
    expect(r.status).toBe(201);

    const run = (await t.repos.migrationRuns.findOne({ projectId: project.projectId } as never))!;
    expect([...run.approval.acknowledgedActions].sort())
      .toEqual([...MIGRATION_DISCLOSURE_TEXT].sort());
    expect(run.approval.approvedBy).toBe(OWNER);
    expect(run.approval.approvedAt).toBeInstanceOf(Date);
  });

  it('refuses an acknowledgement that is not the disclosure on offer', async () => {
    const { project, assessment } = await atTheGate();
    const short = MIGRATION_DISCLOSURE_TEXT.slice(0, 4);

    const r = await post(project.projectId, approvalBody(assessment, {
      acknowledgedActions: short,
    }));
    expect(r.status).toBe(400);
    // A stale tab that showed four of seventeen actions must not be able to
    // record consent to all seventeen.
    expect(await t.repos.migrationRuns.count()).toBe(0);
  });
});

describe('AC-1, FR-5 · exactly one migration run', () => {
  it('creates one run when two approvals arrive at once', async () => {
    const { project, assessment } = await atTheGate();

    const [a, b] = await Promise.all([
      post(project.projectId, approvalBody(assessment)),
      post(project.projectId, approvalBody(assessment)),
    ]);

    // Exactly one created it. The other either found the winner's run (200) or
    // lost the guarded stage transition (409) — both are correct, and which one
    // happens depends on how the two requests interleave.
    const codes = [a.status, b.status];
    expect(codes.filter((c) => c === 201)).toHaveLength(1);
    expect([200, 409]).toContain(codes.find((c) => c !== 201));

    expect(await t.repos.migrationRuns.count({ projectId: project.projectId } as never)).toBe(1);
    const p = (await t.repos.projects.byId(project.projectId))!;
    expect(p.summary.autonomy.approvals).toBe(1);
  });

  it('treats a repeated approval as the same approval, not a second one', async () => {
    const { project, assessment } = await atTheGate();
    const first = await post(project.projectId, approvalBody(assessment));
    const second = await post(project.projectId, approvalBody(assessment));

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect((await second.json()).created).toBe(false);
    expect(await t.repos.migrationRuns.count()).toBe(1);
    expect((await t.repos.projects.byId(project.projectId))!.summary.autonomy.approvals).toBe(1);
  });
});

describe('AC-2, FR-4 · the approval is pinned to a version', () => {
  it('refuses a version that is not the one on file', async () => {
    const { project, assessment } = await atTheGate();
    const r = await post(project.projectId, approvalBody(assessment, { assessmentVersion: 2 }));
    expect(r.status).toBe(409);
    expect(await t.repos.migrationRuns.count()).toBe(0);
  });

  it('refuses a superseded assessment even when the version matches', async () => {
    const { project, assessment } = await atTheGate({ status: 'SUPERSEDED' });
    const r = await post(project.projectId, approvalBody(assessment));
    expect(r.status).toBe(409);
    expect((await r.json()).error.message).toMatch(/superseded/i);
    expect(await t.repos.migrationRuns.count()).toBe(0);
  });

  it('records both the id and the version, so drift is detectable later', async () => {
    const { project, assessment } = await atTheGate();
    await post(project.projectId, approvalBody(assessment));
    const run = (await t.repos.migrationRuns.findOne({ projectId: project.projectId } as never))!;
    expect(run.approval.assessmentId).toBe(assessment.assessmentId);
    expect(run.approval.assessmentVersion).toBe(1);
    // And the tree it applies to is the one the assessment was built from.
    expect(run.branch.baseCommitSha).toBe(assessment.snapshot.repoCommitSha);
  });
});

describe('AC-4, FR-10 · a refusal changes nothing', () => {
  it('leaves stage, gate and run untouched when the approval is rejected', async () => {
    const { project, assessment } = await atTheGate();
    const before = (await t.repos.projects.byId(project.projectId))!;

    for (const body of [
      approvalBody(assessment, { assessmentVersion: 99 }),
      approvalBody(assessment, { acknowledgedActions: ['create a migration branch'] }),
      approvalBody(assessment, { approvedPlanItemIds: ['plan_3'] }),
      approvalBody(assessment, { approvedPlanItemIds: ['plan_nonexistent'] }),
    ]) {
      const r = await post(project.projectId, body);
      expect(r.ok, JSON.stringify(body)).toBe(false);
    }

    const after = (await t.repos.projects.byId(project.projectId))!;
    expect(after.stage).toBe('AWAITING_APPROVAL');
    expect(after.version).toBe(before.version);
    expect(after.summary.autonomy.approvals).toBe(0);
    expect(after.actionRequired).toBe(true);
    expect(await t.repos.migrationRuns.count()).toBe(0);

    const [gate] = await s.approvals.gates(project.projectId);
    expect(gate!.status).toBe('OPEN');
    expect(gate!.resolution).toBeUndefined();
  });

  it('refuses to authorise a plan item outside the autonomy boundary', async () => {
    const { project, assessment } = await atTheGate();
    // plan_3 is NO_AUTONOMOUS_CHANGE. Silently dropping it would let a user
    // believe they had authorised work the agent will never do.
    const r = await post(project.projectId, approvalBody(assessment, {
      approvedPlanItemIds: ['plan_1', 'plan_3'],
    }));
    expect(r.status).toBe(400);
    expect((await r.json()).error.message).toMatch(/no autonomous change/i);
  });
});

describe('AC-5, FR-6 · after approval', () => {
  it('moves to MIGRATING with a leased run and a checkpoint', async () => {
    const { project, assessment } = await atTheGate();
    const r = await post(project.projectId, approvalBody(assessment));
    expect(r.status).toBe(201);

    const p = (await t.repos.projects.byId(project.projectId))!;
    expect(p.stage).toBe('MIGRATING');
    expect(p.stageDetail).toBe('PREPARING_MIGRATION');
    expect(p.current.migrationRunId).toBe(`mig_${project.projectId}_v1`);
    expect(p.current.approvedAssessmentId).toBe(assessment.assessmentId);
    expect(p.summary.migrationApproved).toBe(true);
    // The gate is answered; nothing is waiting on the user.
    expect(p.actionRequired).toBe(false);
    expect(p.summary.counts.openGates).toBe(0);

    const run = (await t.repos.migrationRuns.findOne({ projectId: project.projectId } as never))!;
    expect(run.status).toBe('RUNNING');
    expect(run.branch.name).toBe(`agent/pqc/${project.projectId}`);
    expect(run.branch.pushed).toBe(false);
    expect(run.checkpoint.stage).toBe('PREPARING_MIGRATION');
    // Leased at creation: an unleased RUNNING run is indistinguishable from one
    // whose worker died, and a reaper would start a second migration on it.
    expect(run.lease?.holder).toBeTruthy();
    expect(run.lease!.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('refuses a project that is not at the gate', async () => {
    const { project, assessment } = await atTheGate();
    await post(project.projectId, approvalBody(assessment));

    // Same project, now MIGRATING, approving a *different* assessment version.
    const other = { ...assessment, assessmentId: `${assessment.assessmentId}x`, version: 2 };
    await t.repos.assessments.insert(other);
    const r = await post(project.projectId, approvalBody(other));
    expect(r.status).toBe(409);
    expect(await t.repos.migrationRuns.count()).toBe(1);
  });
});

describe('AC-6 · the approval is counted as an approval, not an intervention', () => {
  it('increments approvals and leaves humanEngineeringActions at zero', async () => {
    const { project, assessment } = await atTheGate();
    await post(project.projectId, approvalBody(assessment));

    const p = (await t.repos.projects.byId(project.projectId))!;
    expect(p.summary.autonomy.approvals).toBe(1);
    // The product's claim is "one approval, zero human engineering actions". It
    // only holds if the approval never lands in the other counter.
    expect(p.summary.autonomy.humanEngineeringActions).toBe(0);
  });
});

describe('FR-7 · scope, and what it authorises', () => {
  it('approves every autonomous item by default and marks the plan', async () => {
    const { project, assessment } = await atTheGate();
    await post(project.projectId, approvalBody(assessment));

    const run = (await t.repos.migrationRuns.findOne({ projectId: project.projectId } as never))!;
    expect(run.approval.approvedPlanItemIds.sort()).toEqual(['plan_1', 'plan_2']);

    const stored = (await t.repos.assessments.findOne({
      assessmentId: assessment.assessmentId,
    } as never))!;
    expect(stored.status).toBe('APPROVED');
    // Written on every item, true or false: absent is not the same as excluded.
    expect(stored.planItems.map((p) => [p.planItemId, p.approved])).toEqual([
      ['plan_1', true], ['plan_2', true], ['plan_3', false],
    ]);
  });

  it('narrows to the named items when a partial scope is approved', async () => {
    const { project, assessment } = await atTheGate();
    await post(project.projectId, approvalBody(assessment, { approvedPlanItemIds: ['plan_1'] }));

    const run = (await t.repos.migrationRuns.findOne({ projectId: project.projectId } as never))!;
    expect(run.approval.approvedPlanItemIds).toEqual(['plan_1']);
    const stored = (await t.repos.assessments.findOne({
      assessmentId: assessment.assessmentId,
    } as never))!;
    expect(stored.planItems.find((p) => p.planItemId === 'plan_2')!.approved).toBe(false);
  });
});

describe('FR-9 · before approval nothing exists to write with', () => {
  it('has no migration run and no branch until a human says so', async () => {
    const { project, assessment } = await atTheGate();

    const before = await fetch(`${s.url}/projects/${project.projectId}/migration`, {
      headers: authFor(OWNER),
    });
    expect(before.status).toBe(404);
    expect(await t.repos.migrationRuns.count()).toBe(0);

    await post(project.projectId, approvalBody(assessment));

    const after = await fetch(`${s.url}/projects/${project.projectId}/migration`, {
      headers: authFor(OWNER),
    });
    expect(after.status).toBe(200);
    expect((await after.json()).run.branch.name).toBe(`agent/pqc/${project.projectId}`);
  });
});

describe('FR-1, AC-8 · one gate shape, and an audit record', () => {
  it('resolves the gate through the generic decisions endpoint too', async () => {
    const { project, assessment } = await atTheGate();
    const [gate] = await s.approvals.gates(project.projectId);

    const r = await fetch(
      `${s.url}/projects/${project.projectId}/decisions/${gate!.gateId}`,
      {
        method: 'POST',
        headers: { ...authFor(OWNER), 'content-type': 'application/json' },
        body: JSON.stringify({ optionId: 'APPROVE', ...approvalBody(assessment) }),
      },
    );
    expect(r.status).toBe(201);
    expect((await t.repos.projects.byId(project.projectId))!.stage).toBe('MIGRATING');
  });

  it('rejects an option the gate does not offer', async () => {
    const { project } = await atTheGate();
    const [gate] = await s.approvals.gates(project.projectId);
    const r = await fetch(
      `${s.url}/projects/${project.projectId}/decisions/${gate!.gateId}`,
      {
        method: 'POST',
        headers: { ...authFor(OWNER), 'content-type': 'application/json' },
        body: JSON.stringify({ optionId: 'MAYBE' }),
      },
    );
    expect(r.status).toBe(400);
    expect((await t.repos.projects.byId(project.projectId))!.stage).toBe('AWAITING_APPROVAL');
  });

  it('leaves the approval in the audit trail with an actor and a timestamp', async () => {
    const { project, assessment } = await atTheGate();
    await post(project.projectId, approvalBody(assessment));

    const events = await t.repos.events.since(project.projectId, 0);
    const required = events.find((e) => e.type === 'HUMAN_GATE_REQUIRED');
    const approved = events.find((e) => e.type === 'MIGRATION_APPROVED');
    const resolved = events.find((e) => e.type === 'HUMAN_GATE_RESOLVED');

    expect(required?.level).toBe('MILESTONE');
    expect(approved?.level).toBe('MILESTONE');
    expect(approved?.actor).toBe('USER');
    expect(approved?.ts).toBeInstanceOf(Date);
    expect(approved?.message).toContain(`agent/pqc/${project.projectId}`);
    expect(resolved?.actor).toBe('USER');
    expect(resolved?.refs.gateId).toBe(`gate_${project.projectId}_approval_v1`);

    const gate = (await t.repos.humanGates.findOne({
      gateId: `gate_${project.projectId}_approval_v1`,
    } as never))!;
    expect(gate.status).toBe('RESOLVED');
    expect(gate.resolution?.optionId).toBe('APPROVE');
    expect(gate.resolution?.resolvedBy).toBe(OWNER);
  });

  it('withdraws the gate for a superseded version when a new one opens', async () => {
    const { project, assessment } = await atTheGate();
    const v2 = { ...assessment, assessmentId: `asmt_${project.projectId}_v2`, version: 2 };
    await t.repos.assessments.insert(v2);
    await s.approvals.openApprovalGate(project.projectId, v2);

    const gates = await s.approvals.gates(project.projectId);
    const v1Gate = gates.find((g) => g.gateId.endsWith('_v1'))!;
    const v2Gate = gates.find((g) => g.gateId.endsWith('_v2'))!;
    // The old question is no longer the one being asked.
    expect(v1Gate.status).toBe('WITHDRAWN');
    expect(v2Gate.status).toBe('OPEN');
  });
});

describe('ownership', () => {
  it('will not let a non-owner approve a migration', async () => {
    const { project, assessment } = await atTheGate();
    const r = await post(project.projectId, approvalBody(assessment), 'firebase-uid-2');
    expect(r.status).toBe(404);
    expect(await t.repos.migrationRuns.count()).toBe(0);
  });
});

describe('the service refuses in its own right, not only behind HTTP', () => {
  it('throws a typed error a caller can distinguish', async () => {
    const { project, assessment } = await atTheGate();
    await expect(
      s.approvals.approve(project, OWNER, {
        assessmentId: assessment.assessmentId,
        assessmentVersion: 7,
        acknowledgedActions: [...MIGRATION_DISCLOSURE_TEXT],
      }),
    ).rejects.toThrow(ApprovalError);
  });
});

describe('FR-4 · an approved assessment is final', () => {
  it('refuses to regenerate once the scope has been approved', async () => {
    const { project, assessment } = await atTheGate();
    await post(project.projectId, approvalBody(assessment));

    // Regenerating writes version N+1 and marks its predecessor SUPERSEDED.
    // Doing that here would leave the migration executing a scope that no
    // readable assessment still claims a human agreed to.
    await t.repos.projects.collection.updateOne({ projectId: project.projectId } as never, {
      $set: { 'summary.discoveryComplete': true } as never,
    });
    const r = await fetch(`${s.url}/projects/${project.projectId}/assessment`, {
      method: 'POST',
      headers: { ...authFor(OWNER), 'content-type': 'application/json' },
      body: '{}',
    });
    expect(r.status).toBe(409);

    const stored = (await t.repos.assessments.findOne({
      assessmentId: assessment.assessmentId,
    } as never))!;
    expect(stored.status).toBe('APPROVED');
  });
});
