import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Evidence } from '@proteus/schema';
import { DiscoveryAgent, usageEvent } from '../src/agent/flows/discovery';
import { ModelOutputError, ScriptedModel } from '../src/agent/model';
import { READ_ONLY_TOOL_NAMES, WRITE_TOOL_NAMES, isWriteTool } from '../src/agent/tools/registry';
import { detect } from '../src/core/discovery/detect';
import { loadRegistry } from '../src/core/discovery/providers';
import { WorkingCopy } from '../src/core/discovery/workingCopy';
import { RuleEngine } from '../src/core/rules/engine';
import { DiscoveryService, stageProgress } from '../src/core/services/discovery';
import { aProject, clearAll, startTestDb, type TestDb } from './helpers/mongo';

/** PRD-07 acceptance criteria. */

const p = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
let t: TestDb;
let engine: RuleEngine;
let wc: WorkingCopy;

beforeAll(async () => {
  t = await startTestDb();
  engine = RuleEngine.fromFiles(
    p('../../../engine/rulesets/pqc-migration-rules.yaml'),
    p('../../../engine/rulesets/migration-execution-rules.yaml'),
  );
  loadRegistry(p('../../../engine/data/provider-capability.json'));
  wc = new WorkingCopy(p('../../../fixtures/payments-api'));
});
afterAll(async () => { await t?.stop(); });
beforeEach(async () => { await clearAll(t.repos); });

describe('AC-1 · A1 holds no write tool', () => {
  it('has none of the write tools in its table', () => {
    for (const name of READ_ONLY_TOOL_NAMES) {
      expect(isWriteTool(name), `${name} must not be a write tool`).toBe(false);
    }
    const overlap = READ_ONLY_TOOL_NAMES.filter((n) =>
      (WRITE_TOOL_NAMES as readonly string[]).includes(n));
    expect(overlap, 'A1 must not be able to change anything').toEqual([]);
  });

  it('cannot branch, patch, build or deploy', () => {
    for (const forbidden of ['create_branch', 'apply_patch', 'run_cloud_build', 'deploy_sandbox']) {
      expect((READ_ONLY_TOOL_NAMES as readonly string[]).includes(forbidden)).toBe(false);
      expect(isWriteTool(forbidden)).toBe(true);
    }
  });
});

describe('AC-2 · deterministic detection runs before the agent', () => {
  it('the agent is asked only about signals the scanner could not resolve', async () => {
    const { candidates } = await detect(engine, wc, 'abc1234', () => undefined);

    const strong = candidates.filter((c) => c.strength === 'STRONG' && c.usage !== 'UNKNOWN');
    expect(strong.length).toBeGreaterThan(0);

    // Every strong match is left alone — re-asking a model to confirm a
    // deterministic result is how a reproducible finding becomes a variable one.
    const answers: Record<string, unknown> = {};
    for (const c of candidates.filter((x) => x.strength === 'WEAK' || x.usage === 'UNKNOWN')) {
      answers[`resolve-usage:${c.path}:${c.line}`] = {
        candidateId: `${c.path}:${c.line}`, usage: 'KEY_TRANSPORT',
        reasoning: 'wraps a session key for the acquirer', confidence: 0.8,
      };
    }
    const decided = await new DiscoveryAgent(new ScriptedModel(answers))
      .resolveUsages(candidates, () => 'code');

    expect(decided.every((d) => d.candidate.strength === 'WEAK' || d.candidate.usage === 'UNKNOWN'))
      .toBe(true);
    expect(decided.map((d) => d.candidate.path))
      .not.toContain('src/main/java/pay/security/CryptoService.java');
  });
});

