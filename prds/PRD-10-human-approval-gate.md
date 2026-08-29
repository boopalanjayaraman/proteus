# PRD-10 · Human Approval Gate

| | |
|---|---|
| **Increment** | 10 |
| **Status** | `PLANNED` |
| **Depends on** | PRD-09 |
| **Unblocks** | PRD-11 |
| **Demoable outcome** | Approve the migration once, see exactly what you authorised, and watch the stage move to MIGRATING with a migration run created. |
| **Created** | 2026-08-29 |
| **Delivered** | |

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
| UX design | v1.2 — approval CTA, confirmation modal with the 14-item disclosure, LOGGED TO AUDIT TRAIL |
| Data model | §3.14 human gates · §3.10 migration runs — `approval` |
| Architecture | §15 HITL boundary · §16 migration authorisation |

## 3. Scope

**In**
- Approval modelled as a `HumanGate` of type `MIGRATION_APPROVAL`
- The 14-item disclosure, acknowledged and persisted
- Approval pins `assessmentId` **and** `assessmentVersion`
- `MigrationRun` created with branch name, lease and checkpoint
- Stage transition `AWAITING_APPROVAL` → `MIGRATING`, guarded
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
| FR-2 | The modal lists all 14 disclosed actions verbatim before the user can confirm | Spec §20 |
| FR-3 | `acknowledgedActions` persists what was shown, so consent is auditable | Data model §3.10 |
| FR-4 | Approval records `assessmentId` and `assessmentVersion`; a superseded assessment cannot be approved | Data model §3.10 |
| FR-5 | Approving creates exactly one `MigrationRun`; a double click cannot create two | Data model §3.10 |
| FR-6 | The stage transition is guarded on expected stage and `version` | Data model §3.2 |
| FR-7 | Approval names the plan items authorised; unapproved items are excluded from execution | Spec §20 |
| FR-8 | `summary.autonomy.approvals` increments; `humanEngineeringActions` does not | Data model §3.2 |
| FR-9 | Before approval no branch exists and no write tool is reachable | Spec §6 |
| FR-10 | Cancelling leaves the project in `AWAITING_APPROVAL` with no side effect | UX v1.2 |

## 5. Data model

| Collection | Access | Fields of note |
|---|---|---|
| `human_gates` | C/W | `type: MIGRATION_APPROVAL`, `resolution` |
| `migration_runs` | C | `approval`, `branch.name`, `lease`, `checkpoint` |
| `assessments` | W | `status: APPROVED`, `planItems[].approved` |
| `projects` | W | `stage`, `current.approvedAssessmentId`, `summary.autonomy` |

**Schema changes** — none.

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
| AC-3 | `acknowledgedActions` contains all 14 items after confirmation | test |
| AC-4 | Cancelling leaves stage, gate and run untouched | test |
| AC-5 | After approval, stage is `MIGRATING` and a run exists with a lease | test |
| AC-6 | `approvals` is 1 and `humanEngineeringActions` is 0 | test |
| AC-7 | The modal shows the 14 items and the untouched-systems statement | screen |
| AC-8 | The approval is visible in the audit trail with actor and timestamp | screen |

## 8. Risks and open questions

| # | Risk or question | Impact | Resolution or owner |
|---|---|---|---|
| 1 | Partial approval is modelled but not in the UX | Dead capability or a surprise later | Schema supports `approvedPlanItemIds`; UI approves all autonomous items. Keep the field |
| 2 | Time between approval and execution — could the assessment change? | Approved scope drifts from executed scope | The pinned version makes drift detectable; `EXEC-VER-001` checks the diff against it |
| 3 | The disclosure is prose in the spec, shown as a list | Wording could drift from behaviour | Store the 14 items as data, referenced by both modal and audit record |

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
