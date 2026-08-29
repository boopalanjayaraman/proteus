# PRD-12 · Build/Test Loop, Diagnosis & Repair

| | |
|---|---|
| **Increment** | 12 |
| **Status** | `DELIVERED` |
| **Depends on** | PRD-11 |
| **Unblocks** | PRD-13 |
| **Demoable outcome** | Watch the agent change code, build, hit a real integration failure, diagnose it, repair the mock, and retest — without being asked a single question. |
| **Created** | 2026-08-29 |
| **Delivered** | 2026-08-29 |

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

**Schema changes** — none. One ruleset addition: `EXEC-DIAG-013` (73 → 74 execution rules).

## 6. Interfaces

**API** — `GET /projects/{id}/migration/attempts`, `GET /projects/{id}/diff`, `POST /projects/{id}/decisions/{gateId}`.

**Events emitted** — `PATCH_APPLIED`, `BUILD_STARTED/PASSED/FAILED`, `TEST_STARTED/PASSED/FAILED`, `FAILURE_DIAGNOSED`, `AUTONOMOUS_REPAIR_STARTED/COMPLETED`, `HUMAN_GATE_REQUIRED`.

**Agent involvement** — A3 (patch and repair), A4 (residual diagnosis). They never call each other; handoff is persisted state.

**Rules consumed** — `EXEC-DIAG-001..012`, `EXEC-REP-001..004`, `EXEC-ESC-001..010`.

## 7. Acceptance criteria

| ID | Criterion | Verified by |
|---|---|---|
| AC-1 | The partner-mock failure classifies as `MOCK_INCOMPATIBILITY` via `EXEC-DIAG-004` with no model call | test |
| AC-2 | The same failure across 20 runs yields one `problemKey`; genuinely different failures stay apart | test |
| AC-3 | Four meaningful attempts open a non-blocking gate; unrelated work proceeds | test |
| AC-4 | Ten consecutive infrastructure failures leave `meaningfulAttempts` at 0 | test |
| AC-5 | A failing baseline invariant raises a gate and no test is modified | test |
| AC-6 | Every iteration writes the plan item it was on, so a restart resumes there rather than replaying the run | test |
| AC-7 | A4 has no write tool | test |
| AC-8 | The reference scenario completes the loop with one autonomous repair and zero human actions | test |
| AC-9 | The feed shows FAIL → DIAGNOSIS → REPAIR → retest with the structured JSON, and the `n / 4` counter | screen · test |

## 8. Risks and open questions

| # | Risk or question | Impact | Resolution or owner |
|---|---|---|---|
| 1 | Cloud Build round trip is minutes; the demo needs to feel live | Dead air on the WOW screen | Stream stage and step events during the build, not only at completion |
| 2 | The classifiers were written against expected failures | An unfamiliar failure goes to A4 every time | `EXEC-DIAG-008` makes unclassifiable a gate, not a guess. Measure the deterministic hit rate |
| 3 | A demo needs a failure that reliably happens | No WOW moment if the build passes first time | The mock's hardcoded RSA assertion guarantees it. Treat as a fixture requirement on the demo repo |
| 4 | `EXEC-REP-003` reverts from attempt 2 — could discard useful progress | Slower convergence | Deliberate: stacked partial fixes make the diff unreviewable and the next failure harder to classify |

## 9. Definition of done

- [x] All FRs implemented
- [x] All ACs verified
- [x] Typecheck and tests pass
- [x] §10 records what was actually built

## 10. Delivery log

