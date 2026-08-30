import {
  gcsPath,
  type Baseline, type ExecutionRun, type Finding, type HumanGate, type MigrationChange,
  type MigrationPolicy, type MigrationRun, type PlanItem, type Project,
  type SandboxDeployment, type VerificationResult,
} from '@proteus/schema';
import type { Logger } from '../config/logger';
import { detect } from '../core/discovery/detect';
import { WorkingCopy } from '../core/discovery/workingCopy';
import { advance, type BuildCommands } from '../core/migration/baseline';
import { BaselineService } from '../core/migration/baseline';
import { openGate } from '../core/migration/gates';
import { PRIMITIVE_STUB_PATTERNS } from '../core/migration/testGuard';
import { parseReports } from '../core/migration/testReports';
import type { Repositories } from '../core/repositories';
import type { RuleEngine } from '../core/rules/engine';
import type { BuildExecutor } from '../integrations/cloudbuild/executor';
import type { SandboxDeployer } from '../integrations/cloudrun/sandbox';
import { sandboxServiceName } from '../integrations/cloudrun/sandbox';
import { releaseSandbox, type SandboxCapacityService } from '../core/services/sandboxCapacity';
import type { SandboxLifecycleService } from '../core/services/sandboxLifecycle';
import type { BlobStore } from '../integrations/storage/blobs';
import { probeStartup, runScenarios, SETTLEMENT_SCENARIOS } from '../verification/e2e';
import { mayDeploy, verify, type VerificationOutcome } from '../verification/service';
import { PROBE_SUITE } from '../core/migration/roundTripProbe';

/**
 * Verification and the sandbox (spec §34–§37).
 *
 * The order is `EXEC-REP-004`: verify first, deploy only if the verdict permits
 * it, then re-verify with the sandbox evidence included. Deploying before the
 * verdict would put an unverified build behind a URL the user is invited to
 * trust, and spec §35 is explicit that tests passing is not migration verified.
 *
 * Nothing here asks a model anything. The verdict comes from
 * `computeOverallVerdict()` over nine checks, each of which cites the execution
 * or document that established it.
 */

export interface VerificationJobDeps {
  repos: Repositories;
  engine: RuleEngine;
  executor: BuildExecutor;
  deployer: SandboxDeployer;
  blobs: BlobStore;
  logger: Logger;
  workdir: string;
  commands: BuildCommands;
  /** The port the image listens on. Read from the repository where it can be. */
  containerPort?: number;
  /** Injected so tests can point the probe and scenarios at a stub server. */
  fetchImpl?: typeof fetch;
  /** Capacity and lifecycle. Absent means unlimited, which is the local default. */
  capacity?: SandboxCapacityService;
  lifecycle?: SandboxLifecycleService;
  /** Emits one event per end-to-end scenario as it completes (FR-G). */
  onScenario?: (scenario: { name: string; passed: boolean; detail: string }) => void;
  /** Produces the report and the evidence package. PRD-14 supplies it. */
  onVerified?: (run: MigrationRun) => void;
}

export interface VerificationJobOutcome {
  result: VerificationResult;
  sandbox: SandboxDeployment | null;
  outcome: VerificationOutcome;
}

