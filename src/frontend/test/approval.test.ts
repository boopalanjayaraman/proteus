import { describe, expect, it } from 'vitest';
import {
  MIGRATION_DISCLOSURE,
  MIGRATION_DISCLOSURE_TEXT,
  MIGRATION_UNTOUCHED_STATEMENT,
  type Assessment,
  type PlanItem,
} from '@proteus/schema';
import {
  approvalErrorMessage, approvalRequest, approvalSubtitle, isAutonomous, scopeOf,
} from '../src/lib/approval';

/** PRD-10 — what the user reads before authorising code changes. */

const item = (id: string, mode: PlanItem['mode'], paths: string[] = []): PlanItem => ({
  planItemId: id, targetName: id, targetNodeIds: [], findingIds: [`fnd_${id}`],
  mode, action: 'act', rationale: 'because',
  expectedChanges: paths.length
    ? [{ changeType: 'SOURCE', paths, description: 'swap' }]
    : [],
  conditions: [], risk: 'MEDIUM', order: 0,
});

const assessmentOf = (planItems: PlanItem[], over: Partial<Assessment> = {}): Assessment => ({
  _schemaVersion: 1, createdAt: new Date(), updatedAt: new Date(),
  assessmentId: 'asmt_PQC-0184_v1', projectId: 'PQC-0184', version: 1,
  summary: {
    headline: 'h', whatExists: 'a', whatIsVulnerable: 'b',
    whatAgentWillChange: 'c', whatAgentWillNotChange: 'd',
  },
  snapshot: {
    findingIds: [], recommendationIds: [], graphNodeIds: [], graphEdgeIds: [],
    inputFileIds: [], repoCommitSha: '7c41ab9d2f1e4c8b6a5d3e2f1a0b9c8d7e6f5a4b',
  },
  planItems, policyId: 'policy_mlkem_v1', status: 'READY', generatedAt: new Date(),
  ...over,
});

describe('AC-7 · the modal shows what the agent will do', () => {
  it('discloses seventeen actions, covering every migration stage', () => {
    expect(MIGRATION_DISCLOSURE_TEXT).toHaveLength(17);
    expect(MIGRATION_DISCLOSURE).toHaveLength(MIGRATION_DISCLOSURE_TEXT.length);
    // The words the modal renders are the words the server stores. A component
    // that wrote its own list would pass every test it had and still record
    // consent to something the user never read.
    expect(new Set(MIGRATION_DISCLOSURE_TEXT).size).toBe(17);
  });

  it('states what stays untouched, which is why one approval suffices', () => {
    expect(MIGRATION_UNTOUCHED_STATEMENT).toMatch(/production systems/);
    expect(MIGRATION_UNTOUCHED_STATEMENT).toMatch(/HSM configuration/);
    expect(MIGRATION_UNTOUCHED_STATEMENT).toMatch(/vendor-controlled devices/);
    expect(MIGRATION_UNTOUCHED_STATEMENT).toMatch(/new human gate/i);
  });
});

describe('FR-7 · the scope the button authorises', () => {
  it('separates what the agent will execute from what it will not', () => {
    const a = assessmentOf([
      item('p1', 'AUTONOMOUS_MIGRATION', ['src/Crypto.java']),
      item('p2', 'TEST_ENVIRONMENT_ADAPTATION', ['test/Mock.java']),
      item('p3', 'NO_AUTONOMOUS_CHANGE'),
      item('p4', 'ASSISTED_MIGRATION'),
    ]);
    const scope = scopeOf(a);
    expect(scope.autonomous.map((p) => p.planItemId)).toEqual(['p1', 'p2']);
    expect(scope.excluded.map((p) => p.planItemId)).toEqual(['p3', 'p4']);
    // The declared paths are the same contract verification later holds the
    // migration to, so the user approves something checkable.
    expect(scope.paths).toEqual(['src/Crypto.java', 'test/Mock.java']);
  });

  it('deduplicates paths two plan items both claim', () => {
    const a = assessmentOf([
      item('p1', 'AUTONOMOUS_MIGRATION', ['src/Crypto.java']),
      item('p2', 'AUTONOMOUS_UPDATE', ['src/Crypto.java', 'pom.xml']),
    ]);
    expect(scopeOf(a).paths).toEqual(['pom.xml', 'src/Crypto.java']);
  });

  it('is not approvable when nothing is inside the boundary', () => {
    // A migration run with no work in it is worse than no button: it moves the
    // project to MIGRATING and then has nothing to do.
    expect(scopeOf(assessmentOf([item('p3', 'NO_AUTONOMOUS_CHANGE')])).approvable).toBe(false);
    expect(scopeOf(assessmentOf([])).approvable).toBe(false);
    expect(scopeOf(assessmentOf([item('p1', 'AUTONOMOUS_MIGRATION')])).approvable).toBe(true);
  });

  it('is not approvable once the assessment has been superseded', () => {
    const a = assessmentOf([item('p1', 'AUTONOMOUS_MIGRATION')], { status: 'SUPERSEDED' });
    expect(scopeOf(a).approvable).toBe(false);
  });

  it('agrees with the schema about which modes are autonomous', () => {
    expect(isAutonomous(item('x', 'AUTONOMOUS_GENERATION'))).toBe(true);
    expect(isAutonomous(item('x', 'ASSISTED_MIGRATION'))).toBe(false);
  });
});

describe('FR-4 · the request pins the version', () => {
  it('sends the assessment id, its version and the full disclosure', () => {
    const body = approvalRequest(assessmentOf([item('p1', 'AUTONOMOUS_MIGRATION')]));
    expect(body.assessmentId).toBe('asmt_PQC-0184_v1');
    expect(body.assessmentVersion).toBe(1);
    expect(body.acknowledgedActions).toEqual([...MIGRATION_DISCLOSURE_TEXT]);
  });
});

describe('the bar says what is being agreed to', () => {
  it('counts plan items, autonomous items and recommendations', () => {
    const a = assessmentOf([
      item('p1', 'AUTONOMOUS_MIGRATION'),
      item('p2', 'NO_AUTONOMOUS_CHANGE'),
    ]);
    expect(approvalSubtitle(a, 3)).toBe(
      '2 PLAN ITEMS · 1 AUTONOMOUS · 3 RECOMMENDATIONS RAISED · ONE-TIME HUMAN GATE',
    );
  });
});

describe('a refused approval explains itself', () => {
  it('tells a stale screen to reload rather than showing a bare conflict', () => {
    expect(approvalErrorMessage(409, 'Assessment v1 has been superseded.'))
      .toContain('Reload the assessment');
    expect(approvalErrorMessage(400, 'That is not an option on this gate.'))
      .toBe('That is not an option on this gate.');
  });
});
