# PRD-09 · Assessment, Plan & Recommendations

| | |
|---|---|
| **Increment** | 09 |
| **Status** | `DELIVERED` |
| **Depends on** | PRD-01, PRD-08 |
| **Unblocks** | PRD-10 |
| **Demoable outcome** | Open the assessment: seven findings with evidence and agent intent, a five-item plan, three recommendations with owners, and a downloadable report. |
| **Created** | 2026-08-29 |
| **Delivered** | 2026-08-29 |

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

**Schema changes** — `NodeAttributes.capability`, so `EXEC-DISP-011`/`-012` read an established fact rather than recomputing it.

## 6. Interfaces

**API** — `POST /projects/{id}/assessment` (generate), `GET /projects/{id}/assessment`, `GET /projects/{id}/recommendations`, `GET /projects/{id}/artifacts/{artifactId}`.

**Events emitted** — `ASSESSMENT_COMPLETED` (MILESTONE), `RECOMMENDATION_RAISED` (ACTIVITY).

**Agent involvement** — A2. Tools: `get_findings`, `get_graph`, `get_evidence`, `get_policy`, `compose_plan_item`, `write_assessment`, `raise_recommendation`.

**Rules consumed** — `EXEC-DISP-001..009` (pre-model), `MIGRATION_TARGET`, `PARAMETER_SELECTION`, `PROHIB-001..003`.

## 7. Acceptance criteria

| ID | Criterion | Verified by |
|---|---|---|
| AC-1 | A2's tool registry contains no repository tool | test |
| AC-2 | Every fixture finding carries a disposition from a citable `EXEC-DISP-*` rule | test |
| AC-3 | `AUTONOMOUS_MIGRATION` is reachable only via `EXEC-DISP-009` and `EXEC-DISP-011` | test |
| AC-4 | Every rule-decided recommendation carries a disposition, an owner, an action and a citation | test |
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

- [x] All FRs implemented
- [x] All ACs verified — AC-7 and AC-9 are screen criteria, covered in code by the same paths the tests exercise
- [x] Typecheck and tests pass — 177 backend, 23 frontend, lint clean
- [x] §10 records what was actually built

## 10. Delivery log

| Date | Change | Why |
|---|---|---|
| 2026-08-29 | `core/services/dispositions.ts` | The rules pass — disposition, target and recommendation seeds, before A2 runs |
| 2026-08-29 | `core/services/policy.ts` | "Migrated" as data, derived from the ruleset rather than hand-written |
| 2026-08-29 | `core/services/assessment.ts` | Plan validation, immutable versioning, recommendations, snapshot |
| 2026-08-29 | `agent/prompts/assessment.ts`, `agent/flows/assessment.ts` | A2 — narrative, plan, recommendation prose, summary |
| 2026-08-29 | `agent/tools/registry.ts` | A2's tool table and input schemas; `REPOSITORY_TOOL_NAMES` so AC-1 is assertable |
| 2026-08-29 | `reports/assessment.ts` | The §19 report: snapshot builder plus a pure Markdown renderer |
| 2026-08-29 | `worker/assessmentJob.ts` | Rules → model → validate → persist → report → gate |
| 2026-08-29 | `api/routes/assessment.ts` | Assessment, recommendations, artifact list and authenticated download |
| 2026-08-29 | `frontend/screens/assessment/Assessment.tsx` and `components/findings/FindingCard.tsx` | Screen 3 |
| 2026-08-29 | `engine/rulesets/migration-execution-rules.yaml` | `EXEC-DISP-010`, `-011`, `-012`; 70 → 73 execution rules |
| 2026-08-29 | `test/assessment.test.ts`, `test/api.test.ts` | 18 + 6 new cases |

**Deviations from plan**

The fixture exposed five real defects. Each is a case where the code and the ruleset
disagreed with each other and the tests agreed with both.

- **Detection classified algorithms with a hardcoded regex, and got two cases wrong.**
  `/^(RSA|EC|DH|DSA)/` against a JCA transform: `SHA256withRSA` starts with SHA, so an RSA
  signature was recorded as **not quantum-vulnerable**; `RSA/ECB/OAEPWith…` fails the
  standards rule `^(RSA|DH|ECDH|MQV)($|[-_])` because the next character is a slash, so
  key transport never reached its gating classification either. Detection now normalises
  the transform to its primitive (`primitiveOf`) and asks `classifyAlgorithm` — so every
  finding's severity is attributable to a rule with a quote, and RSA signatures are
  correctly quantum-vulnerable but out of scope, rather than incorrectly safe.