export async function runVerification(
  project: Project,
  run: MigrationRun,
  deps: VerificationJobDeps,
): Promise<VerificationJobOutcome> {
  const { repos, engine, blobs } = deps;
  const log = deps.logger.child({ projectId: project.projectId, job: 'verification' });

  const current = await advance(repos, run, 'CRYPTO_VERIFYING');
  await repos.events.emit(project.projectId, {
    type: 'CRYPTO_VERIFICATION_STARTED', phase: 'VERIFICATION',
    level: 'MILESTONE', severity: 'INFO',
    stage: 'CRYPTO_VERIFYING',
    title: 'Verifying the migrated cryptography',
    message: 'Nine checks, each from tool evidence. Tests passing is not migration verified.',
    actor: 'TOOL', refs: {},
  });

  const context = await gather(project, current, deps);

  // The verification pass is itself an execution: it re-runs the suite against
  // the branch head, which is what the test and invariant checks are measured
  // against, and what a query-established check cites.
  const baselines = new BaselineService(repos, deps.executor, blobs);
  // Compile and test are separate executions at the head. `EXEC-VER-002` asks
  // whether the build passes there specifically, and folding it into the test
  // command would leave that question with nothing to read.
  const buildRun = await baselines.execute(
    current, 'BUILD', deps.commands.build, { workdir: deps.workdir },
  );
  const verifyRun = await baselines.execute(
    current, 'CRYPTO_VERIFY', deps.commands.test, { workdir: deps.workdir },
  );

  const wc = new WorkingCopy(deps.workdir);
  // The same detector discovery used. What found the RSA key transport in the
  // first place is what establishes it is gone.
  const detection = await detect(engine, wc, current.branch.headCommitSha
    ?? current.branch.baseCommitSha, () => undefined);

  const roundTrip = await establishRoundTrip(wc, verifyRun, context.target);

  let outcome = verify({
    run: current,
    baseline: context.baseline,
    policy: context.policy,
    approvedItems: context.approvedItems,
    approvedFindings: context.approvedFindings,
    changes: context.changes,
    gates: context.gates,
    blockedFindingIds: context.blockedFindingIds,
    build: buildRun.execution,
    tests: { execution: verifyRun.execution, inventory: verifyRun.inventory },
    generated: context.generated,
    candidates: detection.candidates,
    verificationRunId: verifyRun.execution.executionRunId,
    roundTrip,
    ...(context.provider ? { provider: context.provider } : {}),
    ...(context.target ? { target: context.target } : {}),
    sandbox: null,
  });

  // EXEC-VER-001 — a scope breach is a gate, not a silent failure. The human
  // approved a set of paths and something went outside it.
  if (outcome.breaches.length > 0) {
    await openGate(repos, {
      run: current,
      type: 'MATERIAL_ARCHITECTURE_DECISION',
      title: `${outcome.breaches.length} file(s) changed outside the approved scope`,
      question: 'The migration touched files the approved plan did not declare. Accept the '
        + 'wider scope, or treat this as a breach?',
      context: [
        'The approved plan declared:',
        ...context.approvedItems.flatMap((p) => p.expectedChanges.flatMap(
          (c) => c.paths.map((path) => `  ${path}`),
        )),
        '',
        'These were changed and are not covered by it:',
        ...outcome.breaches.map((b) => `  ${b.path} (modification #${b.sequence})`),
      ].join('\n'),
      options: [
        { optionId: 'ACCEPT_SCOPE', label: 'Accept the wider scope',
          detail: 'Recorded as a human-authorised scope extension.',
          consequence: 'Verification proceeds with the change in place.' },
        { optionId: 'REJECT', label: 'Treat as a breach',
          detail: 'The migration is reported as requiring human review.',
          consequence: 'The run does not complete autonomously.' },
      ],
    }, 'scope-breach');
  }

  // EXEC-VER-005 — a broken must-preserve invariant is a changed behavioural
  // contract, never a test defect. Same precedence EXEC-DIAG-005 enforces.
  for (const broken of outcome.invariants.broken) {
    await openGate(repos, {
      run: current,
      type: 'BASELINE_CONTRACT_CHANGE',
      title: `Baseline invariant no longer holds — ${broken.description}`,
      question: 'The migration changed behaviour the baseline recorded as required. Was '
        + 'that intended?',
      context: `Captured before any modification and classified MUST_PRESERVE:\n  `
        + `${broken.assertion}\n\nIt no longer holds against the migrated build.`,
      options: [
        { optionId: 'ACCEPT_CHANGE', label: 'The change is intended',
          detail: 'Recorded as a human-authorised baseline change.',
          consequence: 'Reported in the migration report as such.' },
        { optionId: 'PRESERVE', label: 'The behaviour must be preserved',
          detail: 'The migration cannot complete as planned.',
          consequence: 'Reported as requiring human engineering.' },
      ],
    }, broken.invariantId);
  }

  let sandbox: SandboxDeployment | null = null;
  const permission = mayDeploy(outcome);

  await repos.events.emit(project.projectId, {
    type: permission.permitted ? 'CRYPTO_VERIFICATION_PASSED' : 'CRYPTO_VERIFICATION_FAILED',
    phase: 'VERIFICATION', level: 'MILESTONE',
    severity: permission.permitted ? 'SUCCESS' : 'ERROR',
    stage: 'CRYPTO_VERIFYING',
    title: permission.permitted
      ? 'Cryptographic verification passed'
      : 'Cryptographic verification failed',
    message: [
      ...outcome.checks
        .filter((c) => c.check !== 'SANDBOX_DEPLOYMENT_SUCCESSFUL'
          && c.check !== 'E2E_VERIFICATION_SUCCESSFUL')
        .map((c) => `${c.status === 'PASS' ? '✓' : '✗'} ${c.check.replace(/_/g, ' ')}`),
      '',
      permission.reason,
    ].join('\n'),
    actor: 'TOOL', refs: {},
  });

  if (permission.permitted) {
    sandbox = await deploySandbox(project, current, deps, outcome);
    // Re-run with the sandbox evidence in hand. Same function, same nine checks;
    // only the two that were NOT_APPLICABLE now have something to read.
    outcome = verify({
      run: current,
      baseline: context.baseline,
      policy: context.policy,
      approvedItems: context.approvedItems,
      approvedFindings: context.approvedFindings,
      changes: context.changes,
      gates: await repos.humanGates.find({ projectId: project.projectId } as never) as HumanGate[],
      blockedFindingIds: context.blockedFindingIds,
      build: buildRun.execution,
      tests: { execution: verifyRun.execution, inventory: verifyRun.inventory },
      generated: context.generated,
      candidates: detection.candidates,
      verificationRunId: verifyRun.execution.executionRunId,
      roundTrip,
      ...(context.provider ? { provider: context.provider } : {}),
      ...(context.target ? { target: context.target } : {}),
      sandbox,
    });
  } else {
    log.warn({ reason: permission.reason }, 'sandbox deployment refused');
  }

  const result = await persist(project, current, outcome, deps);
  await complete(project, current, outcome, sandbox, deps);

  if (outcome.overall === 'VERIFIED') deps.onVerified?.(current);

  return { result, sandbox, outcome };
}

