# PRD-09 · Assessment, Plan & Recommendations

| | |
|---|---|
| **Increment** | 09 |
| **Status** | `PLANNED` |
| **Depends on** | PRD-01, PRD-08 |
| **Unblocks** | PRD-10 |
| **Demoable outcome** | Open the assessment: seven findings with evidence and agent intent, a five-item plan, three recommendations with owners, and a downloadable report. |
| **Created** | 2026-08-29 |
| **Delivered** | |

---

## 1. Problem

Screen 3 must answer four questions — what exists, what is vulnerable, what the agent will
change, and what it will not. It is also the last point before the human is asked to
authorise autonomous work, so what it shows has to be exactly what will happen.

## 2. Sources of truth

| Source | Reference |
|---|---|
| Product spec | §14 assessment · §15 findings · §16 evidence · §17 plan · §18 disposition · §19 report |
| UX design | v1.2 — Assessment: stat tiles, finding cards with snippet and AGENT INTENT, PROPOSED MIGRATION PLAN, RECOMMENDATIONS with owner |
| Data model | §3.8 assessments · §3.9 recommendations |
| Agent architecture | §2 A2 — no repository access |
| Rulesets | `EXEC-DISP-001..009` · `PROHIB-001` · `MIGRATION_TARGET`, `PARAMETER_SELECTION` |

## 3. Scope

**In**
- A2 Assessment Agent, reading persisted state only
- Dispositions assigned by rules before A2 composes
- Immutable versioned `Assessment` with a frozen snapshot
- Plan items with `mode` and `expectedChanges`
- Recommendations with disposition, subtype, action and owner
- Finding cards: `summaryLine`, evidence, snippet, `agentIntent`
- Assessment report as a downloadable artifact
- Stage → `AWAITING_APPROVAL`

**Out**
- The approval action → PRD-10
- Executing the plan → PRD-11
- Migration report → PRD-14

---

## 4. Functional requirements

| ID | Requirement | Source |
|---|---|---|
| FR-1 | A2 has no repository tools; it composes only from persisted state | Agent arch §2 |
| FR-2 | Dispositions come from `EXEC-DISP-*`; A2 cannot promote a finding to `AUTONOMOUS_MIGRATION` | Agent arch §7 |
| FR-3 | `PROHIB-001` suppresses signature findings from the plan regardless of model output | Rulesets |
| FR-4 | An assessment is immutable; regeneration produces version N+1 | Data model §3.8 |
| FR-5 | `snapshot` freezes finding, node, edge, recommendation and file ids plus the commit | Data model §3.8 |
| FR-6 | Each plan item carries `mode` and `expectedChanges` — the autonomy contract PRD-13 verifies against | Data model §3.8 |
| FR-7 | Each recommendation carries disposition, subtype, action, owner and a source citation | UX v1.2 |
| FR-8 | Every finding card shows its evidence, and repository evidence is clickable to the source | Spec §16 |
| FR-9 | `agentIntent` is shown for every finding, including those dispositioned `NO_CHANGE_REQUIRED` | Data model §3.6 |
| FR-10 | The report contains everything spec §19 requires and renders from `contentSnapshot` | Spec §19 |
| FR-11 | Stat tiles show findings, autonomous items, recommendations and approvals | UX v1.2 |

## 5. Data model

| Collection | Access | Fields of note |
|---|---|---|
| `assessments` | C/R | `version`, `snapshot`, `planItems`, `status` |
| `recommendations` | C/R | `disposition`, `subtype`, `owner`, `action` |
| `findings` | R/W | `disposition`, `agentIntent`, `status: PLANNED` |
| `artifacts` | C | `ASSESSMENT_REPORT` |
| `projects` | W | `stage`, `current.assessmentId`, `summary` |

**Schema changes** — none.

## 6. Interfaces

**API** — `POST /projects/{id}/assessment` (generate), `GET /projects/{id}/assessment`, `GET /projects/{id}/recommendations`, `GET /projects/{id}/artifacts/{artifactId}`.

**Events emitted** — `ASSESSMENT_COMPLETED` (MILESTONE), `RECOMMENDATION_RAISED` (ACTIVITY).

**Agent involvement** — A2. Tools: `get_findings`, `get_graph`, `get_evidence`, `get_policy`, `compose_plan_item`, `write_assessment`, `raise_recommendation`.

**Rules consumed** — `EXEC-DISP-001..009` (pre-model), `MIGRATION_TARGET`, `PARAMETER_SELECTION`, `PROHIB-001..003`.

## 7. Acceptance criteria

| ID | Criterion | Verified by |
|---|---|---|
| AC-1 | A2's tool registry contains no repository tool | test |
| AC-2 | The reference scenario yields the seven findings with the dispositions the UX shows | test |
| AC-3 | Exactly two findings reach `AUTONOMOUS_MIGRATION` | test |
| AC-4 | Three recommendations, distinct dispositions and subtypes, each with an owner | test |
| AC-5 | Regenerating produces version 2 and leaves version 1 byte-identical | test |
| AC-6 | Every autonomous plan item has non-empty `expectedChanges` | test |
| AC-7 | A repository evidence citation opens the source at the right line | screen |
| AC-8 | The downloaded report contains all of spec §19's sections | test |
| AC-9 | Stage is `AWAITING_APPROVAL` with the approval CTA enabled | screen |

## 8. Risks and open questions

| # | Risk or question | Impact | Resolution or owner |
|---|---|---|---|
| 1 | A2 could compose a plan item for a finding the rules dispositioned out of scope | Approval of work that must not happen | Validate every plan item against its findings' dispositions before persisting; reject, do not correct |
| 2 | `expectedChanges` is a model prediction of files it has not yet edited | Over- or under-broad scope, checked later by `EXEC-VER-001` | Path patterns rather than exact files; a scope breach raises a gate, not a silent pass |
| 3 | Report rendering not yet chosen | Format risk | Markdown → PDF; `contentSnapshot` makes it reproducible either way |
| 4 | Recommendation owners are role strings, not a directory | Cannot assign to a person | Deliberate (data model §3.9) — the prototype has no directory |

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
