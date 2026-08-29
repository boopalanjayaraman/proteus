# PRD-13 · Deterministic Verification & Sandbox

| | |
|---|---|
| **Increment** | 13 |
| **Status** | `DELIVERED` |
| **Depends on** | PRD-12 |
| **Unblocks** | PRD-14 |
| **Demoable outcome** | Nine checks turn green, then the migrated application deploys to an isolated sandbox and passes an end-to-end settlement scenario against a live URL. |
| **Created** | 2026-08-29 |
| **Delivered** | 2026-08-29 |

---

## 1. Problem

The product must not equate "tests pass" with "migration verified". Verification is the
only thing standing between a plausible-looking diff and a claim that the cryptography
actually changed — and it has to be computed from tool evidence, never asserted by a model.

The subtlety that decides whether it works: the absence check must be scoped to the
approved usage. A global "no RSA anywhere" check fails the *correct* migration, because
two signature usages and an RSA-signed certificate are deliberately left in place.

## 2. Sources of truth

| Source | Reference |
|---|---|
| Product spec | §34 deterministic verification · §35 completion rule · §36 sandbox deployment · §37 sandbox link |
| UX design | v1.2 — DETERMINISTIC VERIFICATION list, CRYPTO VERIFICATION with a NOTED row, sandbox card |
| Data model | §3.15 verification results · §3.16 sandbox deployments |
| Rulesets | `EXEC-VER-001..013` · `PROHIB-001` · `FIPS203-8-003` |

## 3. Scope

**In**
- All nine `VerificationCheck` values evaluated from tool evidence
- `cryptoAssertions` as a separate narrative list carrying `NOTED`
- Verdict computed by `computeOverallVerdict()`, excluding `cryptoAssertions`
- Scope conformance: the diff checked against `PlanItem.expectedChanges`
- Image build → Artifact Registry → Cloud Run sandbox
- Startup probe, then E2E against the deployed URL
- Sandbox card with URL and the not-production label

**Out**
- Reports and evidence package → PRD-14
- Sandbox teardown scheduling → PRD-14

---

## 4. Functional requirements

| ID | Requirement | Source |
|---|---|---|
| FR-1 | All nine checks are evaluated; `overall` is computed from them in code | Spec §35 |
| FR-2 | No model output may set `overall`; `cryptoAssertions` is excluded from it | `EXEC-VER-012` |
| FR-3 | A check cannot be `PASS` without an `executionRunId` or evidence | Data model §3.15 |
| FR-4 | `PROHIBITED_CRYPTO_ABSENT` is scoped to the approved plan items' algorithm-and-usage pairs | `EXEC-VER-008` |
| FR-5 | Residual crypto outside scope is reported as `NOTED`, never as a failure | `EXEC-VER-008` |
| FR-6 | `BASELINE_INVARIANTS_PRESERVED` re-runs only `MUST_PRESERVE` invariants; `EXPECTED_TO_CHANGE` are reported before-and-after | `EXEC-VER-005` |
| FR-7 | `REQUIRED_TESTS_PASSED` is a subset relation over the baseline passing set, not a count | `EXEC-VER-004` |
| FR-8 | A real ML-KEM round trip executes against the resolved provider with `mockedPrimitive: false` | `EXEC-VER-006` |
| FR-9 | Changed paths must fall within `expectedChanges`; a breach raises a gate | `EXEC-VER-001` |
| FR-10 | Sandbox deployment is refused unless `overall` is `VERIFIED` | `EXEC-REP-004` |
| FR-11 | The sandbox starts, passes a startup probe, then runs E2E against its URL | Spec §36 |
| FR-12 | `isProduction` is the literal `false` and every surface labels from it | Data model §3.16 |

## 5. Data model

| Collection | Access | Fields of note |
|---|---|---|
| `verification_results` | C | `checks`, `cryptoAssertions`, `residualLegacyCrypto`, `overall` |
| `sandbox_deployments` | C/W | `service.url`, `startupCheck`, `e2e`, `isProduction` |
| `execution_runs` | C | `CRYPTO_VERIFY`, `IMAGE_BUILD`, `DEPLOY`, `E2E_TEST` |
| `migration_runs` | W | `outcome`, `stage`, `completedAt` |
| `projects` | W | `stage: SANDBOX_READY`, `summary.sandboxUrl`, `autonomy` |

**Schema changes** — none.

**Ruleset changes** — none.

## 6. Interfaces

**API** — `GET /projects/{id}/verification`, `GET /projects/{id}/sandbox`.

**Events emitted** — `CRYPTO_VERIFICATION_STARTED/PASSED/FAILED`, `SANDBOX_DEPLOYMENT_STARTED/READY`, `E2E_TEST_PASSED/FAILED`, `MIGRATION_COMPLETED`.

**Agent involvement** — none for the verdict. A3 triggers deploy tools; the verification service is pure code and cannot import `agent/`.

**Rules consumed** — `EXEC-VER-001..013`.

## 7. Acceptance criteria