// ---------------------------------------------------------------------------

interface Context {
  baseline: Baseline;
  policy: MigrationPolicy;
  approvedItems: PlanItem[];
  approvedFindings: Finding[];
  changes: MigrationChange[];
  gates: HumanGate[];
  blockedFindingIds: string[];
  generated: { characterization: string[]; acceptance: string[] };
  provider?: { name: string; version: string; advertisesParameterSet: boolean };
  target?: string;
}

async function gather(
  project: Project,
  run: MigrationRun,
  deps: VerificationJobDeps,
): Promise<Context> {
  const { repos } = deps;

  // What the branch contains right now, so a withdrawn artifact stops being
  // required. Deduped, because one file can be written by several changes.
  const present = new Set(
    (await new WorkingCopy(deps.workdir).files().catch(() => [])).map((f) => f.path),
  );
  const onDisk = (paths: string[]): string[] => [...new Set(paths)].filter((p) => present.has(p));

  const [baseline, assessment, changes, gates, findings] = await Promise.all([
    repos.baselines.findOne({ migrationRunId: run.migrationRunId } as never),
    repos.assessments.findOne({ assessmentId: run.approval.assessmentId } as never),
    repos.migrationChanges.collection
      .find({ migrationRunId: run.migrationRunId } as never)
      .sort({ sequence: 1 })
      .toArray() as unknown as Promise<MigrationChange[]>,
    repos.humanGates.find({ projectId: project.projectId } as never) as Promise<HumanGate[]>,
    repos.findings.find({ projectId: project.projectId } as never) as Promise<Finding[]>,
  ]);

  if (!baseline) throw new Error(`${run.migrationRunId}: no baseline to verify against`);
  if (!assessment) throw new Error(`${run.migrationRunId}: approved assessment is missing`);

  const policy = await repos.migrationPolicies.findOne({
    policyId: assessment.policyId,
  } as never);
  if (!policy) throw new Error(`${assessment.policyId}: migration policy is missing`);

  const approved = new Set(run.approval.approvedPlanItemIds);
  const approvedItems = assessment.planItems.filter((p) => approved.has(p.planItemId));
  const approvedFindingIds = new Set(approvedItems.flatMap((p) => p.findingIds));

  const testChanges = changes.filter((c) => c.intent === 'TEST_ENGINEERING');

  return {
    baseline,
    policy: policy as MigrationPolicy,
    approvedItems,
    approvedFindings: findings.filter((f) => approvedFindingIds.has(f.findingId)),
    changes,
    gates,
    blockedFindingIds: findings
      .filter((f) => approvedFindingIds.has(f.findingId) && f.status === 'BLOCKED')
      .map((f) => f.findingId),
    generated: {
      // Suites, not files: one file produces many test methods and the check is
      // "did every method in this suite pass".
      //
      // Only suites still IN THE TREE. `testChanges` is every change with
      // `changeType: 'TEST'`, which includes the commit that *withdraws* an
      // artifact under `EXEC-TEST-001` — so a test the rules removed stayed on
      // the required list, could never run, and failed `REQUIRED_TESTS_PASSED`
      // for the rest of the run. A deployed migration was reported unverified
      // for `pay.security.KeyTransportCharacterizationTest`, a file the system
      // had itself deleted two steps earlier.
      //
      // Existence on disk rather than bookkeeping about which commit undid
      // which: the contract is what the branch actually contains.
      characterization: onDisk(testChanges
        .filter((c) => c.changeType === 'TEST' && !/kem|mlkem|pqc|acceptance/i.test(c.summary))
        .flatMap((c) => c.files.map((f) => f.path))).map(suiteOf),
      acceptance: onDisk(testChanges
        .filter((c) => c.changeType === 'TEST' && /kem|mlkem|pqc|acceptance/i.test(c.summary))
        .flatMap((c) => c.files.map((f) => f.path))).map(suiteOf),
    },
    ...(targetOf(approvedItems) ? { target: targetOf(approvedItems)! } : {}),
  };
}

