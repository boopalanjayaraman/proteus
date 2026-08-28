# Proteus — Repository & Folder Structure v1

Companion to `docs/pqc_migration_data_model_v1.md`.
Defines where code lives, what may import what, and how each folder maps to a
deployed artifact.

---

## 1. Decision: one Node/TypeScript backend, not a Node + Python split

The brief left this open. The call is **a single TypeScript backend**, with the AI
code isolated by module boundary rather than by process boundary.

**Why not a separate Python service.** The reasons are concrete, not stylistic:

- **The data model would fracture.** `docs/pqc_migration_data_model_v1.md` §8 makes
  Zod the single source of truth: one schema serves Mongo validation, the REST
  contract, *and* the Genkit tool signatures. A Python service means Pydantic
  restatements of ~21 collection shapes, kept in sync by hand. That is the single
  most expensive thing on this list, and it gets worse every time the model changes.
- **The agent is not compute-bound, it is IO-bound.** It clones, greps, patches,
  triggers Cloud Build, waits. There is no numerical or ML workload that Python
  would do better here.
- **Two runtimes cost two Dockerfiles, two Cloud Run services, two deploys, and an
  internal RPC contract** — real hours, at hackathon pace, for isolation that a
  directory boundary already provides.

**The one argument for Python, addressed.** Product Spec §45 labels the agent
"Google ADK + Gemini", while Tech Stack §3 specifies **Genkit**. These conflict,
and ADK is strongest in Python. This structure follows the Tech Stack document —
it is the more specific and later statement, it names Genkit explicitly in §2 and
§7, and Genkit's JS SDK takes Zod schemas directly as tool definitions, which is
exactly the design the data model already assumes. *If the hackathon rules require
ADK specifically, revisit this before writing agent code, not after.*

**What you asked for is still delivered.** AI code stays separate from CRUD — via
`src/backend/src/agent/` and an enforced import rule (§4), not a network hop. The
separation is checkable in CI and survives contact with a deadline.

**The extension point is preserved.** `agent/` reaches the database only through
`core/repositories/`. Extracting it into its own service later — Python or
otherwise — means replacing those calls with a client, not untangling a monolith.

---

## 2. Top-level layout

```text
proteus/
├── requirements/              product specification (unchanged, source of truth)
├── docs/                      architecture, tech stack, data model, this file
├── schema/                    @proteus/schema — shared data model, no runtime deps
├── src/
│   ├── backend/               @proteus/backend — Node + TypeScript + Genkit
│   └── frontend/              @proteus/frontend — React + TypeScript + Vite
├── deployment/                containers, Cloud Build pipelines, hosting config
├── scripts/                   one-off dev and bootstrap scripts
├── package.json               npm workspace root
└── tsconfig.base.json         shared compiler options + path aliases
```

Four rules this layout encodes:

1. **`schema/` sits outside `src/`** because it is consumed by both sides and by
   the Genkit tool definitions. It has no runtime dependency beyond Zod and never
   imports from `src/`.
2. **`requirements/` is never edited by implementation work.** It is the input.
3. **`deployment/` holds everything that produces or runs a container**, so the
   GCP surface is reviewable in one place.
4. **npm workspaces**, so the backend image installs backend dependencies only —
   a single root `package.json` would put React into the Cloud Run image.

---

## 3. `schema/` — the shared data model

```text
schema/
├── src/
│   ├── index.ts               barrel — the only import surface
│   ├── common.ts              primitives, timestamps, GCS path helpers
│   ├── enums.ts               every product enum, defined once
│   ├── ids.ts                 deterministic node/edge/finding/problem keys
│   ├── evidence.ts            shared citation store
│   ├── project.ts             project state root, uploaded files
│   ├── discovery.ts           findings, graph nodes, graph edges
│   ├── assessment.ts          assessment, plan items, migration policy, reports
│   ├── migration.ts           runs, baselines, attempts, changes, executions
│   ├── verification.ts        deterministic checks, sandbox deployments
│   ├── governance.ts          human gates, events, agent audit trail
│   └── collections.ts         collection names + index specifications
└── package.json
```

Imported everywhere as `@proteus/schema`. Kept free of Node built-ins so the
frontend can bundle it — this is why `ids.ts` uses readable composite keys rather
than a `node:crypto` hash.

---

## 4. `src/backend/` — API, agent, and deterministic tooling

