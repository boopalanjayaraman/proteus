# PRD-11 · Branch, Baseline & Test Engineering

| | |
|---|---|
| **Increment** | 11 |
| **Status** | `DELIVERED` |
| **Depends on** | PRD-10 |
| **Unblocks** | PRD-12 |
| **Demoable outcome** | Watch the agent create a branch, capture the behavioural baseline, and write crypto regression tests — before it changes a line of implementation. |
| **Created** | 2026-08-29 |
| **Delivered** | 2026-08-29 |

---

## 1. Problem

Everything the migration later claims rests on a baseline captured before anything moved.
Get the baseline wrong and verification compares against a moving target; capture the
wrong things as invariants and the correct migration is blocked by its own contract.

The reference repository has no test that touches key establishment, so there is nothing
to preserve until the agent writes it.

## 2. Sources of truth

| Source | Reference |
|---|---|
| Product spec | §23 branch creation · §24 baseline contract · §25 test and mock generation · §26 anti-cheating |
| UX design | v1.2 — Live Migration: branch panel, stage rail, BASELINE CONTRACT checklist |
| Rulesets | `EXEC-INV-001..004` · `EXEC-TEST-001..007` · `EXEC-MOCK-001..004` |
| Agent architecture | §2 A3 |

## 3. Scope

**In**
- Branch `agent/pqc/{projectId}` from the recorded base commit
- Baseline build and test run; pre-existing failures recorded as known
- Invariant capture, each classified `MUST_PRESERVE` or `EXPECTED_TO_CHANGE`
- Characterization tests where no test covers the component
- Migration acceptance tests, validated to fail against the base commit
- Mock preparation, with `testIntegrity` on every test or mock change
- Refusal to mock the primitive under migration
- Live Migration screen: branch panel, stage rail, baseline checklist

**Out**
- Applying implementation changes → PRD-12
- Running the build/test loop → PRD-12
- Verification → PRD-13

---

## 4. Functional requirements

| ID | Requirement | Source |
|---|---|---|
| FR-1 | The branch is created from `baseCommitSha`; the original branch is never written | Spec §23 |
| FR-2 | Baseline build and tests run on the base commit before any modification | `EXEC-INV-001` |
| FR-3 | Tests failing at baseline are recorded as known and excluded from verification | `EXEC-INV-002` |
| FR-4 | Every captured invariant is classified `MUST_PRESERVE` or `EXPECTED_TO_CHANGE` | `EXEC-INV-003` |
| FR-5 | `MESSAGE_FORMAT` defaults to `EXPECTED_TO_CHANGE`; ciphertext length moves 256 → 1088 | `EXEC-INV-003` |
| FR-6 | Every invariant carries an executable assertion, not prose | `EXEC-INV-004` |
| FR-7 | Where no test covers the component, characterization tests are written and must pass at base | `EXEC-TEST-001` |
| FR-8 | Acceptance tests must fail against the unmigrated build; an unexpected pass raises a finding | `EXEC-TEST-002` |
| FR-9 | Generated crypto tests assert the FIPS 203 sizes and the round trip | `EXEC-TEST-003/005` |
| FR-10 | Malformed-length input is asserted rejected; a tampered valid-length ciphertext is asserted to yield a *different secret*, never to throw | `EXEC-TEST-004`, `FIPS203-3.2-002` |
| FR-11 | Mocking the KEM primitive, provider or shared-secret comparison is refused | `EXEC-MOCK-004` |
| FR-12 | Every TEST/MOCK/FIXTURE change carries a `testIntegrity` record | `EXEC-MOCK-001` |
| FR-13 | A change touching a baseline-invariant assertion raises a gate | `EXEC-TEST-007` |

## 5. Data model

| Collection | Access | Fields of note |
|---|---|---|
| `migration_runs` | W | `branch`, `stage`, `checkpoint`, `baselineId` |
| `baselines` | C | `build`, `tests.knownFailures`, `invariants` |
| `migration_changes` | C | `changeType: TEST/MOCK`, `testIntegrity` |
| `execution_runs` | C | `BASELINE_BUILD`, `BASELINE_TEST` |

**Schema changes** — **done, 2026-08-29** (decision D-003).
`BehavioralInvariant.mustHold: z.literal(true)` replaced with
`disposition: 'MUST_PRESERVE' | 'EXPECTED_TO_CHANGE'`, plus optional `observedAfter`.
No longer blocks this increment.

## 6. Interfaces

**API** — `GET /projects/{id}/migration`, `GET /projects/{id}/baseline`.

**Events emitted** — `BRANCH_CREATED`, `BASELINE_CAPTURE_STARTED/COMPLETED`, `TEST_CREATED`, `MOCK_CREATED` (all MILESTONE or ACTIVITY).

**Agent involvement** — A3. Tools: `create_branch`, `apply_patch`, `commit`, `generate_test`, `generate_mock`, `run_cloud_build`, `run_tests`.