/**
 * `EXEC-VER-006` — the check that cannot be satisfied by reading source.
 *
 * `mockedPrimitive` is the field that carries the weight: paired with
 * `EXEC-MOCK-004`, without it the entire verification chain is satisfiable by a
 * stub returning a constant. It is established by scanning the test tree for a
 * stub of the primitive, not by asking anyone.
 */
async function establishRoundTrip(
  wc: WorkingCopy,
  verifyRun: { execution: ExecutionRun; inventory: ReturnType<typeof parseReports> },
  target: string | undefined,
) {
  let mocked = false;
  const stubs: string[] = [];

  for (const file of (await wc.files()).filter((f) => f.kind === 'TEST')) {
    const content = await wc.read(file.path).catch(() => '');
    for (const { re, what } of PRIMITIVE_STUB_PATTERNS) {
      if (re.test(content)) {
        mocked = true;
        stubs.push(`${file.path} stubs ${what}`);
        break;
      }
    }
  }

  /*
   * The round trip is established by Proteus's own probe, and only by it.
   *
   * This used to select any test whose suite or name matched
   * `/kem|encaps|decaps|roundtrip|sharedsecret/i` — a match on a name chosen by
   * the agent whose work is being judged. A run produced a `wrapSessionKey`
   * that discarded its argument, together with a `MlKemMigrationAcceptanceTest`
   * asserting the algorithm string, the key type string and the ciphertext
   * length. All three passed, the suite name matched `kem`, and verification
   * reported "round trip executed; shared secrets match" about code that
   * transported nothing.
   *
   * `PROBE_SUITE` is generated from the repository's API surface with no model
   * involved and asserts that a key put in comes back out. If it did not run,
   * nothing is established — which is the honest answer, and the one the name
   * match was papering over.
   */
  const kemTests = verifyRun.inventory.tests.filter((t) => t.suite === PROBE_SUITE);
  const executed = kemTests.length > 0;
  const allPassed = executed && kemTests.every((t) => t.status === 'PASSED');

  return {
    executed,
    sharedSecretsMatch: allPassed,
    mockedPrimitive: mocked,
    ...(target ? { parameterSetResolved: executed && allPassed ? target : undefined } : {}),
    detail: executed
      ? `${kemTests.length} round-trip probe assertion(s) ran in ${verifyRun.execution.command}; `
        + `${kemTests.filter((t) => t.status === 'PASSED').length} passed`
        + (mocked ? `. ${stubs.join('; ')}` : '. No test stubs the primitive.')
      : `Proteus's round-trip probe (${PROBE_SUITE}) did not run, so nothing was `
        + 'established about the primitive at runtime. A suite that merely names the '
        + 'algorithm is not evidence that a key survives encapsulation.',
  } as {
    executed: boolean; sharedSecretsMatch: boolean; mockedPrimitive: boolean;
    parameterSetResolved?: string; detail: string;
  };
}

