# Autonomous PQC Migration Engineer
## Hackathon Prototype — System Architecture

## 1. Architecture Objective

The architecture should demonstrate an autonomous PQC engineering workflow while remaining small enough to build rapidly for the hackathon.

The system has two fundamentally different phases:

```text
DISCOVERY / ASSESSMENT
Read-only

        ↓ HUMAN APPROVAL

MIGRATION / VERIFICATION
Authorized reversible engineering
```

The architecture must preserve this boundary.

---

## 2. High-Level Architecture

```text
                         ┌──────────────────────┐
                         │       User           │
                         └──────────┬───────────┘
                                    │
                                    ▼
                         ┌──────────────────────┐
                         │ Firebase Auth        │
                         │ Google Sign-In       │
                         └──────────┬───────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────┐
│ React + TypeScript                                         │
│ Firebase Hosting                                           │
│                                                            │
│ • Projects                                                 │
│ • Create Project                                           │
│ • Live Discovery                                           │
│ • PQC Dependency Graph                                     │
│ • Assessment                                               │
│ • HITL Migration Approval                                  │
│ • Live Migration                                           │
│ • Reports                                                  │
└──────────────────────────────┬─────────────────────────────┘
                               │
                         REST + SSE
                               │
                               ▼
┌────────────────────────────────────────────────────────────┐
│ Node.js + TypeScript                                       │
│ Google Cloud Run                                           │
│                                                            │
│ API                                                        │
│ Project Service                                            │
│ Event Service                                              │
│ Auth Verification                                          │
│ Report Service                                             │
│                                                            │
│                  Google Genkit                             │
│                       │                                    │
│                       ▼                                    │
│                    Gemini                                  │
│                       │                                    │
│                 Migration Agent                            │
└──────────────┬───────────────┬──────────────┬──────────────┘
               │               │              │
               ▼               ▼              ▼
          MongoDB         Cloud Storage      GitHub
          Product         Uploaded docs      Repository
          state           OT/HSM specs       branches
          graph           reports            commits
          events
               │
               │
               ▼
        ┌─────────────────┐
        │ Cloud Build     │
        │                 │
        │ Build           │
        │ Tests           │
        │ Mocks           │
        │ Retests         │
        └────────┬────────┘
                 │
                 ▼
        ┌─────────────────┐
        │ Artifact        │
        │ Registry        │
        └────────┬────────┘
                 │
                 ▼
        ┌─────────────────┐
        │ Cloud Run       │
        │ Sandbox App     │
        └─────────────────┘
```

---

## 3. Core Architecture Principle

The system follows:

> **Gemini reasons. Deterministic tools establish truth.**

Gemini may determine:

- what needs investigation;
- migration sequence;
- likely root cause;
- next engineering action;
- whether a test/mock is obsolete;
- whether a human decision is required.

Gemini must not independently establish:

- source contents;
- Git state;
- build success;
- test success;
- crypto presence/absence;
- deployment success.

Those facts must come from tools.

---

## 4. Authentication Architecture

```text
User
  ↓
React
  ↓
Firebase Google Sign-In
  ↓
Firebase ID Token
  ↓
REST/SSE Request
  ↓
Cloud Run Backend
  ↓
Firebase Admin SDK
  ↓
Token Verified
  ↓
Firebase UID
  ↓
Project authorization
```

Each project is associated with an owner UID.

Example:

```json
{
  "projectId": "PQC-0184",
  "ownerId": "firebase-user-uid"
}
```

---

## 5. Primary Product Data

MongoDB is the system of record for product state.

It stores:

```text
Projects

Findings

Graph nodes

Graph relationships

Evidence metadata

Assessment

Proposed migration plan

Migration approval

Baseline state

Migration attempts

Changes

Test results

Failure diagnoses

Events

Human gates

Verification results

Sandbox metadata
```

Uploaded documents themselves are stored in Cloud Storage.

---

## 6. Project Lifecycle

The user-facing lifecycle is:

```text
CREATED
   ↓
ANALYZING
   ↓
ASSESSMENT READY
   ↓
AWAITING APPROVAL
   ↓
MIGRATING
   ↓
VERIFYING
   ↓
SANDBOX READY
   ↓
COMPLETED
```

Exceptional states:

```text
NEEDS HUMAN ACTION

FAILED
```

---

# Phase A — Discovery and Assessment

## 7. Create Project Flow

```text
User
  ↓
Create Project
  ↓
Repository URL
GitHub fine-grained PAT          ← UX v1.2
Hardware / OT / HSM documents    (optional)
Existing findings                (optional)
AI instructions                  (optional)
  ↓
Backend
  ↓
Persist project in MongoDB       ← token is NOT among the persisted fields
  ↓
Write PAT to Secret Manager      proteus-{projectId}-github-pat
  ↓
Persist secret REFERENCE on the project
  (secretName, pinned secretVersion, displayPrefix, declaredScopes, rotationDueAt)
  ↓
Upload documents to Cloud Storage
  ↓
Start discovery workflow
```

The token is accepted once, forwarded, and dropped. It is never assigned to a Project
field, never returned by an endpoint, and never written to an event or an agent action.
The GitHub adapter fetches it by secret name at the moment of each call.

The repository remains read-only during this phase.

---

## 8. Discovery Workflow

```text
                   Discovery Agent
                         │
        ┌────────────────┼─────────────────┐
        │                │                 │
        ▼                ▼                 ▼
     GitHub          Documents        Existing Findings
        │                │                 │
        ▼                ▼                 ▼
 Source / Config     OT / IoT / HSM     CBOM / Reports
 Dependencies        specifications      Security findings
        │                │                 │
        └────────────────┼─────────────────┘
                         │
                         ▼
                  Gemini Reasoning
                         │
                         ▼
             Crypto / PQC Dependency Model
                         │
             ┌───────────┼────────────┐
             ▼           ▼            ▼
          Findings     Graph      Migration Impact
```

---

## 9. Discovery Tools

The agent may invoke deterministic or bounded tools such as:

```text
clone_repository_readonly()

list_files()

read_file()

search_repository()

inspect_dependencies()

scan_crypto()

analyze_uploaded_document()

extract_existing_findings()

inspect_tests()

inspect_configuration()
```

The agent may repeatedly investigate without asking the user for permission.

---

## 10. Discovery Output

Discovery produces:

```text
Crypto findings

Usage classification

Affected source components

Dependencies

Protocols

Keys/certificates

HSM relationships

OT/IoT dependencies

Test coverage

External blockers

Evidence-backed dependency graph
```

---

## 11. Evidence Architecture

Every significant finding and graph relationship carries evidence.

Example:

```json
{
  "finding": "RSA-2048 key transport",
  "source": "src/security/CryptoService.java:48",
  "evidenceType": "SOURCE_CODE",
  "evidenceClass": "OBSERVED",
  "confidence": 1.0
}
```

Document-derived example:

```json
{
  "finding": "Signing key stored in HSM",
  "source": "Security Architecture.pdf, page 17",
  "evidenceType": "DOCUMENT",
  "evidenceClass": "OBSERVED"
}
```

Reasoned relationships may be:

```text
INFERRED
```

rather than:

```text
OBSERVED
```

---

## 12. Dependency Graph Architecture

The graph is stored as MongoDB nodes and edges.

Conceptually:

```text
Application
    │
    ├── USES ── RSA Key Transport
    │
    ├── DEPENDS_ON ── Crypto Library
    │
    ├── STORES_KEY_IN ── HSM
    │
    └── CONNECTS_TO ── Industrial Gateway
```

The graph is specifically focused on:

```text
Cryptography

PQC

Security

Protocols

Keys

Certificates

Hardware dependencies

Migration impact
```

It is not a generic architecture graph.

---

## 13. Live Discovery Streaming

The backend persists events and simultaneously streams meaningful events to the frontend.

Example:

```text
REPOSITORY_ANALYSIS_STARTED

CRYPTO_FINDING_DETECTED

DEPENDENCY_DISCOVERED

HSM_DEPENDENCY_DISCOVERED

GRAPH_NODE_ADDED

GRAPH_RELATIONSHIP_ADDED

MIGRATION_BLOCKER_IDENTIFIED
```

Frontend updates:

- live activity;
- findings;
- dependency graph.

MongoDB remains the source of truth.

---

## 14. Assessment Generation

Once discovery is sufficient:

```text
Findings
   +
Dependency Graph
   +
Uploaded Evidence
   +
Migration Policy
   ↓
Gemini
   ↓
Proposed Migration Plan
```

Each finding receives a proposed disposition:

```text
AUTONOMOUS MIGRATION

ASSISTED MIGRATION

NO CHANGE REQUIRED

VENDOR DEPENDENCY

HARDWARE REPLACEMENT

HUMAN DECISION REQUIRED

NEEDS FURTHER INVESTIGATION
```

---

## 15. HITL Boundary

No source modification happens before approval.

Screen 3 presents:

```text
What exists?

What is vulnerable?

What needs to change?

What will the agent change?

What will the agent not change?

What blockers remain?
```

The user explicitly approves:

```text
PROCEED WITH MIGRATION
```

This approval authorizes reversible engineering work on a new branch and in disposable environments.

---

# Phase B — Autonomous Migration

## 16. Migration Authorization

After approval:

```text
Project
   ↓
Approved Migration Plan
   ↓
Autonomous Migration Workflow
```

The agent may now:

- create a branch;
- modify code;
- modify approved dependencies;
- generate tests;
- create/repair mocks;
- compile;
- run tests;
- diagnose failures;
- retry;
- revert failed approaches;
- deploy sandbox instances.

---

## 17. Git Architecture

```text
Original Repository
      │
      │ untouched
      ▼
Base Commit
      │
      ▼
Migration Branch
agent/pqc/{project-id}
      │
      ├── commits
      ├── tests
      ├── mocks
      ├── dependency changes
      └── source changes
```

All autonomous engineering occurs on the migration branch.

---

## 18. Baseline Capture

Before modifying the implementation:

```text
Original Commit
      ↓
Build
      ↓
Existing Tests
      ↓
Capture Existing Failures
      ↓
Capture Behavioral Invariants
      ↓
Persist Baseline
```

The baseline becomes part of migration verification.

The agent cannot silently alter valid baseline behavior.

---

## 19. Migration Agent Loop

```text
                    Approved Plan
                         │
                         ▼
                       PLAN
                         │
                         ▼
                       PATCH
                         │
                         ▼
                      BUILD
                    ┌────┴────┐
                    │         │
                  FAIL       PASS
                    │         │
                    ▼         ▼
                DIAGNOSE     TEST
                    │       ┌──┴───┐
                    │       │      │
                    │     FAIL    PASS
                    │       │      │
                    └───────┘      ▼
                              CRYPTO VERIFY
                                  │
                            ┌─────┴─────┐
                            │           │
                          FAIL        PASS
                            │           │
                            ▼           ▼
                        DIAGNOSE     SANDBOX
                                        │
                                        ▼
                                      E2E
                                        │
                                        ▼
                                    COMPLETE
```

---

## 20. Build/Test Runtime

Cloud Build is the primary autonomous engineering sandbox.

```text
Migration Branch
       ↓
Cloud Build
       │
       ├── dependency install
       ├── compile
       ├── unit tests
       ├── mocks/test services
       ├── integration tests
       └── evidence extraction
```

Each Cloud Build run corresponds to a migration attempt or validation cycle.

---

## 21. Failure Path

Example:

```text
Integration Test
      ↓
FAIL
      ↓
Structured Failure Evidence
      ↓
Gemini Diagnosis
      ↓
MOCK_INCOMPATIBILITY
      ↓
Patch Mock
      ↓
Commit
      ↓
Cloud Build Again
      ↓
PASS
```

