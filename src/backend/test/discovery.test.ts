import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { RuleEngine } from '../src/core/rules/engine';
import { detect, detectDependencies, detectionRules } from '../src/core/discovery/detect';
import { detectProfile } from '../src/core/discovery/profile';
import { WorkingCopy, classify } from '../src/core/discovery/workingCopy';
import { capabilityOf, loadRegistry, versionLt } from '../src/core/discovery/providers';
import { parseRepositoryUrl, permalink } from '../src/integrations/github/client';

/**
 * PRD-06 acceptance criteria, run against the actual fixture.
 *
 * Not a synthetic tree: these assertions are about `fixtures/payments-api`, the
 * repository the demo migrates. If detection stops finding what is really there,
 * that is the failure worth hearing about.
 */

const p = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const FIXTURE = p('../../../fixtures/payments-api');
const COMMIT = '7c41ab9deadbeef0000000000000000000000000';

let engine: RuleEngine;
let wc: WorkingCopy;

beforeAll(() => {
  engine = RuleEngine.fromFiles(
    p('../../../engine/rulesets/pqc-migration-rules.yaml'),
    p('../../../engine/rulesets/migration-execution-rules.yaml'),
  );
  loadRegistry(p('../../../engine/data/provider-capability.json'));
  wc = new WorkingCopy(FIXTURE);
});

const link = (path: string, line: number) =>
  permalink({ owner: 'northwind-pay', repo: 'payments-api' }, COMMIT, path, line);

describe('AC-4 · repository profile', () => {
  it('reads Java, Maven and Spring Boot from the manifest', async () => {
    const profile = await detectProfile(wc);
    expect(profile.language).toBe('Java');
    expect(profile.buildSystem).toBe('Maven');
    expect(profile.languageVersion).toBe('17');
    expect(profile.framework).toMatch(/^Spring Boot 3\.2/);
    expect(profile.testFrameworks).toContain('surefire');
    expect(profile.testFrameworks).toContain('failsafe');
    expect(profile.fileCount).toBeGreaterThan(20);
  });
});

describe('file classification', () => {
  it('classifies a test before a source file, since both are .java', () => {
    // EXEC-DIAG-004 turns on this distinction: a legacy assertion in test code
    // is a mock incompatibility, the same assertion in production code is not.
    expect(classify('src/test/java/pay/PartnerHandshakeMock.java')).toBe('TEST');
    expect(classify('src/main/java/pay/security/CryptoService.java')).toBe('SOURCE');
    expect(classify('pom.xml')).toBe('MANIFEST');
    expect(classify('src/main/resources/application.yml')).toBe('CONFIG');
    expect(classify('deploy/tls/pay-api.crt.md')).toBe('CERTIFICATE');
  });
});

describe('AC-1 · finds the migration target', () => {
  it('locates the RSA wrap in CryptoService as STRONG key transport', async () => {
    const { candidates } = await detect(engine, wc, COMMIT, link);
    const hit = candidates.find(
      (c) => c.path.endsWith('security/CryptoService.java') && c.usage === 'KEY_TRANSPORT',
    );
    expect(hit, 'CryptoService key transport not found').toBeDefined();
    expect(hit!.strength).toBe('STRONG');
    expect(hit!.ruleId).toBe('EXEC-DET-001');
    expect(hit!.quantumVulnerable).toBe(true);
  });

  it('finds the second key transport site in CryptoUtils', async () => {
    // The migration is two files, not one — the export path duplicates the
    // transform because it runs outside the Spring context.
    const { candidates } = await detect(engine, wc, COMMIT, link);
    const sites = candidates
      .filter((c) => c.usage === 'KEY_TRANSPORT' && c.strength === 'STRONG')
      .map((c) => c.path);
    expect(new Set(sites)).toContain('src/main/java/pay/util/CryptoUtils.java');
    expect(new Set(sites).size).toBeGreaterThanOrEqual(2);
  });
});

describe('AC-2 · a weak signal never assigns a usage', () => {
  it('does not treat a commented-out cipher as a usage', async () => {
    const { candidates } = await detect(engine, wc, COMMIT, link);
    // CryptoUtils carries a commented-out PKCS1Padding variant.
    const commented = candidates.filter((c) => c.matchedText.startsWith('//'));
    expect(commented).toHaveLength(0);
  });

  it('marks anything it is unsure of for investigation rather than guessing', async () => {
    const { candidates } = await detect(engine, wc, COMMIT, link);
    for (const c of candidates.filter((x) => x.strength === 'WEAK')) {
      expect(c.usage).toBe('UNKNOWN');
      expect(c.requiresInvestigation).toBe(true);
    }
  });
});