**Rules consumed** — `EXEC-INV-*`, `EXEC-TEST-*`, `EXEC-MOCK-*`, `FIPS203-8-003`, `FIPS203-3.3-004`, `FIPS203-3.2-002`.

## 7. Acceptance criteria

| ID | Criterion | Verified by |
|---|---|---|
| AC-1 | The original branch is unchanged after the run | test |
| AC-2 | The baseline inventory comes from the JUnit XML — every test named, unit and integration split, every pre-existing failure recorded as known and excluded | test · verified against the fixture (34 unit + 2 integration, 0 pre-existing) |
| AC-3 | Invariants are classified by rule, not by the model; `MESSAGE_FORMAT` and any length- or algorithm-pinning `CRYPTO_OUTCOME` come out `EXPECTED_TO_CHANGE` | test |
| AC-4 | Generated acceptance tests fail on the base commit | test |
| AC-5 | A generated test asserting "tampered ciphertext throws" is rejected before it is written | test |
| AC-6 | An attempt to mock `Encaps`/`Decaps` is refused with `EXEC-MOCK-004` | test |
| AC-7 | Every test or mock change has a `testIntegrity` record | test |
| AC-8 | The screen shows the branch, base commit, commit count, stage rail and baseline checklist | screen · test |

## 8. Risks and open questions

| # | Risk or question | Impact | Resolution or owner |
|---|---|---|---|
| 1 | Invariant classification is a model judgment with a wrong-by-default failure mode | Blocks the correct migration or misses a regression | Rule defaults per kind; the model may only override with a reason, recorded |
| 2 | "Correct implementation" behaviour must be known to write a valid test | A test that fails correct code, which the agent then "repairs" | `FIPS203-3.2-002` encodes implicit rejection; FR-10 is the guard |
| 3 | Baseline build needs a working Cloud Build pipeline | Increment blocked | Pipeline definition is part of this increment, not PRD-12 |
| 4 | Base commit may already be broken | No usable baseline | Record it; a build that fails at baseline is a finding and a gate, not a crash |

## 9. Definition of done

- [x] All FRs implemented
- [x] All ACs verified
- [x] `BehavioralInvariant` schema change applied — D-003, 2026-08-29
- [x] Typecheck and tests pass
- [x] §10 records what was actually built

## 10. Delivery log

| Date | Change | Why |
|---|---|---|
| 2026-08-29 | `integrations/cloudbuild/executor.ts` — `BuildExecutor`, `ProcessExecutor` (optionally inside a container image), `ScriptedExecutor`, `collectReports`, `excerpt` | Everything downstream rests on a command that actually ran. An interface the model cannot reach, with a real implementation and a scripted one |
| 2026-08-29 | `deployment/cloudbuild/migration-build.yaml` | Risk 3. The pipeline uploads reports even when tests fail — a red run is exactly when the results matter — and never reduces the run to a pass/fail flag |
| 2026-08-29 | `integrations/github/writer.ts` — `GitWriter`, `safeJoin`, `migrationBranchName` | Write access as a separate class from the reader, so "read-only before approval" stays structural. Refuses to commit off the migration branch and refuses a path that escapes the tree |
| 2026-08-29 | `core/migration/testReports.ts` — JUnit XML parsing, inventory, known failures | The only source of the test counts. Maven's summary line disappears when the build fails early; the XML survives |
| 2026-08-29 | `core/migration/invariants.ts` — `DEFAULT_DISPOSITION`, `classify`, `isExecutable` | Risk 1. The rule sets the default per kind and the model may only override it with a reason, constrained in both directions |
| 2026-08-29 | `core/migration/testGuard.ts` — `guardTestArtifact`, `validateAgainstBase`, `touchedInvariants` | The anti-cheating core. Four refusals, all deterministic, none of which the subject can argue with |
| 2026-08-29 | `core/migration/baseline.ts` — `BaselineService`, `commandsFor`, `advance` | Spec §24, plus the `EXEC-INV-001` guard and the stage checkpoint an evicted worker resumes from |
| 2026-08-29 | `core/migration/changes.ts` — `ChangeRecorder`, `openAttempt`, `closeAttempt` | A change is recorded once its commit exists. The diff goes to blob storage; the integrity record stays in Mongo |
| 2026-08-29 | `agent/flows/testEngineering.ts`, `agent/prompts/testEngineering.ts`, A3's tool table | A3 proposes; `core/` decides. The prompt names every trap the guard enforces |
| 2026-08-29 | `worker/migrationJob.ts` — `runTestEngineering` | Branch → baseline → invariants → coverage → tests → validate, in the only order that works |
| 2026-08-29 | `api/routes/migration.ts` — `GET /baseline`, `GET /changes`; `server.ts` supplies `startMigration` | PRD-10 left the callback unwired; approval now starts the migration |
| 2026-08-29 | `screens/migration/Migration.tsx`, `lib/migration.ts`, `styles/migration.css` | Screen 4's branch panel, stage rail and BASELINE CONTRACT checklist |
| 2026-08-29 | `test/migration.test.ts` (26 backend, against a real git repo), `test/migration.test.ts` (8 frontend), `test/helpers/repo.ts` | Every AC. Git is not mocked — "the original branch is unchanged" is a claim about git's actual state |

