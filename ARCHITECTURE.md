# Proteus — Architecture

Source material for the architecture diagram. Describes what is **built and deployed**, not the v1 design intent. Where the two differ, the difference is called out.

---

## 1. The one-line shape

```
Repository URL  →  Discovery  →  Assessment  →  ⟨HUMAN GATE⟩  →  Migration  →  Verification  →  Sandbox  →  Evidence
                   read-only      read-only                      write to own branch    9 checks     live URL     package
```

Everything left of the gate is read-only and enforced structurally: before approval the system holds a `GitHubReader`, which has no write methods. `GitWriter` is a different class, constructed only after a human approves. "Read-only before approval" is a type, not a promise.

---

## 2. Layered view — the diagram's backbone

```
┌──────────────────────────────────────────────────────────────────────┐
│  BROWSER                                                             │
│  React 19 SPA · React Router 7 · Firebase Auth (Google sign-in)      │
│  Screens: Projects · Create · Discovery · Assessment · Migration ·   │
│           Sandbox & Report · Activity                                │
└───────────────┬──────────────────────────────────────────────────────┘
                │ HTTPS · Bearer (Firebase ID token) · SSE for live feed
┌───────────────▼──────────────────────────────────────────────────────┐
│  api/            Fastify 5 · CORS · auth · ownership · activity      │
│                  routes: projects assessment migration graph events  │
│                          activity me health                          │
│                  sse/stream.ts — resumable via Last-Event-ID         │
├──────────────────────────────────────────────────────────────────────┤
│  worker/         discoveryJob · assessmentJob · migrationJob         │
│                  migrationLoop · verificationJob · reportJob         │
│                  ← the ONLY layer allowed to see both core and agent │
├────────────────────────────┬─────────────────────────────────────────┤
│  agent/  (reasons)         │  core/  (establishes truth)             │
│  flows: discovery          │  rules/        114-rule engine          │
│         assessment         │  discovery/    detectors, working copy  │
│         testEngineering    │  migration/    baseline, invariants,    │
│         migration          │                changeSets, testGuard,   │
│         diagnosis          │                progress, roundTripProbe │
│         report             │  services/     projects, approval,      │
│  model.ts  Genkit → Gemini │                lifecycle, dispositions  │
│  prompts/  tools/          │  repositories/ typed Mongo access       │
│                            │  events/       gapless per-project seq  │
├────────────────────────────┴─────────────────────────────────────────┤
│  verification/   9 checks · e2e scenarios · policy                   │
│                  ✗ MAY NOT import agent/ — the verifier cannot       │
│                    consult the model it is judging                   │
├──────────────────────────────────────────────────────────────────────┤
│  integrations/   github/ (reader + writer)   storage/ (GCS blobs)    │
│                  secrets/ (Secret Manager)   cloudbuild/ (executor)  │
│                  cloudrun/ (sandbox deployer) gcp/ (transport)       │
└──────────────────────────────────────────────────────────────────────┘
```

### Import boundaries — enforced by tests that fail the build

| Rule | Why |
|---|---|
| `core/` ✗→ `agent/` | Truth must not depend on reasoning |
| `verification/` ✗→ `agent/` | The verifier cannot ask the model it judges |
| `agent/` ✗→ MongoDB driver | The agent reaches data only through repositories, so it stays extractable |
| only `worker/` + `server.ts` →`agent/` | One seam between reasoning and orchestration |

*Diagram suggestion: draw these as red "no-entry" arrows. They are the most distinctive thing about the design.*

---

## 3. The core principle

> **Gemini reasons. Deterministic tools establish truth.**

| Gemini MAY decide | Gemini MAY NOT establish |
|---|---|
| what to investigate | source contents |
| migration sequence | git state |
| likely root cause | build success |
| next engineering action | test success |
| whether a mock is obsolete | crypto presence / absence |
| whether a human is needed | deployment success |

Every fact in the system is typed `OBSERVED` (from a tool) or `INFERRED` (from the model). They are never the same kind of thing in the data model.