| Date | Change | Why |
|---|---|---|
| 2026-08-29 | `engine/rulesets/migration-execution-rules.yaml` — `EXEC-DIAG-013`; `core/rules/precedence.ts` | A failing EXPECTED_TO_CHANGE invariant had no classifier. See deviation 1 — without it the fixture's second rigged failure ends the demo with a human action |
| 2026-08-29 | `core/migration/failures.ts` — `structureFailure`, `relevantLines`, `phaseOf`, `failureJson` | Spec §33. Bounded to 20 lines, chosen by weighted relevance, re-sorted into log order. The phase comes from which reports failed, because `mvn verify` runs both plugins in one command |
| 2026-08-29 | `core/migration/diagnosis.ts` — `factsForFailure`, `classifyDeterministically`, `touchedInvariant`, `authoriseRepair`, `unclassified` | `EXEC-DIAG-001`. Twelve classifiers run before any model call, and the repair authorisation rules — not the model — decide what may be done |
| 2026-08-29 | `core/migration/problems.ts` — `recordAttempt`, `MAX_MEANINGFUL_AUTONOMOUS_ATTEMPTS`, `resolveThread` | The budget, in a document rather than in the loop's memory, because a budget that resets on eviction is not a budget |
| 2026-08-29 | `core/migration/gates.ts` — `openGate`, `BLOCKING`, the three gate builders | Mid-migration gates in the same `HumanGate` shape PRD-10 established, resolved through the same endpoint. `blocking` is the field that keeps spec §30's "continue with unrelated work" true |
| 2026-08-29 | `agent/flows/migration.ts` + `prompts/migration.ts` — A3's patching and repair roles | Whole files rather than diffs: a model-authored hunk that fails to apply is indistinguishable from a refused change |
| 2026-08-29 | `agent/flows/diagnosis.ts` + `prompts/diagnosis.ts` — A4 | Read-only, and not shown A3's authoring transcript. Its independence is partly what it is not told |
| 2026-08-29 | `agent/tools/registry.ts` — `DIAGNOSTIC_TOOL_NAMES`, `MIGRATION_TOOL_NAMES`, `PatchInput`, `RepairInput`, `DiagnosisInput` | A4 holding no write tool is what makes the anti-cheating split structural rather than a prompt instruction |
| 2026-08-29 | `worker/migrationLoop.ts` — `runMigrationLoop`, `assertWithinScope`, `PatchRefused` | The loop, in the orchestrator. Checkpointed per plan item, bounded by the budget, continued on a tool fact |
| 2026-08-29 | `api/routes/migration.ts` — `GET /migration/attempts`, `GET /diff` | The attempt history with its structured failures and diagnoses, and the branch diff |
| 2026-08-29 | `components/activity/ActivityFeed.tsx`, `lib/migration.ts`, `screens/migration/Migration.tsx`, `styles/migration.css` | FAIL/DIAGNOSIS/REPAIR rows with the JSON verbatim, the `n / 4` retry panel, live stat tiles |
| 2026-08-29 | `test/loop.test.ts` (31 backend), `test/migration.test.ts` (+4 frontend) | Every AC, including the reference scenario end to end against a real git repo |

**Deviations from plan** —

1. **A rule was added: `EXEC-DIAG-013`.** `EXEC-DIAG-005` covers a failing MUST_PRESERVE
   invariant — a regression, and a gate. Nothing covered a failing EXPECTED_TO_CHANGE
   one, which is the migration *working*: RSA-2048 wraps a session key to 256 bytes and
   ML-KEM-768 produces 1088, so `assertEquals(256, wrapped.length)` must fail once the
   change lands. Without the rule that failure matched no classifier, fell to A4, and —
   being unresolvable with confidence — became `EXEC-DIAG-008`'s gate. The run would have
   ended with a human engineering action for the one outcome the baseline explicitly
   predicted, which is precisely the number `fixtures/README.md` says the demo turns on.
   `MODIFY_SOURCE` stays prohibited under it: the assertion is updated to the observed
   value, the implementation is not adjusted to make the old value true again.

2. **`EXEC-DIAG-001` is skipped when selecting a classification.** It matches every
   failure — its `when` is `failurePresent: true` — and carries no verdict, because it is
   the procedural rule saying *classify deterministically first*. Taking the first
   precedence match would therefore return it every time and `EXEC-DIAG-008`'s gate would
   never be reached. Both `classifyDeterministically` and `unclassified` filter to
   outcomes that actually name a classification.

