# Autonomous PQC Migration Engineer
## Hackathon Prototype — Technology Stack

## 1. Technology Principles

The prototype should:

- satisfy the hackathon requirements explicitly;
- remain fast to build with Claude Code;
- minimize unnecessary infrastructure;
- use managed Google Cloud services where they materially help;
- keep the agent architecture simple and auditable;
- preserve clear extension points for the post-hackathon product.

The preferred implementation language is **TypeScript** across frontend and backend wherever practical.

---

## 2. Core Technology Stack

| Area | Technology | Purpose |
|---|---|---|
| Frontend | React + TypeScript | Product UI |
| Frontend Hosting | Firebase Hosting | Host the React application |
| Authentication | Firebase Authentication | Google Sign-In |
| Backend | Node.js + TypeScript | Product API and orchestration |
| Backend Hosting | Google Cloud Run | Host the backend API and agent service |
| Agent Framework | Google Genkit | Agent/tool orchestration |
| LLM | Gemini 3.5 Flash or newer eligible Gemini model | Planning, reasoning, diagnosis, migration decisions |
| Primary Database | MongoDB | Product state, findings, dependency graph, events, audit data |
| File Storage | Google Cloud Storage | Uploaded OT/IoT/HSM specs, reports, and source evidence artifacts |
| Git Integration | GitHub API / Git CLI | Repository access, branching, commits, diffs, optional PR creation |
| Build/Test Environment | Google Cloud Build | Compile, test, mock, rebuild, and retest migrated applications |
| Container Registry | Google Artifact Registry | Store application images |
| Sandbox Hosting | Google Cloud Run | Deploy the migrated application for final runtime validation |
| Live Updates | Server-Sent Events (SSE) | Stream discovery and migration progress to the UI |
| Secrets | Google Secret Manager | Store GitHub, MongoDB, and other service credentials |
| Local Development | Claude Code | Rapid implementation of the prototype |

---

## 3. Hackathon Requirement Mapping

The architecture must explicitly demonstrate the following required Google technologies.

### Gemini

Use an eligible **Gemini 3.5 or newer model** for agent reasoning.

Primary responsibilities:

- understand the application;
- reason over crypto findings;
- build the migration plan;
- interpret dependency relationships;
- diagnose build/test failures;
- decide the next migration action;
- determine when a human gate is required.

Gemini must not independently declare build, test, crypto, or deployment success.

---

### Google Agent Framework

Use **Google Genkit**.

Genkit is the orchestration layer between Gemini and deterministic tools.

Example agent tools:

```text
read_repository
search_repository
scan_crypto
analyze_dependencies
analyze_documents
build_dependency_graph
create_branch
apply_patch
run_build
run_tests
verify_crypto_state
deploy_sandbox
run_e2e_test
```

---

### Google Cloud Infrastructure

Use **Google Cloud Run** as the primary backend hosting service.

Additional Google Cloud services used by the prototype:

```text
Firebase Authentication

Firebase Hosting

Google Cloud Run

Google Cloud Build

Google Cloud Storage

Artifact Registry

Secret Manager
```

---

## 4. Frontend

### Technology

```text
React
TypeScript
```

### Responsibilities

The frontend implements:

- Google sign-in;
- project landing page;
- project creation;
- file upload;
- live discovery view;
- crypto/PQC dependency graph;
- assessment/report review;
- migration approval;
- live migration view;
- audit timeline;
- migration report access;
- sandbox application link.

The frontend should not contain migration business logic.

---

## 5. Authentication

### Technology

```text
Firebase Authentication
Google Sign-In
```

### Authentication Flow

```text
User
  ↓
React application
  ↓
Google Sign-In
  ↓
Firebase Authentication
  ↓
Firebase ID Token
  ↓
Node.js backend
  ↓
Firebase Admin SDK verifies token
  ↓
Authenticated Firebase UID
```

The Firebase UID is used as the application user identifier.

MongoDB records should be scoped by this UID.

Example:

```json
{
  "ownerId": "firebase-user-uid",
  "projectId": "PQC-0184",
  "name": "Payment API PQC Migration"
}
```