describe('AC-3 · the model can never claim to have observed anything', () => {
  it('marks every usage decision INFERRED below full confidence', async () => {
    const agent = new DiscoveryAgent(new ScriptedModel({
      'resolve-usage:x.java:1': {
        candidateId: 'x', usage: 'KEY_TRANSPORT',
        reasoning: 'wraps a SecretKey', confidence: 1.0,
      },
    }));
    const [d] = await agent.resolveUsages(
      [{ path: 'x.java', line: 1, strength: 'WEAK', usage: 'UNKNOWN' } as never],
      () => 'code',
    );
    expect(d!.evidence.evidenceClass).toBe('INFERRED');
    // Even when the model claims 1.0, it is capped — INFERRED cannot be certain.
    expect(d!.evidence.confidence).toBeLessThan(1);
  });

  it('the schema refuses OBSERVED evidence attributed to a model', () => {
    const r = Evidence.safeParse({
      createdAt: new Date(), updatedAt: new Date(), observedAt: new Date(),
      evidenceId: 'ev1', projectId: 'PQC-0001',
      evidenceType: 'MODEL_REASONING', evidenceClass: 'OBSERVED', confidence: 1,
      source: 'x.java:1',
      locator: { kind: 'REPO', path: 'x.java', commitSha: 'abc1234' },
      producedBy: { actor: 'MODEL' },
    });
    expect(r.success).toBe(false);
  });

  it('rejects a scripted answer that does not satisfy its schema', async () => {
    const agent = new DiscoveryAgent(new ScriptedModel({
      'resolve-usage:x.java:1': { usage: 'NOT_A_USAGE' },
    }));
    await expect(
      agent.resolveUsages([{ path: 'x.java', line: 1, strength: 'WEAK', usage: 'UNKNOWN' } as never], () => 'c'),
    ).rejects.toThrow(ModelOutputError);
  });
});

describe('AC-4 · UNKNOWN is a permitted answer', () => {
  it('records an undetermined usage rather than forcing a guess', async () => {
    const agent = new DiscoveryAgent(new ScriptedModel({
      'resolve-usage:x.java:1': {
        candidateId: 'x', usage: 'UNKNOWN',
        reasoning: 'the code does not say what the ciphertext carries', confidence: 0.3,
      },
    }));
    const [d] = await agent.resolveUsages(
      [{ path: 'x.java', line: 1, strength: 'WEAK', usage: 'UNKNOWN' } as never], () => 'c',
    );
    expect(d!.usage).toBe('UNKNOWN');
    // An undetermined usage belongs in the audit drawer, not the live feed.
    expect(usageEvent(d!).level).toBe('DETAIL');
    expect(usageEvent(d!).severity).toBe('WARN');
  });

  it('a resolved usage does reach the live feed', async () => {
    const agent = new DiscoveryAgent(new ScriptedModel({
      'resolve-usage:x.java:1': {
        candidateId: 'x', usage: 'KEY_TRANSPORT', reasoning: 'wraps a SecretKey', confidence: 0.9,
      },
    }));
    const [d] = await agent.resolveUsages(
      [{ path: 'x.java', line: 1, strength: 'WEAK', usage: 'UNKNOWN' } as never], () => 'c',
    );
    expect(usageEvent(d!).level).toBe('ACTIVITY');
  });
});

describe('AC-5 · correlation is inferred, and cites its document', () => {
  it('produces INFERRED document evidence with a page', async () => {
    const agent = new DiscoveryAgent(new ScriptedModel({
      'correlate:file-1': {
        claim: 'Settlement signing keys are held in the HSM',
        documentPage: 17, relatedFindingIds: ['f1'], confidence: 0.9,
        reasoning: 'Section 4 states the signing key never leaves the module',
      },
    }));
    const [c] = await agent.correlate(
      [{ fileId: 'file-1', name: 'Security Architecture.pdf', text: '…' }],
      [{ findingId: 'f1', title: 'RSA signature', summaryLine: 'signing' }],
    );
    expect(c!.evidence.evidenceClass).toBe('INFERRED');
    expect(c!.evidence.source).toBe('Security Architecture.pdf, page 17');
    expect((c!.evidence.locator as { kind: string }).kind).toBe('DOCUMENT');
  });

  it('cannot claim certainty — the schema caps correlation confidence', async () => {
    const agent = new DiscoveryAgent(new ScriptedModel({
      'correlate:file-1': {
        claim: 'x', confidence: 1.0, reasoning: 'y', relatedFindingIds: [],
      },
    }));
    await expect(
      agent.correlate([{ fileId: 'file-1', name: 'd.pdf', text: 'x' }],
        [{ findingId: 'f1', title: 't', summaryLine: 's' }]),
    ).rejects.toThrow(ModelOutputError);
  });
});

