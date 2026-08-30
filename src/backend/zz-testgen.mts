import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import fs from 'node:fs';
import { GeminiClient } from './src/agent/model';
import { TestEngineeringAgent } from './src/agent/flows/testEngineering';
import { classifyAll } from './src/core/migration/invariants';
import type { PlanItem } from '@proteus/schema';
import { WorkingCopy } from './src/core/discovery/workingCopy';
import { apiSurfaceOf } from './src/core/migration/apiSurface';

const ROOT = '/Users/boopalanjayaraman/Documents/Code/proteus/proteus/proteus';
const env = (k: string) => fs.readFileSync(`${ROOT}/src/backend/.env`, 'utf8')
  .match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim();
process.env.GOOGLE_CLOUD_QUOTA_PROJECT = env('GCP_PROJECT_ID');

const TREE = process.argv[2]!;
const model = new GeminiClient(env('GEMINI_MODEL')!, {
  kind: 'VERTEX', projectId: env('GCP_PROJECT_ID')!, location: env('VERTEX_LOCATION') || 'global',
});

const TARGET_PATHS = [
  'src/main/java/pay/security/CryptoService.java',
  'src/main/java/pay/util/CryptoUtils.java',
  'src/main/java/pay/security/PartnerKeyProvider.java',
];
const TEST_PATHS = [
  'src/test/java/pay/security/CryptoServiceTest.java',
  'src/test/java/pay/security/SettlementSignerTest.java',
  'src/test/java/pay/SettlementControllerTest.java',
  'src/test/java/pay/PartnerHandshakeIntegrationTest.java',
  'src/test/java/pay/PartnerHandshakeMock.java',
];
const SUITES = [
  'pay.security.CryptoServiceTest','pay.security.SettlementSignerTest',
  'pay.security.ApiTokenServiceTest','pay.security.WebhookVerifierTest',
  'pay.SettlementControllerTest','pay.SettlementServiceTest',
  'pay.LegacySettlementExporterTest','pay.util.CryptoUtilsTest',
  'pay.store.IdempotencyStoreTest','pay.store.LedgerRepositoryTest',
  'pay.merchant.MerchantDirectoryTest',
];

const testSources = (await Promise.all(TEST_PATHS.map(async (path) => {
  try { return { path, content: await readFile(join(TREE, path), 'utf8') }; }
  catch { return null; }
}))).filter((x): x is { path: string; content: string } => x !== null);

const repo = {
  repositoryName: 'payments-api', language: 'JAVA', buildSystem: 'MAVEN',
  existingSuites: SUITES, testPaths: TEST_PATHS, testSources,
};

const planItem = {
  planItemId: 'plan_1', targetName: 'Key Transport', targetNodeIds: [], findingIds: ['fnd_1'],
  mode: 'AUTONOMOUS_MIGRATION',
  action: 'Migrate RSA-OAEP key transport to ML-KEM-768 key encapsulation',
  rationale: 'CNSA 2.0 / FIPS 203.',
  expectedChanges: [{ changeType: 'SOURCE', paths: TARGET_PATHS, description: 'replace RSA transport' }],
  conditions: [], risk: 'MEDIUM', order: 0,
} as unknown as PlanItem;

const sources = await Promise.all(TARGET_PATHS.map(async (path) => ({
  path, excerpt: (await readFile(join(TREE, path), 'utf8')).slice(0, 4000),
})));
const apiSurface = await apiSurfaceOf(new WorkingCopy(TREE));
console.log(`   api surface: ${apiSurface.length} classes`);
const migration = {
  planItems: [planItem], target: { target: 'ML-KEM', parameterSet: 'ML-KEM-768' },
  targetPaths: TARGET_PATHS, sources, apiSurface,
};

const agent = new TestEngineeringAgent(model);

console.log('1/3 baseline-invariants…');
const proposed = await agent.captureInvariants(repo, migration,
  { total: 36, passed: 36, failed: 0, suites: SUITES });
const { classified } = classifyAll(proposed, 'PQC-TEST');
console.log(`   ${classified.length} invariants ` +
  `(${classified.filter(c=>c.invariant.disposition==='MUST_PRESERVE').length} preserve, ` +
  `${classified.filter(c=>c.invariant.disposition==='EXPECTED_TO_CHANGE').length} change)`);

console.log('2/3 coverage-assessment…');
const uncovered = await agent.assessCoverage(repo, migration);
console.log(`   ${uncovered.length} uncovered component(s)`);

console.log('3/3 generate-tests…');
const artifacts = await agent.generateTests(
  repo, migration, { invariants: classified.map(c => c.invariant) }, uncovered);
console.log(`   ${artifacts.length} artifact(s):`);
for (const a of artifacts) {
  console.log(`     ${a.testKind.padEnd(18)} ${a.path}`);
  const full = join(TREE, a.path);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, a.content, 'utf8');
}
await writeFile('/tmp/testgen.json', JSON.stringify({ proposed, uncovered, artifacts }, null, 2));