---

## 4. Agent calls — every place the model is invoked

Twelve, all recorded to `agent_actions` with prompt, response, tokens and latency.

| Phase | Purpose | Produces |
|---|---|---|
| Discovery | `discovery-sufficiency` | is the evidence enough to assess |
| Assessment | `assessment-plan` | the proposed plan items |
| | `assessment-summary` · `assessment-narratives` · `assessment-recommendations` | prose only — never a disposition |
| Test engineering | `baseline-invariants` | the contract the migration must not break |
| | `coverage-assessment` | which components lack covering tests |
| | `generate-tests` | characterization + acceptance tests |
| Migration loop | `migration-patch` | the code change for one plan item |
| | `failure-diagnosis` | root cause, when rules don't match |
| | `migration-repair` | the fix for a diagnosed failure |
| Report | `migration-report-narrative` | prose; never a number or a verdict |

**Dispositions are never model output.** The rules engine decides `AUTONOMOUS_MIGRATION` / `NO_AUTONOMOUS_CHANGE`, citing a rule ID.

---

## 5. The migration loop

```
      approved plan items
              │
              ▼
   ┌── group into CHANGE SETS ──┐   a primitive swap is one change,
   │   (by crypto usage)        │   however many files it touches
   └──────────┬─────────────────┘
              ▼
   for each item in the set:
        agent writes patch  ──→  assertWithinScope()  ← refuses out-of-plan paths
              │
              ▼
        git commit (own branch)
              │
              ▼
        docker run maven → BUILD + TEST     ← tool fact, never a model claim
              │
        ┌─────┴─────────────────────────────────┐
        │ passed?                               │ failed?
        ▼                                       ▼
   next item                        more of the set unapplied?
                                    ├─ yes → "change set incomplete", NOT diagnosed
                                    └─ no  → rules classify (EXEC-DIAG-*)
                                                    │
                                        ┌───────────┴───────────┐
                                        ▼                       ▼
                                  repair permitted        HUMAN GATE
                                  (≤4 attempts per         (blocking)
                                   problem, per rule)
```

**Two ideas worth drawing:**

- **Change sets.** Judged item-by-item, every intermediate state of a crypto migration looks broken — and the repair agent is then asked to make a correct-in-progress build green with the rest unapplied, for which the only available edit is undoing the migration.
- **Retry budget per *problem*, not per run.** Keyed on a stable `problemKey` derived from the deterministic classification, so a flake never exhausts it and a genuine defect cannot loop forever.

---

## 6. Verification — nine checks, computed

```
                    ┌──────────────────────────────┐
   BUILD ──────────►│                              │
   CRYPTO_VERIFY ──►│   computeOverallVerdict()    │──► VERIFIED / NOT_VERIFIED
   detector scan ──►│   (spec §35)                 │
   round-trip probe►│   the model cannot write here│
                    └──────────────────────────────┘
```

| # | Check | Established by |
|---|---|---|
| 1 | Baseline invariants preserved | re-run at branch head |
| 2 | Build successful | `mvn -B -q -DskipTests package` exit code |
| 3 | Required tests passed | JUnit XML, baseline ⊆ current |
| 4 | Prohibited crypto absent | same detector discovery used |
| 5 | Required PQC present | **Proteus's own round-trip probe** |
| 6 | Migration policy satisfied | diff vs approved scope |
| 7 | No critical blocker | open gates, blocked findings |
| 8 | Sandbox deployment successful | container answers `/healthz` |
| 9 | End-to-end verified | scenarios against the live URL |

**The round-trip probe deserves a box of its own.** Check 5 used to select tests whose *name* matched `/kem|encaps|roundtrip/` — a name chosen by the agent being judged. Proteus now generates a JUnit test mechanically from the repository's API surface, no model involved, asserting `assertArrayEquals(sessionKey, unwrap(wrap(sessionKey)))`. Deployment is gated on checks 1–7 (`EXEC-REP-004`), so 8 and 9 are established afterwards.

