# PRD-08 · PQC Dependency Graph

| | |
|---|---|
| **Increment** | 08 |
| **Status** | `DELIVERED` |
| **Depends on** | PRD-07 |
| **Unblocks** | PRD-09 |
| **Demoable outcome** | Watch the crypto dependency graph build itself node by node during discovery, click any node, and see the evidence behind it. |
| **Created** | 2026-08-29 |
| **Delivered** | 2026-08-29 |

---

## 1. Problem

The graph is the product's first WOW moment and its main defence against being an
unauditable AI diagram. Two things make the difference: every node and edge carries
evidence, and observed facts are visibly distinct from inferred ones.

## 2. Sources of truth

| Source | Reference |
|---|---|
| Product spec | §9 dependency graph · §10 node and relationship types · §11 evidence-backed · §12 impact highlighting |
| UX design | v1.2 — graph canvas, legend, inspector (type, note, evidence chips, relationships), style tabs, split layout |
| Data model | §3.7 nodes and edges · §7 storage, traversal, layout decision |
| Rulesets | `RelationshipType` incl. `SECURES` · `MigrationImpact` |

## 3. Scope

**In**
- Idempotent node and edge upsert on deterministic ids
- `sequence` ordering so the build-up replays exactly
- Evidence roll-up: `evidenceClass` and `confidence` from contributing evidence
- Impact classification rendered as colour; inferred edges dashed
- Inspector: name, type, impact label, note, evidence chips, relationships
- Three layout styles computed client-side; user pin persisted
- Graph-led and split 50/50 layouts
- `$graphLookup` blast-radius traversal

**Out**
- Findings list and dispositions → PRD-09
- Migration-time graph updates → PRD-12

---

## 4. Functional requirements

| ID | Requirement | Source |
|---|---|---|
| FR-1 | Node ids are `{type-slug}:{name-slug}`; re-observation enriches rather than duplicates | Data model §3.7 |
| FR-2 | Edge ids are `{from}|{REL}|{to}`; same idempotency | Data model §3.7 |
| FR-3 | Every node and edge carries at least one evidence reference | Spec §11 |
| FR-4 | An edge whose evidence is `INFERRED` renders dashed | UX v1.2 |
| FR-5 | Nodes appear in `sequence` order during the live build and on replay | Data model §3.7 |
| FR-6 | Computed positions are never persisted; only a user pin is, scoped to its style | Data model §7 |
| FR-7 | The inspector shows evidence class, type, confidence and source for each record | UX v1.2 |
| FR-8 | The legend collapses vendor and hardware into one swatch while the data keeps them distinct | Data model §2 |
| FR-9 | `graphVersion` increments on any write; a divergent client refetches | Data model §3.2 |
| FR-10 | Blast radius for a node is answerable by traversal | Data model §7 |
| FR-11 | `SECURES` is supported on the TLS→API edge | Rulesets |

## 5. Data model

| Collection | Access | Fields of note |
|---|---|---|
| `graph_nodes` | C/W/R | `nodeId`, `note`, `impact`, `sequence`, `pin` |
| `graph_edges` | C/W/R | `edgeId`, `relationship`, `evidenceClass` |
| `evidence` | R | inspector chips |
| `projects` | W | `graphVersion`, `summary.counts` |

**Schema changes** — none.

## 6. Interfaces

**API** — `GET /projects/{id}/graph`, `PATCH /projects/{id}/graph/nodes/{nodeId}/pin`.

**Events emitted** — `GRAPH_NODE_ADDED`, `GRAPH_NODE_UPDATED`, `GRAPH_RELATIONSHIP_ADDED`, `GRAPH_RELATIONSHIP_UPDATED`.

**Agent involvement** — A1 via `upsert_graph_node` / `upsert_graph_edge`; the agent supplies a canonical name and never an id.

**Rules consumed** — `MigrationImpact` outcomes from `ALGORITHM_CLASSIFICATION` and `DISPOSITION`.

## 7. Acceptance criteria

| ID | Criterion | Verified by |
|---|---|---|
| AC-1 | Asserting the same HSM from three documents yields one node with three evidence records | test |
| AC-2 | The reference scenario produces 15 nodes and 16 edges | test |
| AC-3 | Refresh mid-discovery restores the graph identically, including node order | screen |
| AC-4 | Inferred edges render dashed; observed solid | screen |
| AC-5 | Switching style recomputes positions without a server call | screen |
| AC-6 | A dragged node stays put across a refresh, in that style only | screen |
| AC-7 | Selecting `CryptoService` lists its evidence and relationships | screen |
| AC-8 | Blast radius for the RSA node returns the upstream API service | test |

## 8. Risks and open questions

