# PRD-02 · Persistence & Event Log

| | |
|---|---|
| **Increment** | 02 |
| **Status** | `PLANNED` |
| **Depends on** | — |
| **Unblocks** | PRD-03, PRD-05 |
| **Demoable outcome** | None — foundation. Verified by test: kill the process mid-write, restart, and no state or event ordering is lost. |
| **Created** | 2026-08-29 |
| **Delivered** | |

---

## 1. Problem

The product's central promise is that the workflow does not depend on the browser staying
open. Nothing else can be built on that promise until state is durable, ordered, and
attributable. Every screen, the audit trail, and the resumability story all reduce to a
correctly-behaved persistence layer.

## 2. Sources of truth

| Source | Reference |
|---|---|
| Product spec | §42 resumable project state · §43 project state · §39 audit trail |
| Data model | §3 all collections · §5 indexes · §6a–6c resumability · §1 id conventions |
| Architecture | §5 primary product data · §28 resumability |
| Deployment | §3 MongoDB Atlas — replica set required |

## 3. Scope

**In**
- Mongo connection, index creation at startup
- One repository per collection, typed by `@proteus/schema`
- Per-project monotonic event `seq` allocation
- Guarded stage transitions (optimistic concurrency)
- Lease acquire/refresh/release for runs
- Change-stream subscription helper
- Token redaction applied at the write boundary

**Out**
- HTTP surface and SSE endpoint → PRD-03
- Cloud Storage blob writes → PRD-05
- Agent or rule invocation → PRD-06 onward

---

## 4. Functional requirements

| ID | Requirement | Source |
|---|---|---|
| FR-1 | Every collection in data model §3 has a repository; writes validate through its Zod schema before insert | Data model §3 |
| FR-2 | All indexes in data model §5 are created idempotently at startup | Data model §5 |
| FR-3 | Event `seq` is per-project, monotonic, gapless, allocated atomically via `counters` | Data model §3.18 |
| FR-4 | An event carrying an `idempotencyKey` is written at most once | Data model §3.18 |
| FR-5 | Stage transitions are guarded by expected stage + `version`; a losing writer fails rather than overwrites | Data model §3.2 |
| FR-6 | `lease` supports acquire, refresh and expiry; a second acquirer on a live lease is refused | Data model §3.10 |
| FR-7 | A change-stream subscription yields events for one `projectId` in `seq` order | Data model §6e |
| FR-8 | `redactTokens()` runs on every event, agent action and report body before write | Data model rule 8 |
| FR-9 | `projectId` is allocated as `PQC-####` from `counters`; ids are never reused | Data model §1 |
| FR-10 | Reading a project after restart reconstructs stage, summary and phase pointers with no replay | Spec §42 |

## 5. Data model

**Collections touched** — all 21, `C`/`R`/`W`.

**Schema changes** — none. This increment implements the model as written.

## 6. Interfaces

**API** — none.

**Events emitted** — none directly; provides the emitter other increments use.

**Agent involvement** — none. `core/` may not import `agent/` (folder structure §4).

**Rules consumed** — none.

## 7. Acceptance criteria

| ID | Criterion | Verified by |
|---|---|---|
| AC-1 | 1,000 concurrent event writes on one project produce seq 1..1000 with no gaps or duplicates | test |
| AC-2 | The same `idempotencyKey` written twice yields one document | test |
| AC-3 | Two writers attempting the same stage transition: one succeeds, one fails | test |
| AC-4 | A second lease acquire is refused while the first is live, and succeeds after expiry | test |
| AC-5 | A change stream filtered by `projectId` sees only that project's events | test |
| AC-6 | An event whose message contains a GitHub token is stored redacted | test |
| AC-7 | Index creation is idempotent across restarts | test |

## 8. Risks and open questions

| # | Risk or question | Impact | Resolution or owner |
|---|---|---|---|
| 1 | Change streams need a replica set; a standalone `mongod` fails at runtime, not startup | Live screens silently stop updating | Probe replica-set support at startup and fail loudly with the fix |
| 2 | `counters` is a contention point for event seq | Throughput ceiling under load | Acceptable at prototype volume; `findOneAndUpdate` is atomic. Revisit only if measured |
| 3 | Test strategy without a live Mongo | Slow or flaky CI | `mongodb-memory-server`, which starts a real replica set |

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