---

## 7. Rules engine

```
engine/rulesets/
  pqc-migration-rules.yaml        40 standards rules
    └─ NIST FIPS 203/204/205 · NIST IR 8547 · CNSA 2.0 · NIST SP 1800-38
  migration-execution-rules.yaml  74 execution rules
    └─ detection · disposition · test integrity · mock strategy
       failure classification · repair authorisation · escalation
                                  ─────
                                  114 total
```

Extracted **before** the demo repository existed, so they cannot have been reverse-engineered to fit it. Every disposition, classification and refusal cites a rule ID that appears in the UI and the report.

---

## 8. Data model

MongoDB Atlas, replica set (required — change streams drive the live feed). **25 collections**; Zod schemas are the single source of truth for MongoDB validation, REST contracts *and* Genkit tool schemas simultaneously.

```
projects ─┬─ discovery_runs ─── findings ─── evidence
          ├─ graph_nodes / graph_edges
          ├─ assessments ─── recommendations
          ├─ human_gates
          ├─ migration_runs ─┬─ migration_attempts
          │                  ├─ migration_changes
          │                  ├─ baselines
          │                  ├─ execution_runs      ← every build, with exit code
          │                  └─ problem_threads     ← retry budget, per problem
          ├─ verification_results
          ├─ sandbox_deployments
          ├─ artifacts ─── project_files
          ├─ events              ← gapless per-project seq, drives SSE
          ├─ agent_actions       ← every model call: prompt, response, tokens
          └─ user_activity
users · counters · migration_policies
```

**Large payloads spill to GCS**, never into documents: build logs, diffs, reports, uploaded context, oversized prompts. Mongo holds the map.

---

## 9. Live updates

```
worker writes event ──► events collection ──► change stream ──► SSE ──► browser
                        (per-project              (tail)      (Last-Event-ID
                         gapless seq)                          resume)
```

A change stream rather than an in-process emitter: under any scale-out the instance writing an event and the instance holding the subscriber's connection are different containers. This is what makes the fan-out correct without adding Redis or Pub/Sub.

The client uses `fetch` rather than `EventSource` — `EventSource` cannot send an `Authorization` header — and reconnects by hand with `Last-Event-ID`.

---

## 10. Deployment (as running today)

```
                     ┌─────────────────────────────────────┐
   Browser ──HTTPS──►│  Caddy  (automatic Let's Encrypt)   │
                     │  <ip>.nip.io                        │
                     │   /api/*  → :8080  (flush_interval  │
                     │                     -1, for SSE)    │
                     │   /*      → SPA (try_files)         │
                     └────────────┬────────────────────────┘
                                  │
   ┌──────────────────────────────▼───────────────────────────────┐
   │  GCE  e2-standard-4 · Debian 12 · Docker · Node 22           │
   │  ┌─────────────────┐   ┌──────────────────────────────────┐  │
   │  │ Proteus API     │──►│ docker run maven:3.9-temurin-17  │  │
   │  │ (systemd)       │   │  migration builds, --user uid:gid│  │
   │  │                 │   └──────────────────────────────────┘  │
   │  │                 │   ┌──────────────────────────────────┐  │
   │  │                 │──►│ docker run <migrated image>      │  │
   │  └─────────────────┘   │  sandbox, port 32768-60999       │  │
   └────────┬───────────────└──────────────────────────────────┘──┘
            │
   ┌────────┼──────────┬───────────────┬──────────────┬────────────┐
   ▼        ▼          ▼               ▼              ▼            ▼
MongoDB   Cloud     Cloud          Secret         Vertex AI     GitHub
Atlas     Storage   Logging        Manager        Gemini        (clone,
(replica) (blobs)   (severity/     (per-project   3.7 Flash      branch,
                     message JSON)  PAT, pinned    (global)      push)
                                    version)
```