describe('AC-3 · finds the signature usages it must not migrate', () => {
  it('locates SettlementSigner and classifies it as a signature', async () => {
    const { candidates } = await detect(engine, wc, COMMIT, link);
    const sigs = candidates.filter((c) => c.usage === 'DIGITAL_SIGNATURE');
    expect(sigs.length).toBeGreaterThanOrEqual(1);
    expect(sigs.some((c) => c.path.endsWith('SettlementSigner.java'))).toBe(true);
  });

  it('and the rules refuse to migrate them', async () => {
    const { candidates } = await detect(engine, wc, COMMIT, link);
    const sig = candidates.find((c) => c.usage === 'DIGITAL_SIGNATURE')!;
    const prohibited = engine.prohibitedActions({
      algorithm: sig.algorithm ?? 'RSA', usage: 'DIGITAL_SIGNATURE',
    });
    expect(prohibited.has('REPLACE_ALGORITHM')).toBe(true);
  });
});

describe('AC-4b · dependency capability comes from the registry', () => {
  it('finds bcprov 1.72 and reports it cannot do ML-KEM', async () => {
    const deps = await detectDependencies(wc);
    const bc = deps.find((d) => d.dependencyName.startsWith('bcprov'));
    expect(bc, 'bcprov not found in pom.xml').toBeDefined();
    expect(bc!.version).toBe('1.72');
    expect(bc!.capability.capability).toBe('NOT_SUPPORTED');
    expect(bc!.capability.reason).toContain('1.78');
  });

  it('reports UNKNOWN for a provider it has never heard of, rather than guessing', () => {
    const answer = capabilityOf('mystery-crypto-lib', '3.1.4', 'ML-KEM');
    expect(answer.capability).toBe('UNKNOWN');
    expect(answer.reason).toContain('not in the provider capability registry');
  });

  it('compares versions numerically, not lexically', () => {
    // "1.72" < "1.8" is false as strings and true as versions.
    expect(versionLt('1.72', '1.78')).toBe(true);
    expect(versionLt('1.9', '1.78')).toBe(true);
    expect(versionLt('1.78', '1.78')).toBe(false);
    expect(versionLt('2.0', '1.78')).toBe(false);
  });
});

describe('AC-6 · every candidate carries usable evidence', () => {
  it('cites a path, a line, a commit and a clickable permalink', async () => {
    const { candidates } = await detect(engine, wc, COMMIT, link);
    expect(candidates.length).toBeGreaterThan(0);
    for (const c of candidates) {
      expect(c.evidence.source).toBe(`${c.path}:${c.line}`);
      const loc = c.evidence.locator as { kind: string; commitSha: string; permalink?: string };
      expect(loc.kind).toBe('REPO');
      expect(loc.commitSha).toBe(COMMIT);
      expect(loc.permalink).toContain(`/blob/${COMMIT}/${c.path}#L${c.line}`);
      // The finding card expands to a numbered excerpt.
      expect(c.evidence.excerpt).toMatch(/^\s*\d+\s{2}/);
    }
  });

  it('records tool evidence as OBSERVED at full confidence, never INFERRED', async () => {
    const { candidates } = await detect(engine, wc, COMMIT, link);
    for (const c of candidates) {
      expect(c.evidence.evidenceClass).toBe('OBSERVED');
      expect(c.evidence.confidence).toBe(1);
    }
  });
});

describe('AC-5 · re-running is idempotent', () => {
  it('produces identical dedupe keys on a second pass', async () => {
    const a = await detect(engine, wc, COMMIT, link);
    const b = await detect(engine, wc, COMMIT, link);
    expect(a.candidates.map((c) => c.dedupeKey)).toEqual(b.candidates.map((c) => c.dedupeKey));
    expect(a.candidates).toHaveLength(b.candidates.length);
  });

  it('gives distinct keys to two sites of the same usage', async () => {
    const { candidates } = await detect(engine, wc, COMMIT, link);
    const transport = candidates.filter((c) => c.usage === 'KEY_TRANSPORT');
    expect(new Set(transport.map((c) => c.dedupeKey)).size).toBe(transport.length);
  });
});

describe('rule wiring', () => {
  it('loads the detection family from the ruleset rather than hardcoding patterns', () => {
    const rules = detectionRules(engine);
    expect(rules.length).toBeGreaterThanOrEqual(3);
    expect(rules.map((r) => r.ruleId)).toContain('EXEC-DET-001');
  });

  it('parses a GitHub URL and builds a line permalink', () => {
    expect(parseRepositoryUrl('https://github.com/northwind-pay/payments-api'))
      .toEqual({ owner: 'northwind-pay', repo: 'payments-api' });
    expect(link('src/main/java/pay/security/CryptoService.java', 44))
      .toBe(`https://github.com/northwind-pay/payments-api/blob/${COMMIT}/src/main/java/pay/security/CryptoService.java#L44`);
  });
});
