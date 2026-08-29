import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Finding } from '@proteus/schema';
import { ScriptedModel } from '../src/agent/model';
import {
  ASSESSMENT_TOOL_NAMES, READ_ONLY_TOOL_NAMES, REPOSITORY_TOOL_NAMES, WRITE_TOOL_NAMES,
  isRepositoryTool,
} from '../src/agent/tools/registry';
import { AssessmentAgent, permittedModes } from '../src/agent/flows/assessment';
import { detect, detectDependencies } from '../src/core/discovery/detect';
import { detectEnvironment } from '../src/core/discovery/environment';
import { detectProfile } from '../src/core/discovery/profile';
import { WorkingCopy } from '../src/core/discovery/workingCopy';
import { loadRegistry } from '../src/core/discovery/providers';
import { RuleEngine } from '../src/core/rules/engine';
import { DiscoveryService } from '../src/core/services/discovery';
import { DispositionService } from '../src/core/services/dispositions';
import { GraphService } from '../src/core/services/graph';
import { AssessmentService, PlanValidationError, validatePlan } from '../src/core/services/assessment';
import { buildPolicy, ensurePolicy } from '../src/core/services/policy';
import { buildSnapshot, renderMarkdown, REQUIRED_SECTIONS } from '../src/reports/assessment';
import { aProject, clearAll, startTestDb, type TestDb } from './helpers/mongo';

/** PRD-09 acceptance criteria, against the fixture the demo migrates. */

const p = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

let db: TestDb;
let engine: RuleEngine;
let graph: GraphService;
let discovery: DiscoveryService;

beforeAll(async () => {
  db = await startTestDb();
  engine = RuleEngine.fromFiles(
    p('../../../engine/rulesets/pqc-migration-rules.yaml'),
    p('../../../engine/rulesets/migration-execution-rules.yaml'),
  );
  loadRegistry(p('../../../engine/data/provider-capability.json'));
  graph = new GraphService(db.repos);
  discovery = new DiscoveryService(db.repos, graph);
}, 120_000);

afterAll(async () => { await db?.stop(); });
beforeEach(async () => { await clearAll(db.repos); });

/** Runs the real discovery pipeline over the fixture and returns the project id. */
async function discoveredProject(): Promise<string> {
  const { projectId } = await db.repos.projects.create(aProject() as never);
  const wc = new WorkingCopy(p('../../../fixtures/payments-api'));
  const profile = await detectProfile(wc);
  const result = await detect(engine, wc, 'abc1234', () => undefined);
  const dependencies = await detectDependencies(wc);
  const environment = await detectEnvironment(wc, 'abc1234');

  const { links } = await discovery.persistCandidates(projectId, result, dependencies);
  await discovery.persistEnvironment(projectId, environment);
  const run = await discovery.start(projectId, 'test-worker');
  await discovery.buildGraph(run, {
    profile, repositoryName: 'payments-api',
    candidates: result.candidates, dependencies, environment, links,
  });
  return projectId;
}

describe('AC-1 · A2 cannot read the repository', () => {
  it('holds no repository tool and no write tool', () => {
    for (const name of ASSESSMENT_TOOL_NAMES) {
      expect(isRepositoryTool(name), `${name} reads the repository`).toBe(false);
      expect(WRITE_TOOL_NAMES as readonly string[]).not.toContain(name);
    }
    // And the repository tools it must not hold really are the ones A1 holds —
    // an empty list would pass the assertion above and prove nothing.
    for (const name of REPOSITORY_TOOL_NAMES) {
      expect(READ_ONLY_TOOL_NAMES as readonly string[]).toContain(name);
      expect(ASSESSMENT_TOOL_NAMES as readonly string[]).not.toContain(name);
    }
  });

  it('never asks the model for a disposition', async () => {
    const model = new ScriptedModel({
      'assessment-narratives': { narratives: [] },
    });
    await new AssessmentAgent(model).narrate([]);
    // narrate([]) short-circuits, so the real assertion is on the schema: a
    // disposition field the model could fill is a disposition it could change.
    const shape = Object.keys(
      (await import('../src/agent/tools/registry')).FindingNarrativeInput.shape,
    );
    expect(shape).not.toContain('disposition');
    expect(shape).toContain('agentIntent');
  });
});

