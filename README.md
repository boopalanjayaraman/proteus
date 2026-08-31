# Proteus

**An autonomous post-quantum cryptography migration agent.** Give it a repository URL; it returns a migrated, tested, verified application running in a sandbox — with the evidence for every claim it makes.

Not a scanner. A scanner produces a spreadsheet of every file containing "RSA" and stops exactly where the work begins.

---

## The problem

In August 2024, NIST published FIPS 203/204/205 — the first post-quantum cryptographic standards. NIST IR 8547 set the clock: RSA and ECC **deprecated by 2030, disallowed by 2035**. "Harvest now, decrypt later" makes that deadline retroactive, because traffic captured today is decrypted the day a cryptographically relevant quantum computer exists.

Every organisation that moves money, health records or identity now has the same problem, and it is not a research problem. It is an *engineering* problem, repeated:

- A large enterprise runs **hundreds to low thousands** of applications.
- Each needs its cryptography inventoried, classified **by usage**, migrated, and re-verified.
- By hand that is **days to weeks per application** — find the crypto, decide whether each usage is key transport or a signature, replace the primitive, discover the callers you broke, write the tests that were never there, prove nothing regressed.
- A 500-application estate is comfortably **a decade of engineer-years**.

Usage is the decision that matters. RSA carrying a session key **must** migrate to ML-KEM. RSA signing a settlement advice **must not** — it is a different workstream with different standards. On the reference application Proteus raises 12 findings and migrates 4, leaving three RSA signature usages, an HMAC, a SHA-256 digest, AES-at-rest and a TLS 1.3 config deliberately untouched, each with a cited rule.

Anyone can flag "RSA". The restraint is the product.

---

## What it does

```
Repository URL → Discovery → Assessment → ⟨HUMAN GATE⟩ → Migration → Verification → Sandbox → Evidence
                 read-only    read-only                   own branch    9 checks     live URL   package
```

**Discovery** (read-only) clones the repository, detects cryptographic usage, classifies each finding by what it is *for*, and builds a dependency graph. Every finding cites a permalink to the line it came from.

**One human gate.** Nothing is written until a person approves the plan, and the gate discloses every action the agent will take. Before approval the system holds a `GitHubReader`, which has no write methods; `GitWriter` is a different class constructed only afterwards. Read-only before approval is a *type*, not a promise.

**Autonomous migration**, on its own branch and never the original: capture a behavioural baseline from the existing tests, generate the characterization tests the repository was missing, apply the migration, build, run the suite, diagnose failures against rules, repair — looping until green or until a human is genuinely required.

**Verification.** Nine checks, each computed from tool evidence and none asserted by the model:

| | |
|---|---|
| `BASELINE_INVARIANTS_PRESERVED` | `PROHIBITED_CRYPTO_ABSENT` |
| `BUILD_SUCCESSFUL` | `REQUIRED_PQC_PRESENT` |
| `REQUIRED_TESTS_PASSED` | `MIGRATION_POLICY_SATISFIED` |
| `NO_CRITICAL_BLOCKER` | `SANDBOX_DEPLOYMENT_SUCCESSFUL` |
| | `E2E_VERIFICATION_SUCCESSFUL` |

A migration is "verified" only if **all nine** pass. Deployment is gated behind the other seven, so the sandbox cannot exist for a migration that failed.

**A running sandbox.** The migrated application is built, deployed, probed until it answers, and exercised end to end. The reference run's settlement endpoint returns `keyEstablishment=ML-KEM-768 · 1128 bytes` — 1088 bytes of ML-KEM ciphertext plus a 40-byte AES-wrapped session key. That line is the whole product: the cryptography changed, and the application still works.

**Measured on the reference application** (40 files, 36 tests): 9.1 minutes end to end, 5.8 after approval, **0 human engineering actions**, 12 findings, 4 migrated, 1 autonomous repair, 9/9 verified.

---

## Architecture

> **Gemini reasons. Deterministic tools establish truth.**

