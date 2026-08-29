# PRD-07 · Discovery Agent & Live Activity

| | |
|---|---|
| **Increment** | 07 |
| **Status** | `PLANNED` |
| **Depends on** | PRD-04, PRD-06 |
| **Unblocks** | PRD-08, PRD-09 |
| **Demoable outcome** | Create a project and watch the agent analyse it unattended — the feed streams findings as they are made, and survives a refresh. |
| **Created** | 2026-08-29 |
| **Delivered** | |

---

## 1. Problem

This is the first of the product's two WOW moments and the first place a model is
involved at all. It is also where the read-only autonomy boundary either holds or does
not: before approval the system may read, correlate and propose, and nothing else.

## 2. Sources of truth

| Source | Reference |
|---|---|
| Product spec | §6 live discovery · §7 activities · §13 completion · §38 activity vs audit · §41 events |
| UX design | v1.2 — Live Discovery: four stat tiles, progress, activity feed with kind/time/detail |
| Agent architecture | §2 A1 · §5 handoff · §8 context · §9 eviction |
| Data model | §3.5 discovery runs · §3.18 events and `level` |

## 3. Scope

**In**
- A1 Discovery Agent on Genkit with a read-only tool table
- `discovery_runs` with progress, checkpoint and lease
- Correlation of documents against code findings (`INFERRED` evidence permitted here)
- Resolution of `WEAK` usage signals
- Activity feed events at `MILESTONE` / `ACTIVITY` / `DETAIL`
- Completion criterion → stage `ASSESSMENT_READY`
- Live Discovery screen: stat tiles, progress, feed

**Out**
- Graph rendering → PRD-08
- Assessment and plan → PRD-09
- Any write capability whatsoever → PRD-11

---

## 4. Functional requirements

| ID | Requirement | Source |
|---|---|---|
| FR-1 | A1's tool table contains no write tool; the boundary is enforced by tool availability, not by prompt | Agent arch §2 |
| FR-2 | Detection rules run before A1; the agent receives candidates, not a bare repository | Agent arch §7 |
| FR-3 | A1 resolves `WEAK` usage signals and records the decision as evidence | `EXEC-DET-002` |
| FR-4 | Correlation between a document and code may produce `INFERRED` evidence with confidence < 1.0 | Data model §3.4 |
| FR-5 | A model may never write `OBSERVED` evidence; the schema rejects it | Data model §3.4 |
| FR-6 | `progress` reports files analysed and percent; the four tiles read from it and `summary.counts` | UX v1.2 |
| FR-7 | Feed rows carry kind, elapsed time, text and optional detail; `DETAIL` events appear only in the audit drawer | Spec §38 |
| FR-8 | An evicted worker resumes from `checkpoint` and repeats at most one step | Data model §6c |
| FR-9 | The run holds a lease; a second worker on a live lease is refused | Data model §3.5 |
| FR-10 | On completion the stage moves to `ASSESSMENT_READY` and `ASSESSMENT_COMPLETED` is emitted | Spec §13 |
| FR-11 | Refreshing mid-run reconstructs the feed from persisted events, then resumes the stream | Spec §42 |

## 5. Data model

| Collection | Access | Fields of note |
|---|---|---|
| `discovery_runs` | C/W | `progress`, `checkpoint`, `lease`, `stage` |
| `findings`, `evidence` | C/W | `INFERRED` correlation evidence |
| `events` | W | feed rows |
| `agent_actions` | C | every model turn and tool call |
| `projects` | W | `stage`, `summary.counts`, `lastEventSeq` |

**Schema changes** — none.

## 6. Interfaces

**API** — `GET /projects/{id}/discovery`.

**Events emitted** — `SOURCE_ANALYSIS_STARTED`, `FILE_ANALYZED`, `CRYPTO_FINDING_DETECTED`, `DEPENDENCY_DISCOVERED`, `HARDWARE_DEPENDENCY_DISCOVERED`, `DOCUMENT_ANALYZED`, `MIGRATION_BLOCKER_IDENTIFIED`, `ASSESSMENT_COMPLETED`.

**Agent involvement** — A1 only. Tools: `clone_repository_readonly`, `list_files`, `read_file`, `search_repository`, `inspect_dependencies`, `inspect_configuration`, `inspect_tests`, `analyze_uploaded_document`, `extract_existing_findings`, `assert_finding`, `attach_evidence`.

**Rules consumed** — `EXEC-DET-*` (pre-model), `ALGORITHM_CLASSIFICATION`, `USAGE_CLASSIFICATION`.

## 7. Acceptance criteria

| ID | Criterion | Verified by |
|---|---|---|
| AC-1 | A1's tool registry contains zero write tools | test |
| AC-2 | An attempt by A1 to write `OBSERVED` evidence is rejected by the schema | test |
| AC-3 | The feed streams during the run and reaches the same content after a refresh | screen |
| AC-4 | Killing the worker mid-run and restarting resumes without losing findings | test |
| AC-5 | A second worker cannot acquire a live lease | test |
| AC-6 | Discovery ends at `ASSESSMENT_READY` with a link to the assessment | screen |
| AC-7 | `DETAIL` events do not appear in the live feed | screen |
| AC-8 | Every model turn and tool call is recorded in `agent_actions` | test |

## 8. Risks and open questions

| # | Risk or question | Impact | Resolution or owner |
|---|---|---|---|
| 1 | "Enough evidence to assess" (spec §13) is a model judgment with no bound | A run that never completes | Cap by files analysed and elapsed time; the cap is a completion criterion, not a failure |
| 2 | Agent context grows with every file read | Long runs degrade or exceed the window | Per-agent context slice (agent arch §8); tools return extracts, not whole files |
| 3 | Non-determinism between runs | Findings differ demo to demo | Detection is deterministic (PRD-06); only correlation varies. Assert on the deterministic subset |
| 4 | Gemini model id not yet confirmed | Agent cannot start | Floor enforced at startup; confirm the live id — **open** |

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