describe('AC-6 · progress and checkpoints', () => {
  it('reports percent from position in the pipeline', () => {
    expect(stageProgress('QUEUED')).toBe(0);
    expect(stageProgress('SCANNING_CRYPTO')).toBe(33);
    expect(stageProgress('COMPLETED')).toBe(100);
  });

  it('writes a checkpoint an evicted worker can resume from', async () => {
    const svc = new DiscoveryService(t.repos);
    const project = await t.repos.projects.create(aProject() as never);
    const run = await svc.start(project.projectId, 'worker-a');

    await svc.advance(run, 'SCANNING_CRYPTO', 'Scanning source for cryptography');
    expect(await svc.resumePoint(project.projectId)).toBe('SCANNING_CRYPTO');

    await svc.reportProgress(run, 12, 37);
    const stored = await t.repos.discoveryRuns.findOne({ discoveryRunId: run.discoveryRunId } as never);
    expect(stored!.progress.filesAnalyzed).toBe(12);
    expect(stored!.progress.filesTotal).toBe(37);
  });
});

describe('AC-7 · one worker per run', () => {
  it('refuses a second worker while the first holds the lease', async () => {
    const svc = new DiscoveryService(t.repos);
    const project = await t.repos.projects.create(aProject() as never);
    const run = await svc.start(project.projectId, 'worker-a');

    expect(await t.repos.discoveryLease.acquire(run.discoveryRunId, 'worker-b')).toBe(false);
    expect(await t.repos.discoveryLease.currentHolder(run.discoveryRunId)).toBe('worker-a');
  });
});

describe('AC-8 · findings persist, and re-running does not duplicate', () => {
  it('writes findings and evidence from the fixture scan', async () => {
    const svc = new DiscoveryService(t.repos);
    const project = await t.repos.projects.create(aProject() as never);
    const result = await detect(engine, wc, 'abc1234', () => undefined);

    const first = await svc.persistCandidates(project.projectId, result, []);
    expect(first.findings).toBeGreaterThan(0);

    const stored = await t.repos.findings.find({ projectId: project.projectId } as never);
    expect(stored.every((f) => f.evidenceIds.length > 0)).toBe(true);
    expect(stored.every((f) => f.origin === 'REPOSITORY_SCAN')).toBe(true);

    // A second pass enriches rather than duplicates.
    const second = await svc.persistCandidates(project.projectId, result, []);
    expect(second.findings).toBe(0);
    expect(await t.repos.findings.count({ projectId: project.projectId } as never))
      .toBe(stored.length);
  });

  it('scan evidence is OBSERVED and attributed to the tool', async () => {
    const svc = new DiscoveryService(t.repos);
    const project = await t.repos.projects.create(aProject() as never);
    const result = await detect(engine, wc, 'abc1234', () => undefined);
    await svc.persistCandidates(project.projectId, result, []);

    const evidence = await t.repos.evidence.find({ projectId: project.projectId } as never);
    expect(evidence.length).toBeGreaterThan(0);
    for (const e of evidence) {
      expect(e.evidenceClass).toBe('OBSERVED');
      expect(e.producedBy.actor).toBe('TOOL');
      expect(e.confidence).toBe(1);
    }
  });
});

describe('AC-9 · completion hands over to assessment', () => {
  it('moves the project to ASSESSMENT_READY and emits a milestone', async () => {
    const svc = new DiscoveryService(t.repos);
    const project = await t.repos.projects.create(aProject() as never);
    const run = await svc.start(project.projectId, 'worker-a');

    await svc.complete(run, 'Seven findings, two external items.');

    const after = await t.repos.projects.byId(project.projectId);
    expect(after!.stage).toBe('ASSESSMENT_READY');
    expect(after!.summary.discoveryComplete).toBe(true);

    const events = await t.repos.events.since(project.projectId, 0);
    const done = events.find((e) => e.type === 'ASSESSMENT_COMPLETED');
    expect(done).toBeDefined();
    expect(done!.level).toBe('MILESTONE');
  });
});
