# PRD-12 · Build/Test Loop, Diagnosis & Repair

| | |
|---|---|
| **Increment** | 12 |
| **Status** | `PLANNED` |
| **Depends on** | PRD-11 |
| **Unblocks** | PRD-13 |
| **Demoable outcome** | Watch the agent change code, build, hit a real integration failure, diagnose it, repair the mock, and retest — without being asked a single question. |
| **Created** | 2026-08-29 |
| **Delivered** | |

---

## 1. Problem

This is the product's second WOW moment and the whole reason it claims to be an engineer
rather than an assistant. It is also where the two hardest guarantees live: the agent must
not weaken a test to get a pass, and it must know when to stop.

The loop belongs in the orchestrator, not inside model reasoning. A loop the model drives
cannot be checkpointed, cannot be resumed after eviction, and cannot be bounded.

## 2. Sources of truth

| Source | Reference |
|---|---|
| Product spec | §27 execution · §28 diagnosis and repair · §29 classification · §30 gates · §31 retry policy · §32 test environment · §33 structured evidence |
| UX design | v1.2 — Live Migration: feed with FAIL/DIAGNOSIS/REPAIR rows, stat tiles, RETRY POLICY `n / 4` |
| Agent architecture | §2 A3, A4 · §6 the migration loop |
| Rulesets | `EXEC-DIAG-001..012` · `EXEC-REP-001..004` · `EXEC-ESC-001..010` |

## 3. Scope

**In**
- Orchestrator loop: patch → commit → build/test → classify → repair → retest
- Cloud Build integration with structured failure extraction (≤20 lines; full log to GCS)
- Deterministic classification first; A4 only for the residue
- `problemKey` and `problem_threads`; the four-attempt budget
- Repair authorisation from rules
- Gates and recommendations, blocking and non-blocking
- Checkpoint per iteration; lease refresh
- Live Migration feed, stat tiles, retry counter

**Out**
- Verification checks → PRD-13
- Sandbox deployment → PRD-13
- Migration report → PRD-14

---

## 4. Functional requirements

| ID | Requirement | Source |
|---|---|---|
| FR-1 | The loop runs in the orchestrator; A3 is invoked per patch and does not iterate | Agent arch §6 |
| FR-2 | Every iteration writes a checkpoint; an evicted worker repeats at most one attempt | Data model §6c |
| FR-3 | Build and test outcomes come from `ExecutionRun`, never from a model claim | Spec §46 |
| FR-4 | Failures are reduced to structured evidence of at most 20 log lines; the full log goes to GCS | Spec §33 |
| FR-5 | Classification runs `EXEC-DIAG-*` before any model call; the source is recorded | `EXEC-DIAG-001` |
| FR-6 | A4 is invoked only when no classifier matched, and cannot modify code | Agent arch §2 |
| FR-7 | A failing baseline invariant classifies as `EXPECTED_BEHAVIOR_CHANGE` and raises a gate, never a test defect | `EXEC-DIAG-005` |
| FR-8 | `problemKey` is derived deterministically; identical failures collapse to one thread | `makeProblemKey` |
| FR-9 | Environment failures and external blockers do not consume the retry budget | `EXEC-DIAG-007/012` |
| FR-10 | At four meaningful attempts a non-blocking `RETRY_BUDGET_EXHAUSTED` gate opens and unrelated work continues | `EXEC-ESC-001` |
| FR-11 | Repairs are permitted only where `EXEC-REP-*` authorises them, and cite the classification | `EXEC-REP-002` |
| FR-12 | From the second attempt on one problem, the prior change is reverted rather than layered on | `EXEC-REP-003` |
| FR-13 | The agent does not ask permission for reversible in-boundary work | `EXEC-ESC-005` |
| FR-14 | The feed shows failure, diagnosis and repair as distinct rows with the structured evidence | UX v1.2 |

## 5. Data model

| Collection | Access | Fields of note |
|---|---|---|
| `migration_attempts` | C/W | `failure`, `diagnosis`, `problemKey`, `result` |
| `problem_threads` | C/W | `meaningfulAttempts`, `status` |
| `migration_changes` | C | `intent`, `testIntegrity`, `diffGcsUri` |
| `execution_runs` | C/W | `tests.failures`, `logGcsUri`, `logExcerpt` |
| `human_gates` | C | mid-migration gates |
| `migration_runs` | W | `metrics`, `checkpoint`, `stage` |

**Schema changes** — none.

## 6. Interfaces

**API** — `GET /projects/{id}/migration/attempts`, `GET /projects/{id}/diff`, `POST /projects/{id}/decisions/{gateId}`.

**Events emitted** — `PATCH_APPLIED`, `BUILD_STARTED/PASSED/FAILED`, `TEST_STARTED/PASSED/FAILED`, `FAILURE_DIAGNOSED`, `AUTONOMOUS_REPAIR_STARTED/COMPLETED`, `HUMAN_GATE_REQUIRED`.

**Agent involvement** — A3 (patch and repair), A4 (residual diagnosis). They never call each other; handoff is persisted state.

**Rules consumed** — `EXEC-DIAG-001..012`, `EXEC-REP-001..004`, `EXEC-ESC-001..010`.

## 7. Acceptance criteria

| ID | Criterion | Verified by |
|---|---|---|
| AC-1 | The partner-mock failure classifies as `MOCK_INCOMPATIBILITY` via `EXEC-DIAG-004` with no model call | test |
| AC-2 | The same failure across 20 runs yields one `problemKey` | test |
| AC-3 | Four meaningful attempts open a non-blocking gate; unrelated work proceeds | test |
| AC-4 | Ten consecutive Cloud Build timeouts leave `meaningfulAttempts` at 0 | test |
| AC-5 | A failing baseline invariant raises a gate and no test is modified | test |
| AC-6 | Killing the worker mid-loop resumes at the last checkpoint | test |
| AC-7 | A4 has no write tool | test |
| AC-8 | The reference scenario completes the loop with one autonomous repair and zero human actions | test |
| AC-9 | The feed shows FAIL → DIAGNOSIS → REPAIR → rebuild with the structured JSON | screen |

## 8. Risks and open questions

| # | Risk or question | Impact | Resolution or owner |
|---|---|---|---|
| 1 | Cloud Build round trip is minutes; the demo needs to feel live | Dead air on the WOW screen | Stream stage and step events during the build, not only at completion |
| 2 | The classifiers were written against expected failures | An unfamiliar failure goes to A4 every time | `EXEC-DIAG-008` makes unclassifiable a gate, not a guess. Measure the deterministic hit rate |
| 3 | A demo needs a failure that reliably happens | No WOW moment if the build passes first time | The mock's hardcoded RSA assertion guarantees it. Treat as a fixture requirement on the demo repo |
| 4 | `EXEC-REP-003` reverts from attempt 2 — could discard useful progress | Slower convergence | Deliberate: stacked partial fixes make the diff unreviewable and the next failure harder to classify |

## 9. Definition of done

- [ ] All FRs implemented
- [ ] All ACs verified
- [ ] Typecheck and tests pass
- [ ] §10 records what was actually built

## 10. Delivery log

| Date | Change | Why |
|---|---|---|

**Deviations from plan** —

**Deferred** —