describe('AC-2 · dispositions come from rules, not the model', () => {
  it('assigns every fixture finding a disposition from a citable rule', async () => {
    const projectId = await discoveredProject();
    const pass = await new DispositionService(db.repos, engine).run(projectId);

    expect(pass.decisions.length).toBeGreaterThan(0);
    for (const d of pass.decisions) expect(d.ruleId).toMatch(/^EXEC-DISP-\d{3}$/);

    const findings = await db.repos.findings.find({ projectId } as never) as unknown as Finding[];
    const byDisposition = new Map<string, string[]>();
    for (const f of findings) {
      byDisposition.set(f.disposition, [...(byDisposition.get(f.disposition) ?? []), f.title]);
    }

    // Signature usage is dispositioned out by EXEC-DISP-002, driven by PROHIB-001.
    const signatureDecisions = pass.decisions.filter((d) => d.ruleId === 'EXEC-DISP-002');
    expect(signatureDecisions.length).toBeGreaterThan(0);
    for (const d of signatureDecisions) expect(d.disposition).toBe('NO_CHANGE_REQUIRED');

    // Key transport in source with an approved target is the autonomous path,
    // and EXEC-DISP-009 is the only rule that can produce it.
    // Two routes into the autonomous path, and only two: source key transport
    // with an approved target, and a declared provider that predates it.
    const autonomous = pass.decisions.filter((d) => d.disposition === 'AUTONOMOUS_MIGRATION');
    expect(autonomous.length).toBeGreaterThan(0);
    for (const d of autonomous) {
      expect(['EXEC-DISP-009', 'EXEC-DISP-011']).toContain(d.ruleId);
      // The source route must name the target it will migrate to; the
      // dependency route has a version, not an algorithm.
      if (d.ruleId === 'EXEC-DISP-009') expect(d.target?.parameterSet).toBe('ML-KEM-768');
    }

    // Every finding is dispositioned. A card on Screen 3 with no proposed
    // action is the one outcome spec §18 does not allow.
    expect(pass.undecided).toEqual([]);
    expect(pass.decisions.length).toBe(findings.length);
  }, 60_000);

  it('leaves an undetermined usage out of the autonomous path', async () => {
    const projectId = await discoveredProject();
    const pass = await new DispositionService(db.repos, engine).run(projectId);
    const findings = await db.repos.findings.find({ projectId } as never) as unknown as Finding[];

    // EXEC-DET-004 finds `KeyPairGenerator.getInstance("RSA")` with no usage. It
    // is quantum-vulnerable and in source, and it still must not be autonomous:
    // `usageStrength: STRONG` in EXEC-DISP-009 is what keeps it out.
    const undetermined = findings.filter((f) => f.crypto?.usage === 'UNKNOWN');
    expect(undetermined.length).toBeGreaterThan(0);
    for (const f of undetermined) {
      const d = pass.decisions.find((x) => x.findingId === f.findingId);
      expect(d?.disposition).not.toBe('AUTONOMOUS_MIGRATION');
    }
  }, 60_000);
});

describe('Risk 1 · a plan item the dispositions forbid is rejected, not corrected', () => {
  const pass = {
    decisions: [
      { findingId: 'f1', disposition: 'AUTONOMOUS_MIGRATION' as const, ruleId: 'EXEC-DISP-009' },
      { findingId: 'f4', disposition: 'NO_CHANGE_REQUIRED' as const, ruleId: 'EXEC-DISP-002' },
      { findingId: 'f5', disposition: 'HARDWARE_REPLACEMENT' as const, ruleId: 'EXEC-DISP-003' },
    ],
    seeds: [], undecided: [],
  };
  const item = (over: Record<string, unknown>) => ({
    targetName: 'CryptoService', findingIds: ['f1'], mode: 'AUTONOMOUS_MIGRATION' as const,
    action: 'a', rationale: 'r', risk: 'LOW' as const, conditions: [],
    expectedChanges: [{ changeType: 'SOURCE' as const, paths: ['src/**'], description: 'd' }],
    ...over,
  });

  it('accepts an item whose mode its disposition permits', () => {
    expect(validatePlan([item({})], pass)).toEqual([]);
  });

  it('rejects migrating a signature finding (FR-3)', () => {
    const violations = validatePlan([item({ findingIds: ['f4'] })], pass);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('NO_CHANGE_REQUIRED');
    expect(violations[0]).toContain('EXEC-DISP-002');
  });

  it('rejects acting on a hardware replacement', () => {
    expect(validatePlan([item({ findingIds: ['f5'] })], pass)).toHaveLength(1);
  });

  it('rejects an item citing a finding that does not exist', () => {
    expect(validatePlan([item({ findingIds: ['f99'] })], pass)[0]).toContain('unknown finding');
  });

  it('rejects an autonomous item that declares no expected changes (FR-6)', () => {
    const violations = validatePlan([item({ expectedChanges: [] })], pass);
    expect(violations[0]).toContain('declares no expected changes');
  });

  it('reports every violation rather than the first', () => {
    expect(validatePlan([item({ findingIds: ['f4', 'f5'], expectedChanges: [] })], pass))
      .toHaveLength(3);
  });

  it('permits nothing but NO_AUTONOMOUS_CHANGE outside the boundary', () => {
    for (const d of ['NO_CHANGE_REQUIRED', 'VENDOR_DEPENDENCY', 'HARDWARE_REPLACEMENT',
      'HUMAN_DECISION_REQUIRED', 'NEEDS_FURTHER_INVESTIGATION'] as const) {
      expect(permittedModes(d)).toEqual(['NO_AUTONOMOUS_CHANGE']);
    }
  });
});

