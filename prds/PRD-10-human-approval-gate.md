# PRD-10 · Human Approval Gate

| | |
|---|---|
| **Increment** | 10 |
| **Status** | `DELIVERED` |
| **Depends on** | PRD-09 |
| **Unblocks** | PRD-11 |
| **Demoable outcome** | Approve the migration once, see exactly what you authorised, and watch the stage move to MIGRATING with a migration run created. |
| **Created** | 2026-08-29 |
| **Delivered** | 2026-08-29 |

---

## 1. Problem

This is the hinge of the whole product: one approval converts a read-only analyser into
an agent authorised to modify code. What is approved has to be a specific scope rather
than a general instruction, and the record of what was approved has to survive long
enough to audit the migration against it.

## 2. Sources of truth

| Source | Reference |
|---|---|
| Product spec | §20 human migration approval · §30 human gates · §22 stages |
| UX design | v1.2 — approval CTA, confirmation modal with the disclosure list, LOGGED TO AUDIT TRAIL |
| Data model | §3.14 human gates · §3.10 migration runs — `approval` |
| Architecture | §15 HITL boundary · §16 migration authorisation |

## 3. Scope

**In**
- Approval modelled as a `HumanGate` of type `MIGRATION_APPROVAL`
- The disclosure, acknowledged and persisted
- Approval pins `assessmentId` **and** `assessmentVersion`
- `MigrationRun` created with branch name, lease and checkpoint
- Stage transition to `MIGRATING`, guarded, from either approvable stage (§11 amendment)
- Assessment status → `APPROVED`; plan items marked approved
- Confirmation modal per UX v1.2

**Out**
- Anything the migration then does → PRD-11
- Mid-migration gates → PRD-12

---

## 4. Functional requirements

| ID | Requirement | Source |
|---|---|---|
| FR-1 | Approval is a `HumanGate`, so it shares one component, endpoint and audit shape with every later gate | Data model §3.14 |
| FR-2 | The modal lists every disclosed action verbatim before the user can confirm | Spec §20 |
| FR-3 | `acknowledgedActions` persists what was shown, so consent is auditable | Data model §3.10 |
| FR-4 | Approval records `assessmentId` and `assessmentVersion`; a superseded assessment cannot be approved | Data model §3.10 |
| FR-5 | Approving creates exactly one `MigrationRun`; a double click cannot create two | Data model §3.10 |
| FR-6 | The stage transition is guarded on expected stage and `version` | Data model §3.2 |
| FR-7 | Approval names the plan items authorised; unapproved items are excluded from execution | Spec §20 |
| FR-8 | `summary.autonomy.approvals` increments; `humanEngineeringActions` does not | Data model §3.2 |
| FR-9 | Before approval no branch exists and no write tool is reachable | Spec §6 |
| FR-10 | Cancelling leaves the project in its approvable stage with no side effect | UX v1.2 |

## 5. Data model

| Collection | Access | Fields of note |
|---|---|---|
| `human_gates` | C/W | `type: MIGRATION_APPROVAL`, `resolution` |
| `migration_runs` | C | `approval`, `branch.name`, `lease`, `checkpoint` |
| `assessments` | W | `status: APPROVED`, `planItems[].approved` |
| `projects` | W | `stage`, `current.approvedAssessmentId`, `summary.autonomy` |

**Schema changes** — no collection changed. `schema/src/migration.ts` gained the disclosure constants (`MIGRATION_DISCLOSURE`, `MIGRATION_DISCLOSURE_TEXT`, `MIGRATION_UNTOUCHED_STATEMENT`, the two option ids). `ApproveMigrationInput` and `PlanItem.approved` already existed.

## 6. Interfaces

**API** — `POST /projects/{id}/migration/approve`, `POST /projects/{id}/decisions/{gateId}`, `GET /projects/{id}/gates`.

**Events emitted** — `HUMAN_GATE_REQUIRED` (MILESTONE) when the assessment is ready, `MIGRATION_APPROVED` (MILESTONE), `HUMAN_GATE_RESOLVED` (ACTIVITY).

**Agent involvement** — none. A human decision, recorded deterministically.

**Rules consumed** — none directly; `AUTONOMOUS_PLAN_MODES` determines which items are executable.

## 7. Acceptance criteria

| ID | Criterion | Verified by |
|---|---|---|
| AC-1 | Two concurrent approvals create one migration run | test |
| AC-2 | Approving a superseded assessment version is refused | test |
| AC-3 | `acknowledgedActions` contains every disclosed action after confirmation, and an acknowledgement that is not the current disclosure is refused | test |
| AC-4 | Cancelling leaves stage, gate and run untouched | test |
| AC-5 | After approval, stage is `MIGRATING` and a run exists with a lease | test |
| AC-6 | `approvals` is 1 and `humanEngineeringActions` is 0 | test |
| AC-7 | The modal shows every disclosed action and the untouched-systems statement | screen · test |
| AC-8 | The approval is visible in the audit trail with actor and timestamp | screen |