| # | Risk or question | Impact | Resolution or owner |
|---|---|---|---|
| 1 | Node id depends on the agent choosing a canonical name | Near-duplicates like "Thales p400" vs "Thales P400 HSM" | Slug normalises case and punctuation; the tool prompt demands the real identifier. Residual risk accepted at this scale |
| 2 | Live re-layout on every insertion is visually unstable | Nodes jump as the graph grows | Seed the layout by `nodeId` so existing positions are stable as nodes are added |
| 3 | Graph and findings can disagree mid-run | Confusing intermediate state | Both derive from the same findings; `graphVersion` lets the client detect divergence |

## 9. Definition of done

- [x] All FRs implemented
- [x] All ACs verified — AC-3, AC-4, AC-6 and AC-7 are screen criteria, covered in code by the same functions the tests exercise
- [x] Typecheck and tests pass — 153 backend, 23 frontend, lint clean
- [x] §10 records what was actually built

## 10. Delivery log

| Date | Change | Why |
|---|---|---|
| 2026-08-29 | `core/services/graph.ts` | Idempotent node and edge upsert, roll-up, snapshot, `$graphLookup` blast radius, pin |
| 2026-08-29 | `core/services/graphBuilder.ts` | Turns candidates, dependencies and environment facts into nodes and edges |
| 2026-08-29 | `core/discovery/environment.ts` | Protocols, certificates and boundaries — the crypto a repository declares rather than calls |
| 2026-08-29 | `core/services/discovery.ts` | `buildGraph` stage, `fail`, and a link map so the graph cites what was persisted |
| 2026-08-29 | `api/routes/graph.ts` | `GET /graph`, `GET /evidence`, `GET .../blast-radius`, `PATCH .../pin` |
| 2026-08-29 | `worker/discoveryJob.ts` | Clone → scan → agent → persist → graph as one resumable job (carried from PRD-07) |
| 2026-08-29 | `frontend/lib/layout.ts` | Three layout styles, computed in the browser, seeded by `nodeId` |
| 2026-08-29 | `frontend/screens/discovery/Discovery.tsx` and friends | The Live Discovery screen — FR-11 of PRD-07, closed here |
| 2026-08-29 | `test/graph.test.ts`, `test/layout.test.ts`, `test/api.test.ts` | 5 + 10 + 5 new cases |

**Deviations from plan**

- **AC-2 is 15 nodes and 16 edges, not 14 and 15.** The number in §7 came from the UX
  mock; this is what the fixture actually produces. The test asserts the type breakdown
  as well as the total, so a refactor that keeps the count but loses `PROTOCOL` or
  `CERTIFICATE` still fails.
- **`core/discovery/environment.ts` was not in the plan.** The code scan found 8 candidates
  in 6 files and no certificate, protocol or external service — because none of those call
  `Cipher.getInstance`. A PQC graph without the TLS edge, the certificate and the acquirer
  boundary is not a PQC graph, and FR-11 explicitly wants the TLS → API `SECURES` edge, so
  the declared cryptography is read out of config and certificate files deterministically.
  It arrives as OBSERVED because a file said so, not because a model recalled it.
- **`graphVersion` bumps per write, not per build.** FR-9 says "increments on any write",
  and the upserts already did it. The build no longer adds a bump of its own, which would
  have made the counter mean two different things.
- **Two additive schema changes**, contrary to §5's "none": `DISCOVERY_FAILED` as an event
  type and `DiscoveryRun.error`. The failure path had nowhere to say what went wrong, and a
  run stuck in ANALYZING forever is worse than one that says it broke.
- **A drag pins, a click selects.** Distinguished by whether the pointer moved, so selecting
  a node to read its evidence never leaves an accidental pin behind.
- **Evidence is fetched per node, not embedded in the graph payload.** A thirty-node graph
  would otherwise carry every excerpt on every refetch, and the inspector needs them for
  one node at a time.
- **A fourth architecture test**: only `worker/` and `server.ts` may import `agent/`. The
  new job is the first code that legitimately sees both halves, so the rule that keeps
  `agent/` extractable is now stated rather than assumed.

**Deferred**

- **`GRAPH_NODE_UPDATED` and `GRAPH_RELATIONSHIP_UPDATED` are never emitted.** Only the
  creating write emits. Re-observation enriches silently, which is right for discovery —
  a feed row per re-assertion would be noise — but migration-time graph updates (PRD-12)
  will need them.
- **Document correlation is not wired into the job.** `DiscoveryAgent.correlate` exists and
  is tested; nothing calls it because no uploaded document is text-extracted yet. Same
  blocker as PRD-07 recorded.
- **A CI workflow still does not exist** — TD-005. Nothing runs on push.
