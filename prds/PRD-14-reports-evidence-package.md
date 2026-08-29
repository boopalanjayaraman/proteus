# PRD-14 · Reports & Evidence Package

| | |
|---|---|
| **Increment** | 14 |
| **Status** | `PLANNED` |
| **Depends on** | PRD-13 |
| **Unblocks** | — final increment |
| **Demoable outcome** | Download a migration report, the git diff and the build evidence; the three recommendations raised at assessment are still there, with their owners. |
| **Created** | 2026-08-29 |
| **Delivered** | |

---

## 1. Problem

The evidence package is a deliverable, not a by-product. It is the artefact that lets
someone who watched none of this decide whether to trust it — and the place where the
items the agent deliberately did *not* touch must survive, rather than quietly
disappearing because the migration succeeded.

## 2. Sources of truth

| Source | Reference |
|---|---|
| Product spec | §19 assessment report · §38 activity vs audit · §39 audit trail · §40 migration report |
| UX design | v1.2 — Sandbox & Report: outcome tiles, CRYPTO VERIFICATION, EVIDENCE PACKAGE (4 artifacts), RECOMMENDATIONS carried forward |
| Data model | §3.20 artifacts · §3.19 agent actions |
| Rulesets | `EXEC-VER-013` |

## 3. Scope

**In**
- Migration report covering every section of spec §40
- Git diff artifact with commits, files and line counts
- Build and test evidence bundle across all Cloud Build attempts
- `displayMeta` and structured `stats` per artifact
- Recommendations carried forward from the assessment with owners intact
- Outcome tiles from `summary.autonomy`
- Final outcome: `VERIFIED` / `PARTIALLY_MIGRATED` / `HUMAN_ACTION_REQUIRED`
- Rotation-reminder sweep for credentials past `rotationDueAt`

**Out**
- Nothing. This is the last increment; anything not here is out of MVP scope.

---

## 4. Functional requirements

| ID | Requirement | Source |
|---|---|---|
| FR-1 | The migration report contains every section spec §40 lists | Spec §40 |
| FR-2 | Four artifacts are produced: migration report, assessment report, git diff, build/test evidence | UX v1.2 |
| FR-3 | Each artifact carries `displayMeta` and structured `stats` | Data model §3.20 |
| FR-4 | Artifacts reference `baselineId`, `approvedAssessmentId`, `verificationResultId`, `sandboxDeploymentId` | `EXEC-VER-013` |
| FR-5 | Open recommendations are carried forward with disposition, subtype, action and owner | `EXEC-VER-013` |
| FR-6 | The report renders from `contentSnapshot`, so it is reproducible | Data model §3.20 |
| FR-7 | The autonomous-recovery section shows failures, diagnoses, actions and retry counts | Spec §40 |
| FR-8 | The security section separates residual legacy crypto from verified PQC, with the NOTED items | Spec §40 |
| FR-9 | Outcome tiles show autonomous completion, human engineering actions, repairs and recommendations | UX v1.2 |
| FR-10 | No artifact contains a GitHub token; `redactTokens` runs before write | Data model rule 8 |
| FR-11 | Projects past `rotationDueAt` emit `CREDENTIAL_ROTATION_DUE` | PRD-05 risk 4 |

## 5. Data model

| Collection | Access | Fields of note |
|---|---|---|
| `artifacts` | C/R | `kind`, `displayMeta`, `stats`, `contentSnapshot` |
| `recommendations` | R | carried forward |
| `agent_actions` | R | audit trail for the recovery section |
| `verification_results`, `baselines`, `migration_changes`, `execution_runs` | R | report content |
| `projects` | W | `stage: COMPLETED`, `summary.latestArtifactId` |

**Schema changes** — none.

## 6. Interfaces

**API** — `POST /projects/{id}/report`, `GET /projects/{id}/artifacts`, `GET /projects/{id}/artifacts/{artifactId}`, `GET /projects/{id}/diff`.

**Events emitted** — `MIGRATION_COMPLETED` (MILESTONE), `CREDENTIAL_ROTATION_DUE` (ACTIVITY).

**Agent involvement** — a **flow**, not an agent: one model call over persisted state for the narrative sections, no tools and no loop.

**Rules consumed** — `EXEC-VER-013`.

## 7. Acceptance criteria

| ID | Criterion | Verified by |
|---|---|---|
| AC-1 | The migration report contains all of spec §40's sections | test |
| AC-2 | Four artifacts are downloadable with correct `displayMeta` | screen |
| AC-3 | All three recommendations appear on the completion screen with their owners | screen |
| AC-4 | No artifact contains a token-shaped string | test |
| AC-5 | The recovery section records one repair and the retry count | test |
| AC-6 | The security section shows ML-KEM-768 verified, two signature usages unchanged, the certificate NOTED | test |
| AC-7 | Outcome tiles read 100%, 0 human engineering actions, 1 repair, 3 recommendations | screen |
| AC-8 | Regenerating from the same `contentSnapshot` produces an identical report | test |
| AC-9 | A project past `rotationDueAt` emits the reminder once | test |

## 8. Risks and open questions

| # | Risk or question | Impact | Resolution or owner |
|---|---|---|---|
| 1 | PDF rendering toolchain not chosen | Format risk late in the build | Markdown first, PDF as a render step; `contentSnapshot` makes either reproducible |
| 2 | The narrative is model-written over verified data | A confident report over a partial migration | Narrative may only describe persisted facts; outcome and counts come from data, never prose |
| 3 | Full audit trail could be very large | Unusable report | The report cites `agent_actions`; it does not inline them |
| 4 | Rotation sweep needs a scheduler | Reminders never fire | Cloud Scheduler → an endpoint; smallest thing that works |

## 9. Definition of done

- [ ] All FRs implemented
- [ ] All ACs verified
- [ ] Typecheck and tests pass
- [ ] Prototype definition of done (spec §51) walked end to end
- [ ] §10 records what was actually built

## 10. Delivery log

| Date | Change | Why |
|---|---|---|

**Deviations from plan** —

**Deferred** —