```text
src/backend/
├── src/
│   ├── server.ts              Fastify bootstrap (Cloud Run service entrypoint)
│   ├── config/                env parsing, GCP project config, feature flags
│   │
│   ├── api/                   HTTP surface — thin, no business logic
│   │   ├── routes/            projects, files, discovery, migration, evidence, gates
│   │   ├── middleware/        Firebase token verification, project ownership
│   │   └── sse/               event stream handler + Mongo change-stream tail
│   │
│   ├── core/                  domain state. CRUD lives here. NO Gemini.
│   │   ├── repositories/      one per collection; the only place Mongo is touched
│   │   ├── services/          project lifecycle, stage transitions, gates, leases
│   │   └── events/            event emitter — persist first, then publish
│   │
│   ├── agent/                 ALL model-facing code. The AI boundary.
│   │   ├── flows/             discovery flow, migration flow (Genkit flows)
│   │   ├── tools/             Genkit tool definitions, Zod-typed from @proteus/schema
│   │   │   ├── repository/    clone, list, read, search, diff, branch, patch
│   │   │   ├── analysis/      crypto scan, dependency inspect, document analysis
│   │   │   └── execution/     trigger build, run tests, deploy sandbox
│   │   ├── prompts/           system instructions, versioned as files
│   │   └── diagnosis/         failure classification, problem-key derivation
│   │
│   ├── verification/          deterministic verification. NO Gemini, ever.
│   │   ├── checks/            one module per VerificationCheck
│   │   └── policy/            migration policy evaluation (regex rules as data)
│   │
│   ├── integrations/          external systems, each behind one adapter
│   │   ├── github/            clone, branch, commit, push, permalinks
│   │   ├── cloudbuild/        trigger, poll, parse structured failure evidence
│   │   ├── cloudrun/          sandbox deploy, startup probe
│   │   ├── storage/           GCS read/write using schema's gcsPath helpers
│   │   └── secrets/           Secret Manager access
│   │
│   ├── reports/               assessment + migration report generation
│   └── worker/                Cloud Run Job entrypoint — the migration run loop
│
├── test/
└── package.json
```

### Import rules — this is what keeps AI separate from CRUD

```text
api/            → core, reports, agent (start a flow only)
agent/          → core/repositories, integrations, @proteus/schema
verification/   → core/repositories, integrations, @proteus/schema
core/           → @proteus/schema                     (nothing else in-tree)
integrations/   → @proteus/schema, config

FORBIDDEN:  core/         → agent/
FORBIDDEN:  verification/ → agent/
FORBIDDEN:  agent/        → direct MongoDB driver access
```

The second rule is the load-bearing one. "Gemini reasons; tools establish truth"
becomes an import constraint rather than a hope: the verification layer *cannot*
consult the model, because it cannot import it. Enforce with
`eslint-plugin-import`'s `no-restricted-paths` or `dependency-cruiser` in CI.

`worker/` exists because the migration must outlive the HTTP request that
approved it (data model §6d). It shares all of the above and is deployed as a
Cloud Run Job.

---

## 5. `src/frontend/` — React

```text
src/frontend/
├── src/
│   ├── app/                   router, providers, Firebase Auth bootstrap
│   ├── screens/
│   │   ├── projects/          landing — project tiles, stage, action required
│   │   ├── create-project/    repo URL, uploads, AI instructions
│   │   ├── discovery/         live discovery + dependency graph (WOW moment 1)
│   │   ├── assessment/        findings, evidence browser, plan, approval gate
│   │   └── migration/         live autonomous migration (WOW moment 2)
│   ├── components/
│   │   ├── graph/             React Flow canvas, node/edge renderers, legend
│   │   ├── evidence/          citation chips, source viewer, document viewer
│   │   ├── activity/          live feed, audit trail drawer, stage timeline
│   │   └── ui/                shared primitives
│   ├── api/                   typed REST client + SSE client (resume by seq)
│   ├── hooks/                 useProject, useProjectStream, useGraph
│   └── lib/                   formatting, stage/impact display maps
├── public/
├── index.html
└── package.json
```

The API client's response types come from `@proteus/schema` — the same definitions
the backend validates against, so a shape change is a frontend compile error
rather than a runtime surprise during the demo.

---

## 6. `deployment/`

```text
deployment/
├── backend/
│   ├── Dockerfile             backend API service image
│   └── .dockerignore
├── worker/
│   └── Dockerfile             migration worker (Cloud Run Job) image
├── frontend/
│   ├── firebase.json          Firebase Hosting config
│   └── .firebaserc
├── cloudbuild/
│   ├── backend-deploy.yaml    build + push + deploy the API
│   ├── frontend-deploy.yaml   build + deploy hosting
│   ├── target-build-test.yaml the agent-triggered build/test cycle for the
│   │                          repository under migration
│   └── sandbox-deploy.yaml    migrated image → Artifact Registry → Cloud Run
└── gcp/
    ├── bootstrap.sh           enable APIs, create buckets, Artifact Registry repo
    └── iam.md                 service accounts and the roles each one needs
```

`target-build-test.yaml` is the one that is easy to overlook: it is not a pipeline
for *this* repository, it is the disposable engineering environment the agent
invokes against the application it is migrating (Product Spec §32).

---

## 7. Where the current files go

| Now | Destination | Note |
|---|---|---|
| `requirements/*.md` | unchanged | input, never edited |
| `docs/*.md` | unchanged | plus this file |
| `src/shared/schema/*.ts` | `schema/src/*.ts` | relative imports unaffected |
| `package.json` | root, converted to workspace root | |
| `tsconfig.json` | `tsconfig.base.json` + per-package configs | |

Nothing is deleted and no file content changes except workspace wiring.

---

## 8. Deliberately absent

- **`src/shared/`** — `schema/` is the shared layer. A second one becomes a
  junk drawer.
- **A demo application folder.** The repository under migration is a *separate*
  GitHub repo (Product Spec §49); the agent clones it at runtime. Keeping it here
  would blur the boundary the whole product depends on.
- **`server-python/`** — see §1. The slot is `src/backend/src/agent/`, extractable
  later if the ADK question forces it.