## 8. Risks and open questions

| # | Risk or question | Impact | Resolution or owner |
|---|---|---|---|
| 1 | Partial approval is modelled but not in the UX | Dead capability or a surprise later | Schema supports `approvedPlanItemIds`; UI approves all autonomous items. Keep the field |
| 2 | Time between approval and execution — could the assessment change? | Approved scope drifts from executed scope | The pinned version makes drift detectable; `EXEC-VER-001` checks the diff against it |
| 3 | The disclosure is prose in the spec, shown as a list | Wording could drift from behaviour | Stored as data in `@proteus/schema`, imported by the modal and copied onto the gate. Each item names the `MigrationStage`s it covers, and a test fails if a stage is undisclosed |

## 9. Definition of done

- [x] All FRs implemented
- [x] All ACs verified
- [x] Typecheck and tests pass
- [x] §10 records what was actually built

## 10. Delivery log

| Date | Change | Why |
|---|---|---|
| 2026-08-29 | `schema/src/migration.ts` — `MIGRATION_DISCLOSURE` (17 items, each naming the migration stages it covers), `MIGRATION_DISCLOSURE_TEXT`, `MIGRATION_UNTOUCHED_STATEMENT`, `APPROVE_OPTION_ID`/`DECLINE_OPTION_ID` | Risk 3. One definition, imported by the modal and copied onto the gate, so consent and its record cannot disagree |
| 2026-08-29 | `core/services/approval.ts` — `ApprovalService` (`openApprovalGate`, `gates`, `approve`), `ApprovalError`, `branchNameFor` | The whole increment. Pure `core/`: a human decision recorded deterministically, with no model anywhere near it |
| 2026-08-29 | `api/routes/migration.ts` — `GET /gates`, `GET /migration`, `POST /migration/approve`, `POST /decisions/:gateId` | FR-1. Both endpoints funnel to one service method, so the up-front approval and every later gate share one shape |
| 2026-08-29 | `worker/assessmentJob.ts` — opens the gate on reaching `AWAITING_APPROVAL` | The gate is the product stopping to ask, and it should exist the moment there is something to ask about |
| 2026-08-29 | `api/routes/assessment.ts` + `core/services/assessment.ts` — regeneration refused once an assessment is approved | Not in the plan. Found while tracing FR-4: regeneration marks its predecessor `SUPERSEDED`, which would have severed the link between the approved scope and the running migration |
| 2026-08-29 | `frontend/lib/approval.ts`, `components/approval/ApproveModal.tsx`, `screens/assessment/Assessment.tsx`, `api/client.ts`, `styles/assessment.css` | The approve bar's button is live; the modal renders the disclosure, the authorised scope and the boundary statement |
| 2026-08-29 | `test/approval.test.ts` (25 backend), `test/approval.test.ts` (10 frontend), one architecture test | All eight ACs, plus the concurrency and idempotency properties FR-5 needs |

**Deviations from plan** —

1. **The disclosure is 17 items, not 14.** Spec §20 lists sixteen bullets; the UX v1.2
   modal lists fourteen. They are not the same fourteen — the mock drops "validate the
   existing tests", "rebuild and retest" and "provide a link to the sandbox-deployed
   application", and adds end-to-end verification, which §20 omits but §22 has as a
   stage. The disclosure exists to obtain consent, so under-disclosing is the only
   failure that matters and the union is the correct list. AC-3, AC-7 and FR-2 were
   restated to assert the property rather than the mock's count.

2. **Each disclosure item names the stages it covers.** Risk 3 asked for the list to be
   stored as data. Storing the mapping as well turns "the wording matches the behaviour"
   into an assertion: a test fails if any `MigrationStage` is not disclosed by something
   in the list, so adding a stage in PRD-11 or PRD-13 without telling the user is a
   build failure rather than an oversight.

3. **The run is inserted before the stage moves, not after.** FR-5 and FR-6 can be
   satisfied in either order, and the order decides what a crash leaves behind.
   Transitioning first would allow a project in `MIGRATING` with no run — visible,
   broken, and only fixable by hand. Inserting first means the unique index on
   `migrationRunId` is the mutex, and a crash leaves a run that a retried approval finds
   and completes. The deterministic id `mig_{projectId}_v{version}` is what makes that
   retry idempotent rather than duplicative.

4. **A repeated approval answers 200, not 409.** Clicking twice is not an error; it is
   the same approval. The response carries `created: false` so a caller can tell the
   difference. A genuinely concurrent second request may still lose the guarded
   transition and get 409 — both outcomes are correct and the test accepts either.