**Why a VM and not Cloud Run.** Proteus builds the repository under migration and then runs the migrated application — both are `docker run`. A Cloud Run container cannot start another container, so the LOCAL executor and sandbox deployer cannot work there; `assertRuntimeAvailable` refuses to boot rather than failing at the first migration.

*(For the diagram: the target-state Cloud Run architecture is in §12 — worth showing as a "next" panel.)*

---

## 11. Tech stack

| Layer | Technology | Version | Note |
|---|---|---|---|
| **Frontend** | React | 19.2 | |
| | React Router | 7.18 | |
| | Vite | 7 | build |
| | Firebase Auth | 12.18 | Google sign-in; ID token to the API |
| | IBM Plex Sans / Mono | 5.3 | self-hosted, no CDN |
| **Backend** | Node.js | 22 | ESM, bundled with esbuild |
| | TypeScript | 5.9 | strict |
| | Fastify | 5.12 | + `@fastify/cors` |
| | Zod | 4 | schemas → Mongo validation + REST + tool schemas |
| **Agent** | Genkit | 1.41 | `@genkit-ai/google-genai` |
| | Gemini 3.7 Flash | — | via **Vertex AI**, ADC, no API key |
| **Data** | MongoDB Atlas | driver 7.6 | replica set; change streams |
| **Google Cloud** | Compute Engine | — | e2-standard-4, Docker host |
| | Cloud Storage | SDK 7.22 | logs, diffs, reports, artifacts |
| | Secret Manager | SDK 7.0 | per-project GitHub PAT, pinned version |
| | Vertex AI | — | Gemini inference |
| | Cloud Logging | — | structured JSON from stdout |
| | Firebase Admin | 14.3 | ID token verification |
| **Build/runtime** | Docker | — | `maven:3.9-eclipse-temurin-17` |
| | Caddy | 2 | automatic TLS, reverse proxy, SPA |
| **Testing** | Vitest | 2.1 | 512 backend + 148 frontend = **660** |
| | mongodb-memory-server | — | real replica set, not mocks |

**Repository layout** — npm workspaces:

```
schema/          Zod contracts shared by both runtimes
src/backend/     API, agent, core, worker, verification
src/frontend/    React SPA
engine/          114 rules (YAML) + provider capability data
fixtures/        payments-api (40 files) · settlement-api (12 files)
prds/            18 PRDs — each written before its increment
deployment/      GCP provisioning and deploy scripts
fixes/           post-mortems, grouped by mistake rather than by file
```

---

## 12. What is designed but not wired (honest gaps)

Worth a dotted-line panel on the diagram — it shows the target architecture without claiming it works.

| Component | State |
|---|---|
| **Cloud Build** for migration builds | Executor + pipeline written. Blocked: the loop pushes only at the end, so Cloud Build cannot clone the commit it is asked to build. |
| **Cloud Run** for sandboxes | Deployer written, zero-privilege sandbox identity specified. Blocked: `stageSource` never uploads the source archive. |
| **Proteus on Cloud Run** | Possible once the two above land, plus migrations moved to Cloud Run Jobs — today they run unawaited in the API process, so a deploy kills in-flight work. |
| `REQUIRES_MIGRATION_WITH` | In the schema, produced by nothing. Change sets group by crypto usage as a proxy; the graph could answer it exactly. |
| Plan scope from the graph | `TESTED_BY` edges exist; plan scope still comes from the model's proposal rather than a graph traversal. |

---

## 13. Suggested diagram set

1. **Flow** (§1) — the pipeline with the human gate, one slide, no boxes-within-boxes.
2. **Layers + boundaries** (§2) — with the four forbidden imports as red arrows. This is the architectural claim.
3. **Migration loop** (§5) — change sets, tool-established build, rules-first classification, bounded repair.
4. **Verification** (§6) — nine checks converging on one computed verdict, deployment gated behind seven of them.
5. **Deployment** (§10) — with §12 as a dotted "target state" overlay.

If only one: **§2**. Everything else in the product follows from those boundaries.