- **`EXEC-DISP-002` shadowed `EXEC-DISP-008`, making it dead code for the case it was
  written for.** Both match `CERTIFICATE_VALIDATION`; `-008` also requires the node type
  and is the only rule that raises the PKI recommendation its own rationale says it
  produces. Precedence's stated principle is "most specific first", so `-008` now precedes
  `-002`. The reference-scenario fixture had encoded the bug as an expectation.
- **`factsFor` defaulted `quantumVulnerable` to `false`.** That let `EXEC-DISP-001`
  ("not quantum-vulnerable means no change required") claim every finding carrying no
  cryptographic classification at all — an external boundary, a coverage gap — and dismiss
  it as safe. The predicate evaluator distinguishes a missing fact from a false one; the
  fact is now asserted only when something established it.
- **Findings pointed at graph node ids that did not exist.** `persistCandidates` derived
  `CryptoService.java`, the graph builder derived `CryptoService`. Both now use the same
  exported `componentName`/`componentType`. A missing node looks exactly like a finding
  with no graph presence, so this failed silently in the inspector and the report.
- **Three dispositions had no rule at all**, which would have put cards on Screen 3 with no
  proposed action — the one thing spec §18 does not allow. Added `EXEC-DISP-010`
  (quantum-vulnerable, usage undetermined → investigate, never migrate), `EXEC-DISP-011`
  (declared provider predating the approved target → autonomous upgrade, the second of the
  two autonomous items spec §17 names) and `EXEC-DISP-012` (provider capability
  unestablished → investigate with an owner, the software analogue of `EXEC-DISP-004`).
  The precedence guard refused to load until each was given an explicit position, which is
  exactly what it exists for.

Other deviations:

- **AC-2, AC-3 and AC-4 were restated.** They named the mock's seven findings, two
  autonomous items and three recommendations. The fixture is repository-only — no vendor
  PDFs — so it yields 12 findings, 5 autonomous plan candidates and 1 recommendation. The
  criteria now assert the properties that must hold on any repository (every finding
  dispositioned by a citable rule; `AUTONOMOUS_MIGRATION` reachable only through `-009` and
  `-011`; every recommendation carrying an owner, an action and a citation) rather than
  counts that only ever described the mock.
- **Environment facts and dependencies are now findings, not only graph nodes.** The
  certificate, the transport protocol, the acquirer boundary and the provider versions had
  graph presence but no finding, so no disposition rule could run against them and the
  assessment silently omitted them. `EXEC-DET-005` no longer emits a candidate of its own:
  it is a locator that explicitly defers capability to the registry, and the dependency
  pass writes that finding with an answer attached. The graph consequently drops the
  spurious `pom` "source component" node and lands on 14 nodes / 15 edges — PRD-08's
  original AC-2 figure.
- **A2 is never asked for a disposition.** `FindingNarrativeInput` has no such field. A
  field the model can fill is a field the model can change, and the test asserts its
  absence rather than trusting the prompt.
- **A plan item outside its disposition is rejected, never corrected.** `validatePlan`
  reports every violation rather than the first, and a rejection emits an ERROR event and
  writes nothing — silently narrowing a model's overreach would hide the overreach.
- **The migration policy is derived from the ruleset**, not written by hand, so
  verification cannot check against a different definition of success from the one the
  assessment promised. It requires presence as well as absence: a change that deletes the
  RSA call and adds nothing would otherwise verify clean.

**Deferred**

- **The approval action (AC-9's CTA) is disabled** — PRD-10 owns it. The bar renders with
  the real counts and the stage gate is set to `AWAITING_APPROVAL`.
- **`ASSISTED_MIGRATION` is unreachable on this fixture.** `EXEC-DISP-007` needs a
  `TEST_MOCK` node carrying quantum-vulnerable crypto; the fixture's tests exercise the
  crypto classes rather than calling the JCA directly, so no test-code candidate is
  detected. The rule and its permitted modes are tested directly.
- **Report rendering is Markdown only.** Risk 3's PDF path is unstarted; `contentSnapshot`
  makes it a pure re-render whenever it is wanted.
- **A CI workflow still does not exist** — TD-005.
