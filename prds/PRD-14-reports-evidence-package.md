# PRD-14 · Reports & Evidence Package

| | |
|---|---|
| **Increment** | 14 |
| **Status** | `DELIVERED` |
| **Depends on** | PRD-13 |
| **Unblocks** | — final increment |
| **Demoable outcome** | Download a migration report, the git diff and the build evidence; the three recommendations raised at assessment are still there, with their owners. |
| **Created** | 2026-08-29 |
| **Delivered** | 2026-08-29 |

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
| AC-2 | Four artifacts are downloadable with correct `displayMeta` | screen · test |
| AC-3 | All three recommendations appear on the completion screen with their owners | screen · test |
| AC-4 | No artifact contains a token-shaped string | test |
| AC-5 | The recovery section records one repair and the retry count | test |
| AC-6 | The security section shows ML-KEM-768 verified, two signature usages unchanged, the certificate NOTED | test |
| AC-7 | Outcome tiles read 100%, 0 human engineering actions, 1 repair, 3 recommendations | screen · test |
| AC-8 | Regenerating from the same `contentSnapshot` produces an identical report | test |
| AC-9 | A project past `rotationDueAt` emits the reminder once | test |

## 8. Risks and open questions

| # | Risk or question | Impact | Resolution or owner |
|---|---|---|---|
| 1 | PDF rendering toolchain not chosen | Format risk late in the build | Markdown first, PDF as a render step; `contentSnapshot` makes either reproducible |
| 2 | The narrative is model-written over verified data | A confident report over a partial migration | Narrative may only describe persisted facts; outcome and counts come from data, never prose |
| 3 | Full audit trail could be very large | Unusable report | The report cites `agent_actions`; it does not inline them |
| 4 | Rotation sweep needs a scheduler | Reminders never fire | **Resolved.** `POST /maintenance/rotation-sweep`, idempotent per credential version. Cloud Scheduler calls it; a developer can call it by hand |

## 9. Definition of done

- [x] All FRs implemented
- [x] All ACs verified
- [x] Typecheck and tests pass
- [x] Prototype definition of done (spec §51) walked end to end
- [x] §10 records what was actually built

## 10. Delivery log

| Date | Change | Why |
|---|---|---|
| 2026-08-29 | `reports/migration.ts` — `buildSnapshot`, `renderMarkdown`, `finalOutcome`, `REQUIRED_SECTIONS` | All eleven §40 sections, from a frozen snapshot. `finalOutcome` is a function of persisted state, so the verdict cannot be written by prose |
| 2026-08-29 | `reports/evidence.ts` — `renderDiff`, `buildEvidence`, `diffMeta`, `evidenceMeta` | The diff carries each modification's rationale above its hunk, and a modified test carries its §26 integrity record. A bare `git diff` answers "what"; this answers "why" |
| 2026-08-29 | `agent/flows/report.ts` — `ReportNarrator` | A flow, not an agent: one call, no tools, no loop. It writes five prose fields and can reach no number |
| 2026-08-29 | `worker/reportJob.ts` — `runReport` | Assembles the package, redacts the bytes, and moves the project to `COMPLETED` — after the artifacts, because `EXEC-VER-013` makes the evidence a precondition of completeness |
| 2026-08-29 | `core/services/rotation.ts` — `sweepRotations`; `POST /maintenance/rotation-sweep` | Risk 4. Idempotent per credential *version*, so an hourly sweep reminds once and a rotation re-arms it |
| 2026-08-29 | `api/routes/migration.ts` — `POST /projects/:id/report` | Regeneration, which is meaningful because the render is a pure transform of a stored snapshot |
| 2026-08-29 | `verification/checks/scope.ts` — a `testIntegrity` record exempts a change from the path check | A defect found by AC-10. See "Found while building" |
| 2026-08-29 | `screens/sandbox/Completion.tsx`, `lib/migration.ts`, `styles/migration.css` | Outcome tiles, crypto verification with `NOTED`, the four-artifact package, and the recommendations carried forward |
| 2026-08-29 | `src/backend/package.json` — esbuild bundle; `deployment/backend/Dockerfile`, `deployment/frontend/Dockerfile` | TD-012, resolved. See "Beyond the stated scope" |
| 2026-08-29 | `test/report.test.ts` (20 backend), `test/migration.test.ts` (+5 frontend) | Every AC, over a real completed run — branch, baseline, patch, the rigged failure, the repair, verification, sandbox, report |