| Gemini MAY decide | Gemini MAY NOT establish |
|---|---|
| what to investigate | source contents |
| migration sequence | git state |
| likely root cause | build success · test success |
| next engineering action | crypto presence / absence |
| whether a human is needed | deployment success |

Every fact is typed `OBSERVED` (from a tool) or `INFERRED` (from the model). They are never the same kind of thing in the data model.

```
┌──────────────────────────────────────────────────────────────────────┐
│  BROWSER                                                             │
│  React 19 SPA · React Router 7 · Firebase Auth (Google sign-in)      │
│  Projects · Create · Discovery · Assessment · Migration ·            │
│  Sandbox & Report · Activity                                         │
└───────────────┬──────────────────────────────────────────────────────┘
                │ HTTPS · Bearer (Firebase ID token) · SSE for the live feed
┌───────────────▼──────────────────────────────────────────────────────┐
│  api/            Fastify 5 · CORS · auth · ownership · activity      │
│                  sse/stream.ts — resumable via Last-Event-ID         │
├──────────────────────────────────────────────────────────────────────┤
│  worker/         discoveryJob · assessmentJob · migrationJob         │
│                  migrationLoop · verificationJob · reportJob         │
│                  ← the ONLY layer allowed to see both core and agent │
├────────────────────────────┬─────────────────────────────────────────┤
│  agent/  (reasons)         │  core/  (establishes truth)             │
│  A1 discovery              │  rules/        114-rule engine          │
│  A2 assessment             │  discovery/    detectors, working copy  │
│  A3 testEngineering        │  migration/    baseline, invariants,    │
│  A3 migration              │                changeSets, testGuard,   │
│  A4 diagnosis              │                progress, roundTripProbe │
│     report (prose only)    │  services/     projects, approval,      │
│  model.ts  Genkit → Gemini │                lifecycle, dispositions  │
│  prompts/  tools/          │  repositories/ typed Mongo access       │
├────────────────────────────┴─────────────────────────────────────────┤
│  verification/   9 checks · e2e scenarios · policy                   │
│                  ✗ MAY NOT import agent/                             │
├──────────────────────────────────────────────────────────────────────┤
│  integrations/   github/ (reader + writer)   storage/ (GCS blobs)    │
│                  secrets/ (Secret Manager)   cloudbuild/ (executor)  │
│                  cloudrun/ (sandbox deployer — local Docker today;   │
│                             the Cloud Run path is unwired) gcp/      │
└──────────────────────────────────────────────────────────────────────┘
```

### Import boundaries — enforced by tests that fail the build

| Rule | Why |
|---|---|
| `core/` ✗→ `agent/` | Truth must not depend on reasoning |
| `verification/` ✗→ `agent/` | The verifier cannot consult the model it is judging |
| `agent/` ✗→ MongoDB driver | The agent reaches data only through repositories |
| only `worker/` + `server.ts` →`agent/` | One seam between reasoning and orchestration |

### Four agents, twelve model calls

Each agent is defined by what it **cannot** reach.

| | Agent | Cannot |
|---|---|---|
| **A1** | Discovery | hold a repository or a database driver — it returns decisions the caller persists |
| **A2** | Assessment | see the repository, or choose a disposition — that is passed in, never asked for |
| **A3** | Migration Engineer (test engineering, then patching) | see any file its approved plan item did not declare |
| **A4** | Diagnostic | write. It holds no write tool, and did not author the patch it judges |

A fifth call writes the report's prose and is permitted no number and no verdict. All twelve calls are recorded to `agent_actions` with prompt, response, tokens and latency.

**The loop is the orchestrator's, not the model's.** Genkit is used as a typed model client — one `generate` call per purpose, with a JSON schema derived from the Zod contract and re-validated on the way back. There is no model-driven tool loop: sequencing, retries, change sets and the retry budget are all deterministic code in `worker/migrationLoop.ts`, and a test asserts the model is never asked whether to continue.