The agent does not ask for permission for this reversible test-environment repair.

---

## 22. Structured Failure Evidence

The build/test layer returns structured data such as:

```json
{
  "attempt": 2,
  "phase": "integration_test",
  "exitCode": 1,
  "failedTest": "PartnerHandshakeIntegrationTest",
  "error": "Unsupported key exchange ML_KEM_768",
  "relevantLogs": [
    "Expected RSA_PUBLIC_KEY",
    "Received ML_KEM_PUBLIC_KEY"
  ]
}
```

Gemini uses this evidence for diagnosis.

---

## 23. Human Gate Architecture

A migration stops for human input only when crossing a consequential boundary.

Examples:

```text
BUSINESS_BEHAVIOR_CHANGE

EXTERNAL_PROTOCOL_CHANGE

SECURITY_DEGRADATION

MATERIAL_PERFORMANCE_TRADEOFF

UNAUTHORIZED_SYSTEM_ACCESS

HARDWARE_REPLACEMENT

VENDOR_DECISION

MATERIAL_ARCHITECTURE_DECISION
```

A human gate is persisted in MongoDB.

Other independent migration work may continue where possible.

---

## 24. Deterministic Verification

The verification service checks:

```text
Baseline behavior preserved?

Build passed?

Required tests passed?

Legacy prohibited crypto removed?

Required PQC implementation detected?

Migration policy satisfied?

Critical unresolved blocker absent?
```

Only deterministic verification can mark the code migration as verified.

---

## 25. Sandbox Deployment Architecture

After verification:

```text
Verified Migration Branch
       ↓
Cloud Build
       ↓
Container Image
       ↓
Artifact Registry
       ↓
Cloud Run
       ↓
Sandbox Application
       ↓
E2E Test
```

Successful E2E verification results in:

```text
SANDBOX READY
```

The UI receives the sandbox URL.

---

## 26. Completion Criteria

The system must not equate:

```text
Tests Pass
```

with:

```text
Migration Verified
```

Completion requires:

```text
Baseline behavior preserved
        +
Build success
        +
Automated tests
        +
Crypto verification
        +
Migration policy verification
        +
Sandbox startup
        +
E2E verification
```

Then:

```text
VERIFIED MIGRATION
```

---

## 27. Event Architecture

Events are persisted first and streamed second.

```text
Agent / Tool
    ↓
Event Service
    ↓
MongoDB
    ↓
SSE Stream
    ↓
React
```

Typical events:

```text
PROJECT_CREATED

SOURCE_ANALYSIS_STARTED

CRYPTO_FINDING_DETECTED

GRAPH_NODE_ADDED

ASSESSMENT_READY

MIGRATION_APPROVED

BRANCH_CREATED

BASELINE_CAPTURE_COMPLETED

TEST_CREATED

MOCK_CREATED

PATCH_APPLIED

BUILD_FAILED

FAILURE_DIAGNOSED

AUTONOMOUS_REPAIR_COMPLETED

BUILD_PASSED

TEST_PASSED

CRYPTO_VERIFICATION_PASSED

SANDBOX_DEPLOYMENT_READY

MIGRATION_COMPLETED
```

---

## 28. Resumability

The workflow must survive browser refreshes and reconnects.

```text
Browser reconnect
      ↓
GET project state
      ↓
MongoDB
      ↓
Reconstruct:
• current stage
• findings
• graph
• migration attempts
• audit timeline
• verification
      ↓
Reconnect SSE
```

The frontend never owns workflow state.

---

## 29. Report Architecture

Two reports are generated.

### Assessment Report

Generated before migration approval.

Contains:

```text
Findings

Evidence

Dependency graph

Migration impact

Proposed migration plan

External blockers

OT / IoT / HSM analysis
```

### Migration Report

Generated after migration.

Contains:

```text
Approved scope

Baseline

Branches / commits

Tests generated

Mocks generated or modified

Code changes

Dependency changes

Build/test attempts

Failures and diagnoses

Autonomous repairs

Crypto verification

Remaining blockers

Sandbox deployment

E2E verification
```

---

## 30. Security Boundaries

### Read-only phase

Before human approval:

```text
Repository: READ

Documents: READ

Git branch creation: NO

Source modifications: NO

Deployment: NO

Credentials: SERVER-SIDE ONLY — never returned to the browser
```

### Approved migration phase

After approval:

```text
Migration branch: READ / WRITE

Tests: READ / WRITE

Mocks: READ / WRITE

Disposable build environment: EXECUTE

Sandbox: DEPLOY

Original branch: READ ONLY

Production: NO ACCESS
```

---

## 31. Service Responsibilities

### React

```text
User interaction
Live visualization
Dependency graph
Assessment
Approval
Migration monitoring
Reports
```

### Node.js Backend

```text
API
Authentication enforcement
Project state
Agent lifecycle
Tool invocation
Events
Reports
```

### Genkit + Gemini

```text
Reasoning
Planning
Diagnosis
Migration strategy
Human-gate decisions
```

### MongoDB

```text
Projects
Findings
Graph
Evidence metadata
Events
Migration state
Audit
```

### Cloud Storage

```text
Uploaded specs
Reports
Supporting files
```

### GitHub

```text
Source
Branch
Commits
Diff
Optional PR
```

Authenticated per project with the PAT held in Secret Manager. The adapter is the only
component that reads it, and it holds it for the duration of a call — never on a
document, never on the run.

### Secret Manager

```text
Deployment secrets   MongoDB URI, Gemini key
Per-project secrets  proteus-{projectId}-github-pat  (created with the project,
                     destroyed with it, version pinned per migration run)
```

### Cloud Build

```text
Build
Tests
Mocks
Engineering sandbox
```

### Artifact Registry

```text
Container images
```

### Cloud Run

```text
Backend API
Migrated sandbox application
```

---

## 32. Deployment Topology

```text
Firebase Hosting
    │
    └── React Frontend

Cloud Run
    │
    ├── Node Backend / Genkit Agent
    │
    └── Migrated Sandbox App(s)

MongoDB
    │
    └── Product state

Cloud Storage
    │
    └── Uploaded documents

Cloud Build
    │
    └── Build/test jobs

Artifact Registry
    │
    └── Sandbox images
```

---

## 33. Prototype Simplifications

The hackathon architecture intentionally supports:

```text
One primary programming language

One core migration scenario

One controlled GitHub integration

One PQC migration policy

One build environment

One sandbox target

Simple MongoDB graph model
```

No distributed orchestration platform is required.

---

## 34. Future Extension Interfaces

The architecture should allow later introduction of:

```text
CodeQL

CBOM systems

Multiple SCM systems

Multiple languages

PKI migration

Certificate inventory

HSM integration

OT / IoT fleet analysis

Vendor intelligence

Enterprise approval workflows

Multiple sandbox providers

Production deployment workflows

Organization-wide migration campaigns
```

These are extension points only and should not increase hackathon implementation scope.

---

## 35. Final Runtime Story

The architecture should enable this complete experience:

```text
User signs in
      ↓
Creates project
      ↓
Uploads repository + evidence
      ↓
Agent analyzes everything
      ↓
Live PQC dependency graph appears
      ↓
Assessment generated
      ↓
User reviews evidence
      ↓
User approves migration once
      ↓
Agent creates branch
      ↓
Captures baseline
      ↓
Generates tests/mocks
      ↓
Changes code
      ↓
Builds
      ↓
Tests fail
      ↓
Agent diagnoses
      ↓
Agent repairs
      ↓
Tests pass
      ↓
Crypto verification passes
      ↓
Sandbox application deployed
      ↓
E2E test passes
      ↓
User receives:
• sandbox URL
• Git diff
• assessment report
• migration report
```

The central architecture principle remains:

> **Understand first. Approve once. Execute autonomously. Verify deterministically.**