**Deviations from plan** —

1. **The assessment report is not regenerated here.** FR-2 asks for four artifacts and
   four exist, but only three are written by this job. The assessment report is produced
   at assessment time and describes the scope *as it was approved*; rewriting it once the
   outcome is known would let the result edit its own premise. The completion screen
   offers all four because all four exist, not because all four are written together.

2. **`NO_CRITICAL_BLOCKER`'s provenance is the verification run, and the sandbox check's
   is the deployment document.** Both are established by a query or a record rather than a
   command, so neither has an execution of its own to cite. Rather than fabricate an
   evidence id, each cites the real thing that established it — which is why the AC-6 test
   asserts exactly one check passes without an `executionRunId`, and names it.

3. **Only open recommendations are carried forward.** `EXEC-VER-013` says carry them
   forward; a `CLOSED` one has been dealt with, and reprinting it would bury the live ones
   among the resolved.

4. **An unreadable diff produces a stated absence, not an empty file.** A zero-byte diff
   artifact would claim the migration changed nothing. If no patch can be read the file
   says how many changes are recorded and that none carries a stored diff.

5. **The narrative is optional at every level.** No model, or a model that fails, still
   produces the complete report — with the outcome, the counts and the verdict unchanged.
   Risk 2's guard is that the prose cannot reach any of them; losing the evidence because
   a sentence could not be written would be the worse failure.

**Found while building** —

**An authorised mock repair was being reported as a scope breach.** `EXEC-VER-001` checks
every changed path against `PlanItem.expectedChanges`, and PRD-13 exempted
`intent: TEST_ENGINEERING`. But a mock repaired *during* the loop has `intent: REPAIR`,
so the reference scenario's own repair — the one spec §26 gives as its canonical example
of what the agent should not ask permission for — raised a blocking gate, and the run
ended `HUMAN_ACTION_REQUIRED` instead of `VERIFIED`. The discriminator is not the intent
but what authorised the change: an implementation change is bound to the declared paths,
while a test, mock or fixture change is authorised by its `testIntegrity` record, which
the schema already refuses to omit. PRD-13's tests all passed because none of them
combined a repair with a scope check.

**Beyond the stated scope** —

PRD-08, PRD-11 and PRD-13 each deferred deployment work "to PRD-14", but §3 of this PRD
scopes none of it. Rather than let three forward-references expire silently, the smallest
blocking piece was done and the rest is named:

- **TD-012 is resolved.** `npm run build -w @proteus/backend` now bundles with esbuild
  and `--packages=external`, which inlines the workspace schema and leaves
  `node_modules` alone. The bundle loads and reaches its own configuration check. The
  tech-debt note predicted the bundler would be the smaller change; it was.
- **Both Dockerfiles are written.** The backend image installs `git` as a runtime
  dependency — the migration shells out to it — copies the engine assets rather than
  bundling them so a ruleset edit needs no rebuild, and runs as a non-root user. The
  frontend image takes only `VITE_*` build args, none of which is a secret.

**Deferred** —

- **The Cloud Build and Cloud Run submission clients** (→ PRD-16). Both interfaces are complete with
  working local implementations, and both were verified against the real fixture —
  `ProcessExecutor` ran the Maven suite in `maven:3.9-eclipse-temurin-17`, and
  `LocalDockerDeployer` built and started the fixture's own image. Swapping in the GCP
  clients is a substitution behind an interface, not a redesign, and it needs a project,
  a bucket and a service account that this environment does not have.
- **PDF rendering.** Risk 1 said Markdown first, PDF as a render step. Markdown is
  delivered and `contentSnapshot` makes either format reproducible from the same source.
  Nothing renders PDF, and the artifact `format` enum already carries the value.
- **Sandbox teardown.** `expiresAt` is recorded seven days out and the sweep endpoint
  pattern now exists; a teardown sweep would be the same shape as the rotation one.
- **The branch is still not pushed.** `GitWriter.push` is written and nothing calls it. A
  verified migration is the first point at which it is meaningful, and the pull request it
  would open was never in the MVP's scope.
- **`EXEC-DIAG-012` still raises no `Recommendation` document.** Carried from PRD-12. The
  classification is correct and the failure is exempted from the retry budget, but the
  owned recommendation the rule calls for is not written — so an external blocker
  discovered during the loop reaches the report as a gate rather than as an item with an
  owner. Nothing in the reference scenario reaches it.