3. **The loop has an iteration ceiling as well as a retry budget.** They bound different
   things: the budget bounds attempts against *one* problem, and a pathological run that
   produces a different problem every iteration would never reach it. The ceiling is
   `4 × MAX_MEANINGFUL_AUTONOMOUS_ATTEMPTS` and exists only so the loop terminates.

4. **A model or transport error is not reported as a guardrail refusal.** Both stop the
   plan item and both open a gate, but they mean opposite things — one is the system
   working as designed, the other is a failure of the run. `PatchRefused` separates them
   and the gate says which happened.

5. **A4's answer is refused on three grounds, not one.** `EXEC-DIAG-008` names low
   confidence. The loop also refuses to act when A4 says the cause is outside the
   migration branch, or that fixing it would change a required behaviour — both are
   decisions rather than repairs, and acting on either would route around the gate that
   should have caught it.

6. **`GET /projects/{id}/migration/attempts` returns problem threads alongside attempts.**
   The `n / 4` counter is per problem, and a screen given only attempts would have to
   reconstruct the grouping — badly, since `problemKey` normalisation is the whole point.

**Found while building** —

**Two copies of the legacy-algorithm pattern had diverged, and `EXEC-DIAG-004` silently
stopped matching.** The classifier's expression listed `RSA_PUBLIC_KEY` explicitly; the
loop's file-scanning copy did not. `\bRSA\b` does not match inside `RSA_PUBLIC_KEY`
because `_` is a word character, so the scan never ran, `referencingFiles` was never
populated, and the demo's own failure fell through to the model instead of classifying
deterministically — AC-1, failing quietly. There is now one exported constant. The
end-to-end test is what caught it; none of the unit tests could have, because they supply
the context directly.

**The invariant literal fallback did not survive Surefire's spacing.** `touchedInvariant`
matches an assertion by the literal it pins, because Surefire reports
`expected: <256> but was: <1088>` and never the source line. The pattern omitted the space
after the colon, so every real report missed and only tests that happened to include the
raw assertion in `relevantLogs` passed.

**Deferred** —

- **Verification and the sandbox.** PRD-13. The loop calls `onChangesApplied` when every
  plan item is green; nothing supplies it yet, and `EXEC-REP-004` already gates deployment
  on a verification verdict that does not exist.
- **`EXEC-DIAG-006` (coverage gap) is not reached from the loop.** It is a
  `ASSESSING_TEST_COVERAGE` rule and PRD-11 resolves coverage before any source change, so
  by the time the loop runs the gap is closed. The fact is plumbed but never set.
- **`EXEC-ESC-002/004/006/008` are not raised from the loop.** They fire on judgments the
  agent reaches about what a change *would require* — an external protocol change, a
  security reduction, a business-behaviour change, access outside the boundary. A4 can
  reach the second and third of those and the loop refuses to repair when it does, but
  they are recorded as an unclassified gate rather than the specific one. Verification is
  where these become checkable, which is PRD-13.
- **`EXEC-DIAG-012` raises no `Recommendation` document.** The classification is correct,
  the failure is exempted from the budget, and the item is reported — but the
  recommendation with an owner that `RAISE_RECOMMENDATION` calls for is not written.
  PRD-14 assembles the report that carries recommendations forward.
- **Streaming during a build.** Risk 1: a Cloud Build round trip is minutes and the feed
  goes quiet. Events are emitted at the start and end of each execution, not during. With
  `ProcessExecutor` running locally the gap is seconds — measured at 7s for the reference
  fixture's suite with a warm cache — so it is not felt today. It becomes real with the
  Cloud Build submission client. Both that client and the streaming land in PRD-16.
- **The revert is recorded, not performed.** `EXEC-REP-003` marks the superseded change
  `REVERTED` and the agent is told what was already tried, so the next attempt differs.
  A `git revert` commit is not issued — the subsequent patch overwrites the same files,
  which reaches the same tree with a shorter history.