describe('AC-5 · assessments are immutable and versioned', () => {
  it('regenerating produces version 2 and leaves version 1 unchanged', async () => {
    const projectId = await discoveredProject();
    const service = new AssessmentService(db.repos);
    const pass = await new DispositionService(db.repos, engine).run(projectId);

    const summary = {
      headline: 'h', whatExists: 'e', whatIsVulnerable: 'v',
      whatAgentWillChange: 'c', whatAgentWillNotChange: 'n',
    };
    const autonomous = pass.decisions.filter((d) => d.disposition === 'AUTONOMOUS_MIGRATION');
    const planItems = [{
      targetName: 'CryptoService', findingIds: autonomous.map((d) => d.findingId),
      mode: 'AUTONOMOUS_MIGRATION' as const, action: 'a', rationale: 'r',
      expectedChanges: [{ changeType: 'SOURCE' as const, paths: ['src/main/**'], description: 'd' }],
      conditions: [], risk: 'MEDIUM' as const,
    }];

    const input = {
      projectId, commitSha: 'abc1234def5678', policyId: 'policy_mlkem_v1',
      pass, summary, narratives: [], planItems, recommendationActions: [],
    };

    // Mongo's `_id` is storage, not content; everything else must be identical.
    const strip = (a: unknown) => {
      const rest = { ...(a as Record<string, unknown>) };
      delete rest['_id'];
      return JSON.stringify(rest);
    };

    const v1 = await service.generate(input);
    expect(v1.version).toBe(1);
    const frozen = strip(v1);

    const v2 = await service.generate(input);
    expect(v2.version).toBe(2);
    expect(v2.status).toBe('READY');

    const reread = await service.version(projectId, 1);
    // Byte-identical apart from the status flip that marks it superseded — the
    // scope a human approved cannot be edited after the fact.
    expect(reread!.status).toBe('SUPERSEDED');
    expect(strip({ ...reread, status: 'READY', updatedAt: v1.updatedAt })).toBe(frozen);
    expect(reread!.planItems).toEqual(v1.planItems);
    expect(reread!.snapshot).toEqual(v1.snapshot);

    expect((await service.current(projectId))!.version).toBe(2);
    expect((await service.history(projectId)).map((a) => a.version)).toEqual([1, 2]);
  }, 60_000);

  it('refuses to write an assessment whose plan the dispositions forbid', async () => {
    const projectId = await discoveredProject();
    const service = new AssessmentService(db.repos);
    const pass = await new DispositionService(db.repos, engine).run(projectId);
    const signature = pass.decisions.find((d) => d.ruleId === 'EXEC-DISP-002')!;

    await expect(service.generate({
      projectId, commitSha: 'abc1234def5678', policyId: 'p',
      pass,
      summary: {
        headline: 'h', whatExists: 'e', whatIsVulnerable: 'v',
        whatAgentWillChange: 'c', whatAgentWillNotChange: 'n',
      },
      narratives: [], recommendationActions: [],
      planItems: [{
        targetName: 'SettlementSigner', findingIds: [signature.findingId],
        mode: 'AUTONOMOUS_MIGRATION', action: 'a', rationale: 'r',
        expectedChanges: [{ changeType: 'SOURCE', paths: ['**'], description: 'd' }],
        conditions: [], risk: 'HIGH',
      }],
    })).rejects.toThrow(PlanValidationError);

    // And nothing was written — a rejected plan must not leave a partial one.
    expect(await service.current(projectId)).toBeNull();
  }, 60_000);
});