/** Builds the image, deploys it, probes it, and runs the scenarios against it. */
async function deploySandbox(
  project: Project,
  run: MigrationRun,
  deps: VerificationJobDeps,
  outcome: VerificationOutcome,
): Promise<SandboxDeployment> {
  const { repos, blobs, deployer } = deps;
  void outcome;

  const advanced = await advance(repos, run, 'SANDBOX_DEPLOYING');
  const sandboxDeploymentId = `sbx_${run.migrationRunId}`;
  const now = new Date();
  const commitSha = run.branch.headCommitSha ?? run.branch.baseCommitSha;

  await repos.events.emit(project.projectId, {
    type: 'SANDBOX_DEPLOYMENT_STARTED', phase: 'SANDBOX', level: 'MILESTONE', severity: 'INFO',
    stage: 'SANDBOX_DEPLOYING',
    title: 'Building the migrated image',
    message: 'Verification passed, so EXEC-REP-004 permits the deploy.',
    actor: 'TOOL', refs: {},
  });

  const deployment: SandboxDeployment = {
    _schemaVersion: 1, createdAt: now, updatedAt: now,
    sandboxDeploymentId,
    projectId: project.projectId,
    migrationRunId: run.migrationRunId,
    imageUri: '',
    commitSha,
    service: { name: sandboxServiceName(project.projectId), region: deployer.region },
    status: 'BUILDING_IMAGE',
    // A literal, so every surface that shows the URL labels it from the data
    // rather than from a caption someone could forget to write.
    isProduction: false,
    placement: deployer.kind === 'CLOUD_RUN' ? 'CLOUD_RUN' : 'LOCAL',
    // Long enough for review, per spec §36, and recorded so a sweep can find it.
    ...(deps.lifecycle
      ? deps.lifecycle.windowFor(now)
      : { expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000) }),
  };
  await repos.sandboxDeployments.insert(deployment);

  const set = async (patch: Partial<SandboxDeployment>): Promise<void> => {
    Object.assign(deployment, patch);
    await repos.sandboxDeployments.collection.updateOne(
      { sandboxDeploymentId } as never,
      { $set: { ...patch, updatedAt: new Date() } as never },
    );
  };

  try {
    const image = await deployer.buildImage({
      workdir: deps.workdir,
      tag: project.projectId.toLowerCase(),
      commitSha,
    });
    await blobs.put(
      gcsPath.executionLog(project.projectId, `${sandboxDeploymentId}-image`),
      Buffer.from(image.log, 'utf8'),
      'text/plain; charset=utf-8',
    );
    await set({
      imageUri: image.imageUri,
      ...(image.imageDigest ? { imageDigest: image.imageDigest } : {}),
      status: 'DEPLOYING',
    });

    const deployed = await deployer.deploy({
      serviceName: deployment.service.name,
      imageUri: image.imageUri,
      region: deployer.region,
      containerPort: deps.containerPort ?? 8080,
    });
    await set({
      service: { ...deployment.service, url: deployed.url, ...(deployed.revision ? { revision: deployed.revision } : {}) },
      status: 'STARTING',
      deployedAt: new Date(),
    });

    // EXEC-VER-010 — deployed is not running. A revision can exist and serve
    // errors, and E2E results against a dead service are meaningless.
    // The address this process can reach, which on a VM is not the one shown.
    const reachable = deployed.probeUrl ?? deployed.url;
    const probe = await probeStartup(reachable, {
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    });
    await set({
      startupCheck: {
        passed: probe.passed,
        ...(probe.httpStatus !== undefined ? { httpStatus: probe.httpStatus } : {}),
        detail: probe.detail,
        startupMs: probe.startupMs,
      },
      status: probe.passed ? 'READY' : 'FAILED',
    });

    if (!probe.passed) {
      await repos.events.emit(project.projectId, {
        type: 'SANDBOX_DEPLOYMENT_READY', phase: 'SANDBOX', level: 'MILESTONE', severity: 'ERROR',
        stage: 'SANDBOX_DEPLOYING',
        title: 'The sandbox did not start',
        message: probe.detail,
        actor: 'TOOL', refs: { sandboxDeploymentId },
      });
      return deployment;
    }

    await repos.events.emit(project.projectId, {
      type: 'SANDBOX_DEPLOYMENT_READY', phase: 'SANDBOX', level: 'MILESTONE', severity: 'SUCCESS',
      stage: 'SANDBOX_DEPLOYING',
      title: 'Sandbox ready',
      message: `${deployed.url} · ${probe.detail} · not production`,
      actor: 'TOOL', refs: { sandboxDeploymentId },
    });

    // EXEC-VER-011 — against the deployed service, not a local harness.
    const e2eRun = await advance(repos, advanced, 'END_TO_END_VERIFYING');
    const scenarios = await runScenarios(reachable, SETTLEMENT_SCENARIOS, {
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      // FR-G. `runScenarios` already executes them one at a time and already has
      // each verdict; it simply reported once at the end. This is the phase a
      // viewer is most engaged in — a real URL answering.
      onScenario: async (s) => {
        deps.onScenario?.(s);
        await repos.events.emit(project.projectId, {
          type: s.passed ? 'E2E_TEST_PASSED' : 'E2E_TEST_FAILED',
          phase: 'SANDBOX', level: 'ACTIVITY',
          severity: s.passed ? 'SUCCESS' : 'ERROR',
          stage: 'END_TO_END_VERIFYING',
          title: s.name,
          message: s.detail,
          actor: 'TOOL', refs: { sandboxDeploymentId },
        });
      },
    });

    const executionRunId = `exec_${run.migrationRunId}_e2e`;
    const started = new Date();
    await repos.executionRuns.insert({
      _schemaVersion: 1, createdAt: started, updatedAt: new Date(),
      executionRunId, projectId: project.projectId, migrationRunId: run.migrationRunId,
      kind: 'E2E_TEST', environment: 'CLOUD_RUN_SANDBOX',
      provider: { cloudRunService: deployment.service.name, region: deployer.region },
      commitSha,
      command: `e2e against ${deployed.url}`,
      exitCode: scenarios.passed ? 0 : 1,
      status: scenarios.passed ? 'SUCCESS' : 'FAILURE',
      tests: {
        total: scenarios.scenarios.length,
        passed: scenarios.scenarios.filter((s) => s.passed).length,
        failed: scenarios.scenarios.filter((s) => !s.passed).length,
        skipped: 0,
        failures: scenarios.scenarios.filter((s) => !s.passed).map((s) => ({
          testId: s.name, name: s.name, suite: 'e2e', message: s.detail,
        })),
      },
      logExcerpt: scenarios.log.split('\n').slice(0, 20),
      startedAt: started,
      finishedAt: new Date(),
    });

    await set({
      e2e: {
        executionRunId,
        passed: scenarios.passed,
        scenarios: scenarios.scenarios.map((s) => ({ name: s.name, passed: s.passed })),
        ...(scenarios.latencyDeltaMs !== undefined
          ? { latencyDeltaMs: scenarios.latencyDeltaMs }
          : {}),
      },
    });

    await repos.events.emit(project.projectId, {
      type: scenarios.passed ? 'E2E_TEST_PASSED' : 'E2E_TEST_FAILED',
      phase: 'SANDBOX', level: 'MILESTONE',
      severity: scenarios.passed ? 'SUCCESS' : 'ERROR',
      stage: 'END_TO_END_VERIFYING',
      title: scenarios.passed
        ? `${scenarios.scenarios.length} end-to-end scenarios passed`
        : 'End-to-end verification failed',
      message: scenarios.log,
      actor: 'TOOL', refs: { sandboxDeploymentId, executionRunId },
    });
    void e2eRun;

    // D-020, and the whole reason the caps are on retention rather than on
    // deployment. Everything above has happened: the image built, the service
    // started, the scenarios ran. The verdict is complete. What capacity decides
    // is only whether the link survives the next minute.
    if (deps.capacity && deployment.placement === 'CLOUD_RUN') {
      const state = await deps.capacity.reclaimThenCheck(
        project.ownerId,
        project.projectId,
        (stale) => releaseSandbox(repos, deployer, stale, 'EXPIRED'),
      );
      if (!state.canRetain) {
        await releaseSandbox(repos, deployer, deployment, 'CAPACITY');
        return {
          ...deployment,
          status: 'TORN_DOWN' as const,
          tornDownReason: 'CAPACITY' as const,
        };
      }
    }
  } catch (e) {
    await set({ status: 'FAILED' });
    // A container started before the failure must not be left running. Nothing
    // called dispose before this, so every verified migration leaked one.
    await deployer.teardown({
      serviceName: deployment.service.name,
      ...(deployment.imageUri ? { imageUri: deployment.imageUri } : {}),
    }).catch(() => undefined);
    await repos.events.emit(project.projectId, {
      type: 'SANDBOX_DEPLOYMENT_READY', phase: 'SANDBOX', level: 'MILESTONE', severity: 'ERROR',
      stage: 'SANDBOX_DEPLOYING',
      title: 'Sandbox deployment failed',
      message: (e as Error).message,
      actor: 'TOOL', refs: { sandboxDeploymentId },
    });
  }

  return deployment;
}