5. **The run is leased at creation.** The PRD lists the lease as part of the run, and it
   would have been simpler to let PRD-11's worker take it. But an unleased run in
   `RUNNING` is indistinguishable from one whose worker died, and the reaper would start
   a second migration on it.

6. **`GET /projects/{id}/migration` was added.** Not in §6, but named in spec §44 and
   needed to assert FR-9 — that no run exists before approval — from outside the process.

7. **`approved` is written on every plan item, true and false.** An unapproved item that
   simply lacks the field is indistinguishable from one written before the field existed,
   and execution has to be able to tell.

**Found while building** —

**A committed `.js` file was shadowing every schema source file.** `schema/src/` held
compiled output beside each `.ts`, committed in PRD-08. Vite resolves `.js` first, so the
whole repository — tests included — had been importing build artefacts that were correct
only when someone had recently re-run `tsc`. The new disclosure export was `undefined` at
runtime until they were deleted. Removed, gitignored, and guarded by an architecture test,
because the failure mode is silent: the suite goes green either way. Recorded as TD-013.

**Amendment — 2026-08-30: approval is offered from either approvable stage**

FR-2 and the service both required `stage === 'AWAITING_APPROVAL'`, which the assessment
job sets in the same breath as opening the gate. When an unrelated failure stopped that job
two lines earlier — a blob write the gate does not depend on — the project stayed at
`ASSESSMENT_READY`: assessment complete, findings written, plan proposed, and **no way for a
human to authorise any of it.** The one control the product gives the user had disappeared,
and nothing on the screen said why.

That is the wrong shape for this increment's own claim. The migration is always a human
decision, so the offer has to follow the *assessment*, not a bookkeeping transition that can
fail independently of it.

- `APPROVABLE_STAGES` (`schema/src/migration.ts`) names both `ASSESSMENT_READY` and
  `AWAITING_APPROVAL`. Both mean the same thing to the person looking at the screen.
- `ApprovalService.approve` accepts either, and `advanceProject` transitions from whichever
  stage the project was actually in rather than a hardcoded one.
- `approvalAvailability` (frontend) decides whether the bar appears, replacing an inline
  stage comparison in the screen.
- The gate is opened and resolved in the same breath when one does not exist — behaviour
  `resolveGate` already had, and which this change finally reaches.
- Discovery now navigates to the assessment on the *transition* to complete, never on
  arrival: a finished project has `discoveryComplete` true from the first render, and
  navigating on that would make the graph unreachable.

Four backend and four frontend tests, including one that reproduces the exact state the
blob failure left behind — `ASSESSMENT_READY` with the gate deleted — and asserts the
approval still succeeds and still records consent.

**Amendment — 2026-08-30: retrying an approved migration**

A failed run left two ways forward: fix the branch by hand, or start again from discovery.
Starting again regenerates a plan the user already approved and supersedes the assessment
their approval pinned — which invalidates the one human decision this increment exists to
record.

`POST /projects/:id/migration/retry` repeats the **execution** of that decision, not the
decision. It abandons the stalled run, creates a new one from the same approved assessment
and the same approved plan items, and carries `approvedBy` and `approvedAt` forward
unchanged — the human decided once.

- The previous run is marked `ABANDONED`, never overwritten: a run is the record of an
  attempt, and a failed attempt is exactly what an evidence package needs to show.
- Run ids gain an attempt suffix — `mig_PQC-0006_v1`, then `_r2` — so they stay unique
  and readable.
- Refused while a worker still holds the previous run, naming the holder.
- **Requires `current.approvedAssessmentId`, with no fallback to `current.assessmentId`.**
  A test caught the fallback: it would have let a retry execute a plan nobody authorised.

Offered on the migration screen's blocker panel, which is where a person is already being
told what went wrong.

**Deferred** —

- **The migration screen is still a placeholder.** Approval navigates to
  `/projects/:id/migration`, which PRD-11 fills in. Until then the hand-off lands on the
  placeholder, and the assessment screen keeps a "Migration approved" bar with a link.
- **`startMigration` is wired but unsupplied.** `buildServer` accepts the callback and the
  approve route calls it; `server.ts` passes nothing yet. PRD-11 supplies it.
- **Partial approval has no UI.** The schema, the service and the tests all support
  `approvedPlanItemIds`, and naming a non-autonomous item is refused rather than dropped.
  The modal approves every autonomous item, as the UX does (Risk 1 — the field stays).
- **Declining does not close the gate.** `POST /decisions/:gateId` with `DECLINE` is
  accepted for a non-approval gate, but the modal's Cancel makes no request at all, which
  is what FR-10 requires. A deliberate decline that records "no" is not yet a UI.
