# PRD-11 · Branch, Baseline & Test Engineering

| | |
|---|---|
| **Increment** | 11 |
| **Status** | `PLANNED` |
| **Depends on** | PRD-10 |
| **Unblocks** | PRD-12 |
| **Demoable outcome** | Watch the agent create a branch, capture the behavioural baseline, and write crypto regression tests — before it changes a line of implementation. |
| **Created** | 2026-08-29 |
| **Delivered** | |

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
| AC-2 | Baseline records 78 unit and 6 integration tests with one pre-existing failure | test |
| AC-3 | Four invariants captured; `MESSAGE_FORMAT` is `EXPECTED_TO_CHANGE` | test |
| AC-4 | Generated acceptance tests fail on the base commit | test |
| AC-5 | A generated test asserting "tampered ciphertext throws" is rejected before it is written | test |
| AC-6 | An attempt to mock `Encaps`/`Decaps` is refused with `EXEC-MOCK-004` | test |
| AC-7 | Every test or mock change has a `testIntegrity` record | test |
| AC-8 | The screen shows the branch, base commit, commit count and baseline checklist | screen |

## 8. Risks and open questions

| # | Risk or question | Impact | Resolution or owner |
|---|---|---|---|
| 1 | Invariant classification is a model judgment with a wrong-by-default failure mode | Blocks the correct migration or misses a regression | Rule defaults per kind; the model may only override with a reason, recorded |
| 2 | "Correct implementation" behaviour must be known to write a valid test | A test that fails correct code, which the agent then "repairs" | `FIPS203-3.2-002` encodes implicit rejection; FR-10 is the guard |
| 3 | Baseline build needs a working Cloud Build pipeline | Increment blocked | Pipeline definition is part of this increment, not PRD-12 |
| 4 | Base commit may already be broken | No usable baseline | Record it; a build that fails at baseline is a finding and a gate, not a crash |

## 9. Definition of done

- [ ] All FRs implemented
- [ ] All ACs verified
- [x] `BehavioralInvariant` schema change applied — D-003, 2026-08-29
- [ ] Typecheck and tests pass
- [ ] §10 records what was actually built

## 10. Delivery log

| Date | Change | Why |
|---|---|---|

**Deviations from plan** —

**Deferred** —