/** Writes the result. Immutable — a re-verification produces a new document. */
async function persist(
  project: Project,
  run: MigrationRun,
  outcome: VerificationOutcome,
  deps: VerificationJobDeps,
): Promise<VerificationResult> {
  const now = new Date();
  const existing = await deps.repos.verificationResults.count({
    migrationRunId: run.migrationRunId,
  } as never);

  const result: VerificationResult = {
    _schemaVersion: 1, createdAt: now, updatedAt: now,
    verificationResultId: `ver_${run.migrationRunId}_${existing + 1}`,
    projectId: project.projectId,
    migrationRunId: run.migrationRunId,
    commitSha: run.branch.headCommitSha ?? run.branch.baseCommitSha,
    checks: outcome.checks,
    cryptoAssertions: outcome.cryptoAssertions,
    overall: outcome.overall,
    residualLegacyCrypto: outcome.residual,
    detectedPqc: outcome.detected,
    verifiedAt: now,
  };

  await deps.repos.verificationResults.insert(result);
  await deps.repos.projects.collection.updateOne({ projectId: project.projectId } as never, {
    $set: { 'current.verificationResultId': result.verificationResultId, updatedAt: now } as never,
  });
  return result;
}

/** Moves the project to its terminal state for this run. */
async function complete(
  project: Project,
  run: MigrationRun,
  outcome: VerificationOutcome,
  sandbox: SandboxDeployment | null,
  deps: VerificationJobDeps,
): Promise<void> {
  const { repos } = deps;
  const now = new Date();
  const verified = outcome.overall === 'VERIFIED';

  await advance(repos, run, verified ? 'COMPLETED' : 'CRYPTO_VERIFYING');
  await repos.migrationRuns.collection.updateOne(
    { migrationRunId: run.migrationRunId } as never,
    {
      $set: {
        status: verified ? 'COMPLETED' : 'PAUSED_FOR_HUMAN',
        outcome: verified ? 'VERIFIED' : 'HUMAN_ACTION_REQUIRED',
        ...(verified ? { completedAt: now } : {}),
        updatedAt: now,
      } as never,
    },
  );

  /**
   * A run that has stopped needing a person says so, whatever kind of gate it is.
   *
   * `blocking` answers a different question — EXEC-ESC-001's, whether *other*
   * approved work carries on while this one waits. It is not a statement about
   * the run's terminal state, and reading it as one is how a migration ended
   * `PAUSED_FOR_HUMAN` with `HUMAN_ACTION_REQUIRED` on the run and
   * `actionRequired: false` on the project: paused, waiting, and nothing on any
   * screen saying so. The only open gate was a non-blocking retry-budget one.
   *
   * The run's own outcome is the authority here. If it is not verified, a human
   * is required — that is what the outcome literally says.
   */
  await repos.projects.transition(
    project.projectId,
    'MIGRATING',
    verified ? 'SANDBOX_READY' : 'NEEDS_HUMAN_ACTION',
    {
      ...(verified ? {} : { actionRequired: true }),
    } as never,
  ).catch(() => undefined);

  await repos.projects.collection.updateOne({ projectId: project.projectId } as never, {
    $set: {
      'summary.verificationComplete': verified,
      'summary.migrationComplete': verified,
      'summary.sandboxDeployed': sandbox?.status === 'READY',
      ...(sandbox?.service.url ? { 'summary.sandboxUrl': sandbox.service.url } : {}),
      'summary.lastActivityAt': now,
      'summary.lastActivityText': verified
        ? 'Migration verified · sandbox ready'
        : 'Verification did not pass — human action required',
      updatedAt: now,
    } as never,
  });

  await repos.events.emit(project.projectId, {
    type: verified ? 'MIGRATION_COMPLETED' : 'MIGRATION_FAILED',
    phase: 'VERIFICATION', level: 'MILESTONE',
    severity: verified ? 'SUCCESS' : 'ERROR',
    stage: verified ? 'COMPLETED' : 'CRYPTO_VERIFYING',
    title: verified ? 'Migration verified' : 'Migration not verified',
    message: verified
      ? `All nine checks pass. Sandbox at ${sandbox?.service.url ?? 'n/a'} — not production.`
      : outcome.checks.filter((c) => c.status === 'FAIL')
          .map((c) => `${c.check.replace(/_/g, ' ')}: ${c.detail}`).join('\n'),
    actor: 'TOOL', refs: {},
  });
}

/** `src/test/java/pay/security/CryptoServiceTest.java` → `pay.security.CryptoServiceTest` */
function suiteOf(path: string): string {
  const m = /src\/test\/(?:java|kotlin)\/(.+)\.(?:java|kt)$/.exec(path);
  return m?.[1] ? m[1].replace(/\//g, '.') : (path.split('/').pop()?.replace(/\.\w+$/, '') ?? path);
}

function targetOf(items: PlanItem[]): string | undefined {
  for (const item of items) {
    const m = /ML-KEM-(512|768|1024)/i.exec(`${item.action} ${item.rationale}`);
    if (m) return m[0].toUpperCase();
  }
  return undefined;
}