**Verified against the real fixture.** `ProcessExecutor` ran `mvn -B verify` in
`maven:3.9-eclipse-temurin-17` against `fixtures/payments-api`: 12 report files parsed,
36 tests, 34 unit + 2 integration, 0 failures. The unit/integration split and the counts
match the fixture's own documented shape, so the parser and the executor are confirmed
against real Maven output rather than only against generated XML.

**Deviations from plan** —

1. **AC-2's numbers were the UX mock's, not the fixture's.** The mock shows 78 unit and 6
   integration tests with one pre-existing failure; the fixture has 34 and 2 with none —
   both of its rigged failures appear only *after* a correct migration, which is the
   point of them. Restated as a property: the inventory comes from the XML, every test is
   named, the unit/integration split is taken from which plugin ran them, and every
   pre-existing failure is recorded as known. The known-failure path is still tested, with
   a scripted red baseline.

2. **AC-3's "four invariants" was also descriptive.** The count depends on what the model
   proposes. Restated as the property that matters: the disposition is decided by rule,
   and anything pinning a ciphertext length or an algorithm identifier comes out
   `EXPECTED_TO_CHANGE` however the model labelled it.

3. **`EXEC-INV-003`'s CRYPTO_OUTCOME exception is applied unconditionally, not only on
   request.** The rule lists `negotiatedAlgorithmIdentifier` and `sharedSecretEncoding` as
   exceptions to the MUST_PRESERVE default. Waiting for the model to invoke them would
   make the fixture's `assertEquals(256, wrapped.length)` a regression whenever the model
   labelled it `CRYPTO_OUTCOME` rather than `MESSAGE_FORMAT` — and per `fixtures/README.md`
   that single classification decides whether the demo ends with zero human engineering
   actions or one. The override is applied by rule and recorded with its reason.

4. **The unit/integration split comes from the report directory, not the class name.**
   `failsafe-reports` versus `surefire-reports`. A project is free to name its integration
   tests anything, but it is not free to choose which plugin ran them, and that is what
   the baseline's split actually means.

5. **`ProcessExecutor` replaces a Cloud Build submission client.** Risk 3 asked for the
   pipeline definition as part of this increment, and that is delivered. The submission
   client is not: the executor runs the same commands locally or inside a container image,
   which is what makes the demo work on a machine with no Java and no GCP round trip. The
   interface is the same shape either way. Deferred to PRD-14 with the rest of deployment.

6. **A build that fails at baseline continues rather than throwing.** Risk 4 said record
   it. The run captures the empty inventory, emits the milestone at `WARN` and carries on,
   because a broken base commit is a finding about the repository and a crash tells the
   user nothing.

7. **One feed line per refused artifact, not per refusal.** A file can break two rules at
   once — a declared mock of the primitive whose body also stubs it — and the reader needs
   one entry naming both rather than the same filename twice.

**Found while building** —

**The mock guard missed Mockito's more common stubbing form.** The first pattern matched
`when(kem.encapsulate(..))` but not `doReturn(secret).when(kem).decapsulate(..)`, because
the character class stopped at the first `)`. Since `doReturn(...).when(...)` is the form
most Java codebases use for void and spy stubbing, the guard would have let through the
most likely way of faking the primitive. Caught by a test that enumerated four stub
shapes rather than one.

**Deferred** —

- **The build/test/repair loop.** PRD-12. `runTestEngineering` stops at
  `VALIDATING_BASELINE_TESTS` and calls `onTestsReady`, which nothing supplies yet.
- **A vacuous or base-broken test is reported, not reverted.** `EXEC-TEST-002` says
  `onUnexpectedPass: RAISE_FINDING`, and the finding is raised as a feed entry at `WARN`.
  Removing the commit belongs with the repair loop that can re-propose a replacement.
- **`EXEC-TEST-006` (approved KDM where key derivation is introduced) is not implemented.**
  It is `gating: false` and conditional on a derivation that does not exist until PRD-12
  writes one.
- **`EXEC-MOCK-002` coexistence** — retaining the legacy protocol path under an explicit
  legacy test — is not implemented. It is conditional on the approved plan requiring
  classical/PQC coexistence, and the reference scenario replaces the legacy path outright.
- **The branch is committed but not pushed.** `GitWriter.push` exists and is tested only
  for its error handling; nothing calls it until there is a completed migration to push.
- **`EXEC-TEST-007` raises a refusal, not yet a gate document.** The guard returns
  `gateType: BASELINE_CONTRACT_CHANGE` and the artifact is refused. Opening the gate and
  pausing the run is PRD-12's job, since it owns the mid-migration gate machinery.