| ID | Criterion | Verified by |
|---|---|---|
| AC-1 | Breaking any one of the nine checks yields `NOT_VERIFIED` | test |
| AC-2 | A `NOTED` crypto assertion does not affect `overall` | test |
| AC-3 | The two RSA signature usages and the RSA-signed certificate do not fail `PROHIBITED_CRYPTO_ABSENT` | test |
| AC-4 | A `PASS` written without provenance is rejected | test |
| AC-5 | Four new tests passing while four baseline tests break yields `NOT_VERIFIED` | test |
| AC-6 | A mocked KEM primitive fails `REQUIRED_PQC_PRESENT` | test |
| AC-7 | A file changed outside `expectedChanges` raises a gate | test |
| AC-8 | Deployment is refused while `overall` is `NOT_VERIFIED` | test |
| AC-9 | The sandbox URL responds and E2E passes; the card says not production | screen · test · verified against the fixture in Docker |
| AC-10 | Reference scenario ends `VERIFIED`, 100% autonomous completion, zero human engineering actions | test |

## 8. Risks and open questions

| # | Risk or question | Impact | Resolution or owner |
|---|---|---|---|
| 1 | Crypto verification greps source; a provider could resolve differently at runtime | Static pass, runtime failure | FR-8 requires a real round trip. Static and runtime evidence together, neither alone |
| 2 | The E2E scenario is not yet defined | AC-9 unverifiable | **Resolved.** The fixture exposes `GET /healthz`, `POST /settlements` (201/400) and a console reporting the negotiated mechanism. `SETTLEMENT_SCENARIOS` uses all three; verified end to end in Docker |
| 3 | Sandbox services persist and cost money | Drift and spend | Deployment §8 sweep; expiry recorded on the deployment |
| 4 | `expectedChanges` may be narrower than a correct migration needs | A correct migration raises a scope gate | Path patterns rather than exact files; a gate is the right outcome — the human approved a scope |

## 9. Definition of done

- [x] All FRs implemented
- [x] All ACs verified
- [x] Typecheck and tests pass
- [x] §10 records what was actually built

## 10. Delivery log

| Date | Change | Why |
|---|---|---|
| 2026-08-29 | `verification/checks/crypto.ts` — `scopeOf`, `inScope`, `sameFamily`, `verifyCrypto` | The scoping is the whole rule. Absence is asserted only for the algorithm-and-usage pairs the approved plan covers; everything else classical is `NOTED` with a stated reason |
| 2026-08-29 | `verification/checks/tests.ts` — `checkBuild`, `checkTests`, `checkInvariants`, `checkBlockers` | A subset relation rather than a count, `MUST_PRESERVE` asserted and `EXPECTED_TO_CHANGE` reported, and blockers that exclude owned recommendations by design |
| 2026-08-29 | `verification/checks/scope.ts` — `checkScope`, `toPattern` | `EXEC-VER-001`. The autonomy contract, checked against the diff after the fact rather than only promised before it |
| 2026-08-29 | `verification/service.ts` — `verify`, `implicatedBy`, `mayDeploy` | Assembles the nine, computes the verdict through `computeOverallVerdict()` alone, and answers `EXEC-REP-004` separately so the two rules are not circular |
| 2026-08-29 | `verification/e2e.ts` — `probeStartup`, `runScenarios`, `SETTLEMENT_SCENARIOS` | `EXEC-VER-010`/`-011`. Deployed is not running; the probe is the difference. The scenarios are named rather than generated — a model-authored suite would judge the migration against criteria its own author chose |
| 2026-08-29 | `integrations/cloudrun/sandbox.ts` — `SandboxDeployer`, `LocalDockerDeployer`, `ScriptedDeployer` | Same shape as the build executor. The local deployer builds the repository's own Dockerfile, so a startup failure caused by the migration surfaces as it would on Cloud Run |
| 2026-08-29 | `worker/verificationJob.ts` — `runVerification` | Verify, deploy if permitted, re-verify with the sandbox evidence. Opens a gate on a scope breach and on any broken must-preserve invariant |
| 2026-08-29 | `core/migration/baseline.ts` — executions stamp the branch head, not the base commit | A defect found by AC-10. See "Found while building" |
| 2026-08-29 | `core/migration/testGuard.ts` — `PRIMITIVE_STUB_PATTERNS` exported | One definition of "stubbing the primitive", used by the guard that refuses it and by `EXEC-VER-006`'s `mockedPrimitive: false`. PRD-12 already paid for two copies of a pattern once |
| 2026-08-29 | `api/routes/migration.ts` — `GET /verification`, `GET /sandbox` | The verdict with each check's provenance, and the sandbox |
| 2026-08-29 | `lib/migration.ts`, `screens/migration/Migration.tsx`, `styles/migration.css` | The nine checks in spec order, `NOTED` in its own colour, and a sandbox card labelled from `isProduction` |
| 2026-08-29 | `test/verification.test.ts` (33 backend), `test/migration.test.ts` (+5 frontend) | Every AC, including the reference scenario through to `SANDBOX_READY` |