**114 rules** extracted before the code: 40 standards rules from NIST FIPS 203/204/205, IR 8547 and CNSA 2.0, plus 74 execution rules. Every disposition, classification and refusal cites a rule ID.

📐 **[ARCHITECTURE.md](ARCHITECTURE.md)** — the migration loop, verification detail, deployment topology, and honest gaps.

---

## Tech stack

| Layer | Technology | Version |
|---|---|---|
| **Frontend** | React · React Router · Vite | 19.2 · 7.18 · 7 |
| | Firebase Auth (Google sign-in) | 12.18 |
| **Backend** | Node.js · TypeScript · Fastify | 22 · 5.9 strict · 5.12 |
| | Zod — Mongo validation + REST + agent tool schemas from one source | 4 |
| **Agent** | Genkit — used as a typed model client, not an agent framework | 1.41 |
| | Gemini 3.7 Flash via **Vertex AI** (ADC, no API key) | — |
| **Data** | MongoDB Atlas — replica set, change streams drive SSE | driver 7.6 |
| **Google Cloud** | Compute Engine · Cloud Storage · Secret Manager | — |
| | Vertex AI · Cloud Logging · Firebase Admin | — |
| **Build/runtime** | Docker — `maven:3.9-eclipse-temurin-17` for builds, and sandboxes run as local containers | — |
| | Caddy 2 — reverse proxy, automatic TLS | — |
| **Testing** | Vitest · mongodb-memory-server (real replica set, not mocks) | 2.1 |

```
schema/          Zod contracts shared by both runtimes
src/backend/     api · agent · core · worker · verification · integrations
src/frontend/    React SPA
engine/          114 rules (YAML) + provider capability data
fixtures/        payments-api (40 files) · settlement-api (12 files)
prds/            17 PRDs — each written before its increment
deployment/      GCP provisioning and deploy scripts
```

---

## Running it

**Prerequisites:** Node 22+, Docker (for migration builds and sandboxes), a MongoDB replica set, and a Google Cloud project with Vertex AI enabled.

```bash
git clone https://github.com/boopalanjayaraman/proteus
cd proteus
npm install
```

Configuration is validated **per feature group**, so the server starts with what you have and names what a missing feature needs:

| To use | You need |
|---|---|
| rules engine + tests | nothing |
| API, database, SSE | `CORE` |
| agents | `CORE` + `GEMINI` |
| build / test / sandbox | `CORE` + `GEMINI` + `GCP` + `GITHUB` |
| token verification | `FIREBASE` |

```bash
cp src/backend/.env.example  src/backend/.env    # backend only — never served to the browser
cp src/frontend/.env.example src/frontend/.env   # PUBLIC — Vite inlines VITE_* into the bundle
```

> ⚠️ Never put a Gemini key, GitHub token, service-account key or database URI in the frontend `.env`, and never prefix one `VITE_`. Anything `VITE_*` ships to the browser in readable JavaScript.

A **replica set is required, not optional** — the SSE fan-out tails a change stream, and a standalone `mongod` cannot open one. Atlas provides one on the free tier; local Docker needs `--replSet`.

```bash
npm run dev:api      # backend  → http://localhost:8080
npm run dev          # frontend → http://localhost:5173
```

Then open the frontend, sign in, and create a project from a repository URL. Migration builds run in Docker, so the daemon must be up.

### Deploying to GCP

```bash
deployment/gcp/provision-vm.sh      # Compute Engine + Caddy + automatic TLS
deployment/gcp/deploy-backend.sh    # refuses to run while a migration build is in flight
deployment/gcp/deploy-frontend.sh
```

`deployment/DEPLOYING-TO-GCP.md` documents the Cloud Run topology, which is designed but **not** the deployed path — see ARCHITECTURE.md §12 for what is wired and what is not.

---

## Trying the migration flow

Proteus pushes a migration branch, so it needs a repository **you own** and a token that can write to it. Fork one of the reference applications rather than pointing it at anything you care about.

**1 · Sign in.** Open Proteus and sign in with a Google account.