describe('AC-4 and AC-8 · recommendations and the report', () => {
  it('raises a recommendation per rule-decided item, each with an owner', async () => {
    const projectId = await discoveredProject();
    const service = new AssessmentService(db.repos);
    const pass = await new DispositionService(db.repos, engine).run(projectId);

    await service.generate({
      projectId, commitSha: 'abc1234def5678', policyId: 'p', pass,
      summary: {
        headline: 'h', whatExists: 'e', whatIsVulnerable: 'v',
        whatAgentWillChange: 'c', whatAgentWillNotChange: 'n',
      },
      narratives: [], planItems: [],
      recommendationActions: pass.seeds.map((s) => ({
        findingId: s.findingId, action: `Contact ${s.owner}.`,
      })),
    });

    const recommendations = await db.repos.recommendations.find({ projectId } as never);
    expect(recommendations.length).toBe(pass.seeds.length);
    for (const r of recommendations) {
      expect(r.owner).not.toBe('');
      expect(r.owner).not.toBe('Unassigned');
      expect(r.action).not.toBe('');
      expect(r.sourceCitation).not.toBe('');
      expect(r.findingIds.length).toBeGreaterThan(0);
    }
  }, 60_000);

  it('renders every section spec §19 requires', async () => {
    const projectId = await discoveredProject();
    const service = new AssessmentService(db.repos);
    const pass = await new DispositionService(db.repos, engine).run(projectId);

    const assessment = await service.generate({
      projectId, commitSha: 'abc1234def5678', policyId: 'p', pass,
      summary: {
        headline: 'Seven findings, two migratable.',
        whatExists: 'A Java payments service.',
        whatIsVulnerable: 'RSA key transport.',
        whatAgentWillChange: 'CryptoService and the provider version.',
        whatAgentWillNotChange: 'Signature usage and the certificate.',
      },
      narratives: [], planItems: [], recommendationActions: [],
    });

    const project = (await db.repos.projects.byId(projectId))!;
    const snapshot = buildSnapshot({
      project, assessment,
      findings: await db.repos.findings.find({ projectId } as never) as unknown as Finding[],
      evidence: await db.repos.evidence.find({ projectId } as never) as never,
      nodes: await db.repos.graphNodes.find({ projectId } as never) as never,
      edges: await db.repos.graphEdges.find({ projectId } as never) as never,
      recommendations: await db.repos.recommendations.find({ projectId } as never),
      files: [],
    });
    const markdown = renderMarkdown(snapshot);

    for (const section of REQUIRED_SECTIONS) {
      expect(markdown, `missing §19 section: ${section}`).toContain(`# ${section}`);
    }
    expect(markdown).toContain('abc1234def5678');
    expect(markdown).toContain(project.repository.url);
    // §16: every finding keeps its source.
    expect(markdown).toContain('CryptoService.java');

    // Reproducible: the same snapshot renders the same bytes.
    expect(renderMarkdown(snapshot)).toBe(markdown);
  }, 60_000);
});

describe('the migration policy is derived from the rules, not written by hand', () => {
  it('targets ML-KEM-768 for key transport and cites the rules that decided', () => {
    const policy = buildPolicy(engine, 'policy_test');
    const rsaTransport = policy.rules.find((r) => r.when.usage === 'KEY_TRANSPORT'
      && r.when.algorithmPattern === '^RSA');

    expect(rsaTransport).toBeDefined();
    expect(rsaTransport!.target).toBe('ML-KEM-768');
    expect(rsaTransport!.rationale).toMatch(/FIPS203|IR8547/);
    // Absence alone is not success: a migration that deletes the RSA call and
    // adds nothing would otherwise verify clean.
    expect(rsaTransport!.requiredPatterns.length).toBeGreaterThan(0);
    expect(rsaTransport!.prohibitedPatterns.some((p) => p.includes('getInstance'))).toBe(true);
  });

  it('matches the fixture before migration and would not after', () => {
    const policy = buildPolicy(engine, 'policy_test');
    const rule = policy.rules.find((r) => r.when.usage === 'KEY_TRANSPORT'
      && r.when.algorithmPattern === '^RSA')!;
    const before = 'Cipher c = Cipher.getInstance("RSA/ECB/OAEPWithSHA-256AndMGF1Padding");';
    const after = 'KEM kem = KEM.getInstance("ML-KEM-768");';

    expect(rule.prohibitedPatterns.some((p) => new RegExp(p).test(before))).toBe(true);
    expect(rule.prohibitedPatterns.some((p) => new RegExp(p).test(after))).toBe(false);
    expect(rule.requiredPatterns.some((p) => new RegExp(p).test(after))).toBe(true);
  });

  it('seeds once and is idempotent', async () => {
    expect(await ensurePolicy(db.repos, engine)).toBe('policy_mlkem_v1');
    expect(await ensurePolicy(db.repos, engine)).toBe('policy_mlkem_v1');
    expect(await db.repos.migrationPolicies.count({} as never)).toBe(1);
  });
});