Firebase Authentication answers:

> Who is the user?

MongoDB answers:

> What projects and migration data belong to the user?

Firestore is not required.

---

## 6. Backend

### Technology

```text
Node.js
TypeScript
```

Recommended lightweight backend framework:

```text
Fastify
```

or:

```text
Express
```

Do not introduce a heavy framework unless Claude Code materially benefits from it.

### Responsibilities

The backend handles:

- authenticated APIs;
- project lifecycle;
- file metadata;
- Genkit agent invocation;
- tool execution;
- event persistence;
- event streaming;
- MongoDB access;
- GitHub integration;
- Cloud Build execution;
- Cloud Run sandbox deployment;
- report generation.

---

## 7. Agent Layer

### Technology

```text
Google Genkit
Gemini
```

### Design

Use one primary orchestrating agent.

Do not create multiple agents simply to make the architecture appear more agentic.

The agent owns two main workflows:

```text
Discovery Workflow
```

and:

```text
Migration Workflow
```

### Discovery Workflow

Gemini may:

- inspect evidence;
- request additional repository context;
- correlate code and documents;
- classify crypto usage;
- identify migration impact;
- build dependency relationships;
- generate findings;
- propose the migration plan.

This workflow remains read-only.

### Migration Workflow

After human approval, Gemini may:

- create migration strategy;
- modify source;
- modify approved dependencies;
- generate tests;
- create/repair mocks;
- diagnose failures;
- choose another implementation approach;
- revert failed experiments;
- trigger another build/test cycle.

---

## 8. MongoDB

### Role

MongoDB is the primary application database.

Do not introduce a graph database for the hackathon.

### Suggested Collections

```text
users

projects

project_files

findings

graph_nodes

graph_edges

assessments

migration_plans

migration_runs

migration_changes

test_runs

diagnoses

events

human_gates

verification_results

sandbox_deployments

reports
```

For rapid implementation, some of these may initially be embedded within a project document.

---

## 9. Dependency Graph Storage

Store the PQC/security dependency graph in MongoDB.

Example node:

```json
{
  "id": "node-17",
  "projectId": "PQC-0184",
  "type": "CRYPTO_IMPLEMENTATION",
  "name": "RSA Key Transport",
  "migrationStatus": "MIGRATION_REQUIRED",
  "evidence": [
    {
      "type": "SOURCE_CODE",
      "source": "src/security/CryptoService.java:48",
      "classification": "OBSERVED",
      "confidence": 1.0
    }
  ]
}
```

Example edge:

```json
{
  "id": "edge-5",
  "projectId": "PQC-0184",
  "from": "api-service",
  "to": "hsm-01",
  "relationship": "STORES_KEY_IN",
  "evidence": [
    {
      "type": "DOCUMENT",
      "source": "Security Architecture.pdf, page 17",
      "classification": "OBSERVED"
    }
  ]
}
```

The frontend receives graph nodes and edges directly from the backend.

---

## 10. File Storage

### Technology

```text
Google Cloud Storage
```

Use Cloud Storage for uploaded artifacts such as:

- OT specifications;
- IoT specifications;
- HSM specifications;
- architecture PDFs;
- existing findings;
- CBOM exports;
- security assessment reports.

MongoDB stores metadata and references to the Cloud Storage objects.

Do not store large source documents directly inside MongoDB.

---

## 11. GitHub Integration

### Prototype Scope

Support one repository per project, authorised by a **per-project GitHub fine-grained
personal access token** collected on the create-project screen (UX v1.2).

Required scopes, as shown to the user:

```text
contents: read & write
pull_requests: write
metadata: read
```

The token is stored in Secret Manager as `proteus-{projectId}-github-pat` and is never
persisted to MongoDB, never returned to the browser, and never written to a log. See
§15 and the data model §3.2.

One token per project rather than one for the deployment: a leak or a revocation then
affects a single migration, and every push is attributable to the project that made it.

### Required Operations

```text
clone repository

read repository

resolve current commit

create migration branch

commit changes

push branch

generate code links

retrieve diff
```

Optional stretch goal:

```text
create pull request
```