**2 · Fork a reference repository** into your own GitHub account:

| Repository | Size | Use it for |
|---|---|---|
| [settlement-api](https://github.com/boopalanjayaraman/settlement-api) | 12 files, 1–2 changes | the quick path — builds clean, finishes fast |
| [payments-api-sample](https://github.com/boopalanjayaraman/payments-api-sample) | 40 files, 36 tests | the full demonstration — signature usages that must be left alone, and two rigged failures the agent has to tell apart |

**3 · Create a Personal Access Token with write access** to your fork. Either kind works:

- **Fine-grained** (recommended) — *Only select repositories* → your fork → **Repository permissions**: `Contents: Read and write`, `Pull requests: Read and write`, `Metadata: Read-only`.
- **Classic** — the `repo` scope.

Read-only is not enough. The agent creates `agent/pqc/PQC-XXXX` and pushes commits to it; your default branch is never touched.

**4 · Create a project** in Proteus with your fork's URL and that token. Discovery and assessment run read-only — before you approve, the system holds a `GitHubReader`, which has no write methods at all.

**5 · Approve the plan** at the human gate. The gate lists every action the agent will take. This is the only decision you make.

Then watch it work. On `payments-api-sample` expect roughly **9 minutes** end to end: baseline capture, generated characterization tests, the migration, a build failure it diagnoses and repairs on its own, nine verification checks, and a live sandbox URL. Open the sandbox and hit the settlement endpoint — it reports `keyEstablishment=ML-KEM-768`.

> 🔐 **Your token.** It goes straight to Google Secret Manager as `proteus-{projectId}-github-pat`, at a concrete version number and never `latest`. What reaches the database is the secret's name, its version, and a 12-character display prefix so you can recognise it in the UI — never the token. No endpoint returns it, and the operational logger redacts the GitHub token pattern at the serialiser rather than at the call site, so a token cannot reach stdout by being logged somewhere nobody thought about. Revoke it when you are done; nothing here needs it afterwards.

---

## Testing it

```bash
npm test        # 667 tests — 519 backend, 148 frontend
npm run typecheck
npm run lint    # --max-warnings=0
```

**Tests need no configuration and no network.** `mongodb-memory-server` starts a real replica set rather than a mock, because change streams are the mechanism the live screens depend on — testing against a standalone would leave the thing most likely to break entirely unexercised.

> ⚠️ Run `npm test`, not `npx vitest` from the repository root. The root has no Vitest config, so a bare invocation misses the backend's `hookTimeout` and fabricates failures in suites that pass.

Some things worth knowing about what the suite asserts:

- **`test/architecture.test.ts`** enforces the import boundaries above, and fails the build if an authoring agent is ever asked to adjudicate its own guardrail.
- **`test/rules.test.ts`** exercises the 114-rule engine.
- **`test/loop.test.ts`** runs the reference scenario end to end against a scripted executor: baseline green, patch lands, the partner mock breaks, the agent repairs it, retest green — with the real parsing, classification and every guardrail running unmocked. Only the minutes of Maven are replaced.

Single file, or watch:

```bash
npm test -w @proteus/backend -- test/loop.test.ts
npm run test:watch -w @proteus/backend
```

### The fixtures

`fixtures/payments-api` (40 files, 36 tests) is a deliberately realistic Spring Boot payments service carrying quantum-vulnerable key transport, signature usages that must be left alone, and two rigged failures — a mock incompatibility and an expected behavioural change — so the agent must tell the classes of problem apart. `fixtures/settlement-api` (12 files) is the minimal version.

---

## Documentation

| | |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | layers, boundaries, the migration loop, deployment, honest gaps |
| [prds/](prds/) | 17 PRDs, each written before its increment |
| [engine/rulesets/](engine/rulesets/) | the 114 rules, as YAML |
| [fixes/](fixes/) | post-mortems, grouped by mistake rather than by file |
| [deployment/](deployment/) | GCP runbook and scripts |
