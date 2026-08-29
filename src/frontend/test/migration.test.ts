import { describe, expect, it } from 'vitest';
import { MigrationStage, type Baseline, type BehavioralInvariant, type MigrationRun } from '@proteus/schema';
import {
  MIGRATION_STAGES, STAGE_LABEL, branchMeta, checklist, rail, shortSha, summarise,
} from '../src/lib/migration';

/** PRD-11 — what the migration screen claims about progress and the contract. */

const invariant = (over: Partial<BehavioralInvariant> = {}): BehavioralInvariant => ({
  invariantId: 'inv_1', kind: 'API_BEHAVIOR',
  description: 'POST /settlements accepts a valid advice',
  assertion: 'assertEquals(201, response.getStatusCode());',
  capturedFrom: 'EXISTING_TEST', disposition: 'MUST_PRESERVE', evidenceIds: [],
  ...over,
});

const baselineOf = (over: Partial<Baseline> = {}): Baseline => ({
  _schemaVersion: 1, createdAt: new Date(), updatedAt: new Date(),
  baselineId: 'base_1', projectId: 'PQC-0184', migrationRunId: 'mig_1',
  commitSha: '7c41ab9d2f1e4c8b6a5d3e2f1a0b9c8d7e6f5a4b',
  build: { executionRunId: 'exec_1', passed: true, durationMs: 41000 },
  tests: {
    executionRunId: 'exec_2', total: 36, passed: 36, failed: 0, skipped: 0,
    knownFailures: [], inventory: [],
  },
  invariants: [], capturedAt: new Date(),
  ...over,
});

describe('AC-8 · the stage rail is a claim about progress', () => {
  it('covers every stage spec §22 defines, in order', () => {
    expect(MIGRATION_STAGES).toEqual(MigrationStage.options);
    for (const s of MIGRATION_STAGES) expect(STAGE_LABEL[s]).toBeTruthy();
    expect(rail('PREPARING_MIGRATION')).toHaveLength(18);
  });

  it('marks everything behind the current stage done and everything ahead pending', () => {
    const steps = rail('CAPTURING_BASELINE');
    const at = MIGRATION_STAGES.indexOf('CAPTURING_BASELINE');
    expect(steps[at]!.state).toBe('ACTIVE');
    expect(steps[at - 1]!.state).toBe('DONE');
    expect(steps[at + 1]!.state).toBe('PENDING');
    // Exactly one stage is ever live, or the rail is telling two stories.
    expect(steps.filter((s) => s.state === 'ACTIVE')).toHaveLength(1);
  });

  it('shows nothing as done before a run has a stage', () => {
    expect(rail(undefined).every((s) => s.state === 'PENDING')).toBe(true);
  });
});

describe('the branch panel', () => {
  it('renders the base commit short and the commit count singular', () => {
    const run = {
      branch: {
        name: 'agent/pqc/PQC-0184',
        baseCommitSha: '7c41ab9d2f1e4c8b6a5d3e2f1a0b9c8d7e6f5a4b',
        pushed: false, commitCount: 1,
      },
    } as MigrationRun;
    expect(branchMeta(run)).toBe('BASE 7c41ab9 · 1 COMMIT');
    expect(branchMeta({ ...run, branch: { ...run.branch, commitCount: 6 } } as MigrationRun))
      .toBe('BASE 7c41ab9 · 6 COMMITS');
    expect(shortSha(undefined)).toBe('');
  });
});

describe('AC-3, AC-8 · the baseline contract as the reader sees it', () => {
  it('puts what must be preserved before what will change', () => {
    const items = checklist(baselineOf({
      invariants: [
        invariant({ invariantId: 'i1', kind: 'MESSAGE_FORMAT', disposition: 'EXPECTED_TO_CHANGE',
          description: 'The wrapped key is 256 bytes', assertion: 'assertEquals(256, w.length);' }),
        invariant({ invariantId: 'i2', kind: 'FAILURE_MODE',
          description: 'A malformed advice is rejected', assertion: 'assertEquals(400, r.code());' }),
      ],
    }));
    // A reader needs to know what is protected before what is changing.
    expect(items.map((i) => i.disposition)).toEqual(['MUST_PRESERVE', 'EXPECTED_TO_CHANGE']);
    // The executable assertion is shown verbatim — an invariant the reader
    // cannot see is one they cannot check.
    expect(items[1]!.detail).toBe('assertEquals(256, w.length);');
    expect(items[1]!.kind).toBe('MESSAGE FORMAT');
  });

  it('names pre-existing failures rather than counting them away', () => {
    const s = summarise(baselineOf({
      tests: {
        executionRunId: 'e', total: 36, passed: 35, failed: 1, skipped: 0,
        knownFailures: [{ testId: 'pay.A#b', name: 'b', message: 'was already red' }],
        inventory: [],
      },
    }))!;
    expect(s.headline).toContain('35/36 tests passing at 7c41ab9');
    expect(s.headline).toContain('1 pre-existing failure recorded as known');
    expect(s.known).toBe(1);
  });

  it('says plainly when the base commit does not build', () => {
    const s = summarise(baselineOf({
      build: { executionRunId: 'e', passed: false, durationMs: 900 },
    }))!;
    // Risk 4 — recorded and reported, not hidden behind a green checklist.
    expect(s.buildPassed).toBe(false);
    expect(s.headline).toMatch(/does not build/);
  });

  it('is empty, not invented, before a baseline exists', () => {
    expect(checklist(null)).toEqual([]);
    expect(summarise(null)).toBeNull();
  });
});