**Verified against the real fixture.** `LocalDockerDeployer` built `fixtures/payments-api`
from its own Dockerfile, started the container, and `probeStartup` reported healthy in
2.1s. All three `SETTLEMENT_SCENARIOS` passed against the live URL, and the accepted
settlement returned `keyEstablishment=RSA-2048 · 256 bytes` — the pre-migration state,
read out of a running system. That is precisely what makes the scenario worth running:
after a correct migration the same call reports ML-KEM-768 and 1088 bytes, and the
difference is visible without reading a line of source.

**Deviations from plan** —

1. **The sandbox checks FAIL before deployment; they are not `NOT_APPLICABLE`.** This
   looks like a detail and is the most important decision in the increment.
   `computeOverallVerdict` treats `NOT_APPLICABLE` as satisfied, so marking an undeployed
   sandbox inapplicable would let a run that never started claim `VERIFIED` — the exact
   failure spec §35 exists to prevent, since it names a started sandbox and a passing
   end-to-end scenario among the conditions. The circularity that `EXEC-REP-004` would
   otherwise create is resolved in `mayDeploy()` instead, which excludes exactly those two
   because they are what deployment establishes. I wrote it the wrong way first and two of
   my own tests contradicted each other, which is how it surfaced.

2. **`MIGRATION_POLICY_SATISFIED` is one check fed by two rules.** `EXEC-VER-001` checks
   the diff against the approved scope and `EXEC-VER-007` checks the resolved provider,
   and both name the same `VerificationCheck` value. It appears once and fails if either
   does: a verdict that reported only the more forgiving of two conditions would be
   worthless.

3. **`NO_CRITICAL_BLOCKER` cites the verification run.** The schema requires a `PASS` to
   name an execution or evidence, and this check is established by a query over the gates
   rather than by a command. Rather than fabricate an evidence id, it cites the
   verification pass itself — which is the execution it was evaluated inside.

4. **Test-engineering changes are exempt from the scope check.** `PlanItem.expectedChanges`
   declares what the *migration* will change. The tests written to judge it are authorised
   by `EXEC-TEST-001`, not by a plan item's path list, and holding them to it would make
   writing a test a scope breach.

5. **The verification pass runs the build and the tests as two executions.** `EXEC-VER-002`
   asks whether the build passes at the branch head specifically. Folding compilation into
   `mvn verify` would leave that question with nothing of its own to read — which is
   exactly what happened before the fix in the next section.

6. **`LocalDockerDeployer` stands in for a Cloud Run client.** Both satisfy one interface
   and the local one builds the same image from the same Dockerfile, so the checks that
   matter are exercised identically. The Cloud Run submission client is deferred to PRD-16
   with the rest of deployment, alongside the Cloud Build one.

7. **Latency delta is measured and reported, never gated.** `EXEC-ESC-007` is explicit
   that "material" needs a budget nobody has supplied, so `latencyDeltaMs` is recorded and
   shown and blocks nothing.

**Found while building** —

**Every execution was stamped with the base commit, even after the head had moved.**
`BaselineService.execute` hardcoded `run.branch.baseCommitSha`, so a test run after three
patches had landed claimed to have tested a tree that no longer existed. Harmless while
nothing read the field — and `EXEC-VER-002` pins the build check to the branch head
precisely so a green build from an intermediate attempt cannot satisfy it for a later
tree. The check was correct and the data feeding it was wrong. Executions now read the
current head from the run document at execution time.

**Nothing ever built at the head.** The loop runs `mvn verify`, which compiles as a side
effect, so no execution of kind `BUILD` existed after the baseline — and the baseline's
was at the base commit. `BUILD_SUCCESSFUL` had nothing to read that was not stale. The
verification pass now compiles and tests as separate executions.

**The Surefire test helper did not XML-escape failure messages.** A JUnit message routinely
contains `<` and `>` — `expected: <256> but was: <1088>` is the canonical shape — so the
unescaped fixture produced XML the parser read differently from the real thing, and the
round trip through `unescapeXml` had never been exercised. Caught by the
expected-to-change invariant test, which needs exactly that message shape.

**Deferred** —

- **The migration report and the evidence package.** PRD-14. `runVerification` calls
  `onVerified` when the verdict is `VERIFIED`; nothing supplies it, and `EXEC-VER-013`
  already requires `MIGRATION_REPORT`, `GIT_DIFF` and `BUILD_TEST_EVIDENCE` before the
  migration may be reported complete.
- **Cloud Run and Cloud Build submission clients** (→ PRD-16). Both interfaces are done and both have
  a working local implementation. Wiring the GCP clients is one deployment task, deferred
  with TD-012 and the rest of PRD-14.
- **Sandbox teardown.** `expiresAt` is recorded seven days out so a sweep can find the
  service, per Risk 3 and Deployment §8. The sweep itself is PRD-14's.
- **`EXEC-VER-007`'s provider evidence is optional.** The check accepts an absent provider
  record rather than failing, because nothing yet resolves the dependency version at
  runtime. When supplied it is asserted; when absent the detail says so plainly rather than
  implying it was checked.
- **The branch is still not pushed.** `GitWriter.push` exists and nothing calls it. A
  verified migration is the first point at which pushing is meaningful, and the PR it would
  open belongs with the report.