### Deferred

Do not implement for the hackathon:

- generic GitHub OAuth;
- GitLab;
- Bitbucket;
- enterprise SCM administration.

---

## 12. Build and Test Execution

### Technology

```text
Google Cloud Build
```

Cloud Build acts as the disposable engineering/test environment.

Use it for:

```text
install dependencies

compile

run unit tests

start mocks/test dependencies

run integration tests

run generated regression tests

collect logs

produce structured test evidence
```

The migration agent explicitly triggers Cloud Build.

A failed build/test run returns evidence to Gemini.

Gemini diagnoses the failure and may initiate another migration attempt.

---

## 13. Sandbox Deployment

### Technologies

```text
Artifact Registry
Cloud Run
```

After migration verification:

```text
Migration branch
      ↓
Cloud Build
      ↓
Container image
      ↓
Artifact Registry
      ↓
Cloud Run sandbox
      ↓
E2E verification
```

The resulting Cloud Run service is a sandbox environment only.

It is not production deployment.

---

## 14. Event Streaming

### Technology

```text
Server-Sent Events (SSE)
```

SSE is preferred for the prototype because communication is primarily:

```text
Backend → Frontend
```

Use it for:

- discovery progress;
- graph updates;
- findings;
- migration milestones;
- test status;
- diagnosis;
- repair status;
- deployment state.

Events must also be persisted in MongoDB.

The event stream is not the system of record.

---

## 15. Secrets

### Technology

```text
Google Secret Manager
```

Two kinds of secret, with different lifecycles.

**Deployment secrets** — one set for the whole service, created at provisioning time:

- MongoDB connection string;
- Gemini API key (unless using Vertex AI with ADC);
- third-party API credentials if required.

**Per-project secrets** — created and destroyed with the project they belong to:

- `proteus-{projectId}-github-pat` — the repository access token (UX v1.2).

The per-project secret is written once during project creation and read only by the
GitHub adapter, at the moment of a call, by secret name. Its version is **pinned rather
than `latest`**: a migration that begins under one token and finishes under another
cannot be audited, because the evidence package could not say which credential wrote
the branch. Rotation creates a new version; runs already in flight keep theirs.

Destroying a project destroys its secret. An orphaned secret is a live credential
nobody is watching.

Never expose any of these to the React frontend. Values the browser needs are prefixed
`VITE_` and are inlined into the bundle at build time — see `src/frontend/.env.example`.

---

## 16. Authentication and Authorization Rule

Every backend request must:

1. receive Firebase ID token;
2. verify token using Firebase Admin SDK;
3. identify Firebase UID;
4. validate that the requested project belongs to that user.

For the hackathon, sophisticated RBAC is not required.

Simple project ownership is sufficient.

---

## 17. Technology Responsibilities Summary

```text
React
→ User experience

Firebase Authentication
→ User identity

Firebase Hosting
→ Frontend hosting

Node.js
→ Backend/API

Cloud Run
→ Backend runtime

Genkit
→ Agent orchestration

Gemini
→ Reasoning

MongoDB
→ Product state and graph

Cloud Storage
→ Uploaded artifacts

GitHub
→ Source control

Cloud Build
→ Engineering sandbox

Artifact Registry
→ Images

Cloud Run Sandbox
→ Migrated application

SSE
→ Live updates

Secret Manager
→ Credentials
```

---

## 18. Explicit Non-Goals

Do not add unless absolutely required:

```text
Kubernetes / GKE

Kafka

Temporal

Neo4j

Redis

PostgreSQL

Firestore

ServiceNow

Jira

multiple SCM providers

enterprise RBAC

multi-cloud execution
```

These may be valid future technologies but they are unnecessary for the hackathon prototype.

---

## 19. Final Stack

The recommended prototype stack is:

> **React + TypeScript + Firebase Authentication + Firebase Hosting + Node.js + TypeScript + Google Genkit + Gemini + MongoDB + Google Cloud Storage + GitHub + Cloud Build + Artifact Registry + Cloud Run + SSE + Secret Manager**

This stack satisfies the hackathon requirements while remaining intentionally small enough for rapid development.
