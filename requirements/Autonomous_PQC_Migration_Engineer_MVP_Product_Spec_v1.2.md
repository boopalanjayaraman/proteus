# Autonomous PQC Migration Engineer
## Hackathon Prototype — Product Specification v1.2

## 1. Product Goal

Build an autonomous engineering agent that can take an application repository, existing security/PQC findings, and relevant hardware/OT specifications, understand the application's cryptographic architecture, identify the changes required for post-quantum migration, and—after explicit human approval—perform as much of the migration as safely possible.

The product must demonstrate **real engineering action**, not merely analysis or recommendations.

The core workflow is:

**Create Project → Discover → Understand → Map Dependencies → Assess → Human Review → Branch → Establish Baseline → Test → Change → Build → Diagnose → Repair → Retest → Verify → Sandbox Deploy → Report**

The human should approve the migration plan once.

After approval, the human should not need to babysit normal engineering decisions.

---

## 2. Core User Journey

The prototype follows four primary screens:

```text
Landing / Projects
        ↓
Create Project
        ↓
Live Discovery & Dependency Mapping
        ↓
Assessment Report + Human Approval
        ↓
Live Autonomous Migration
        ↓
Verified Sandbox Application
```

Project stage and progress must persist so the user can return later and immediately understand the current state.

The browser is not the source of truth. Project state, findings, graph state, migration events, and evidence must be persisted in the backend.

---

## 3. Product Positioning

The product is not primarily a PQC scanner.

The larger problem is:

> Once an enterprise knows that vulnerable cryptography exists, how does it understand the impact, determine what can actually be changed, and safely execute the migration across software and dependent infrastructure?

The product therefore behaves as an:

# Autonomous PQC Migration Engineer

It first understands the application and its crypto/security dependencies.

Then, after review, it performs the migration work.

---

## 4. Landing Screen — Projects

The landing screen provides a view of all PQC migration projects created in the system.

Each project should expose enough information for the user to understand:

- project name;
- repository;
- current migration stage;
- overall status;
- latest activity;
- whether user action is required;
- whether discovery, assessment, migration, verification, or sandbox deployment has completed.

Users can:

- create a new migration project;
- open an existing project;
- continue a project requiring human action;
- view completed projects;
- access the latest report or migration result where available.

The project's current stage must also be reflected on its project entry/tile.

### User-facing project stages

```text
CREATED

ANALYZING

ASSESSMENT READY

AWAITING APPROVAL

MIGRATING

VERIFYING

SANDBOX READY

COMPLETED
```

Exceptional states:

```text
NEEDS HUMAN ACTION

FAILED
```

Internal workflow may contain finer-grained states, but these are the primary stages shown across the product.

---

## 5. Screen 1 — Create Migration Project

This screen creates the context within which the agent will operate.

The user provides:

### Project Information

- project name;
- repository URL of the application to be assessed and migrated.

### Repository Scope for Hackathon

For the prototype, support:

- a public repository; and/or
- one pre-authorized GitHub repository.

General GitHub OAuth, GitLab integration, enterprise source-control authentication, and multi-provider SCM support are deferred.

### Hardware / OT / Infrastructure Information

Allow the user to upload supporting files such as:

- OT equipment technical specifications;
- IoT device specifications;
- HSM specifications;
- appliance specifications;
- firmware documentation;
- architecture documents;
- security architecture documents;
- protocol documentation;
- other relevant hardware or infrastructure documentation.

These inputs allow the agent to understand dependencies that cannot be inferred purely from application source code.

### Existing Findings

Allow upload of existing analysis or findings such as:

- CBOM reports;
- cryptographic discovery reports;
- SAST findings;
- security assessments;
- vulnerability reports;
- architecture assessments;
- existing PQC-readiness reports.

The prototype does not need to support every external format structurally.

Files can initially be treated as contextual evidence.

### AI Instructions

Provide an instructions field where the user can supply project-specific information such as:

- migration constraints;
- systems that must not be changed;
- preferred migration approaches;
- known dependencies;
- specific areas to investigate;
- environment information;
- security requirements;
- test constraints.

### Project Creation

Once the inputs are submitted:

1. create the project;
2. persist its source inputs;
3. initialize project state;
4. begin discovery and analysis;
5. move the user into the live discovery screen.

No migration branch or application modification should occur at this stage.

---

## 6. Screen 2 — Live Discovery & Dependency Mapping

This is the first major autonomous-agent experience.

Once the project has been created, the agent begins working without requiring further user input.

This phase is **read-only and analytical**.

The screen continuously receives streaming updates from the backend describing what the system is currently analyzing and discovering.

The purpose of this stage is to build an increasingly accurate understanding of:

- application architecture;
- cryptographic implementation;
- crypto dependencies;
- PQC-relevant dependencies;
- security dependencies;
- external services;
- hardware dependencies;
- protocol relationships;
- existing tests;
- migration constraints.

This screen should provide the first major **WOW moment** of the prototype.

### Hard autonomy boundary

Before Screen 3 approval, the system may:

- read;
- inspect;
- analyze;
- correlate;
- classify;
- map;
- generate reports and proposed plans.

It must not:

- create a migration branch;
- change production source;
- modify dependencies;
- modify tests or mocks;
- deploy a migrated application.

---

## 7. Live Discovery Activities

The agent may autonomously:

- clone and inspect the repository;
- inspect project structure;
- inspect source files;
- identify frameworks and runtime;
- inspect dependencies;
- inspect cryptographic libraries;
- inspect crypto-related configuration;
- inspect certificate-related configuration;
- inspect authentication/security flows;
- locate uses of quantum-vulnerable algorithms;
- determine the usage context of those algorithms;
- inspect tests;
- inspect mocks;
- inspect build configuration;
- analyze uploaded findings;
- analyze uploaded hardware/OT/IoT specifications;
- correlate findings from multiple sources;
- identify external dependencies;
- identify hardware-controlled crypto;
- determine which components appear migration-relevant.

The live activity feed should communicate these operations and findings as they occur.

---

## 8. Usage-Specific PQC Classification

The system must not treat algorithm replacement as a simple name substitution.

A finding must include **how the cryptographic primitive is being used**.

For example:

```text
RSA-2048
Usage: key establishment / key transport
Target: ML-KEM-768
```

This is different from:

```text
RSA-2048
Usage: digital signature
Target: PQC signature algorithm
```

For the hackathon, deliberately construct the main demo around one technically unambiguous migration scenario, for example:

```text
RSA-based key transport
        ↓
ML-KEM-768
```

The prototype must not imply that every RSA occurrence maps to ML-KEM.

---

## 9. Security/PQC Dependency Graph

A major output of Screen 2 is a visual dependency graph.

The graph should be specifically focused on:

- cryptography;
- PQC migration impact;
- security relationships;
- crypto libraries;
- protocols;
- certificates;
- keys;
- HSMs;
- external services;
- OT/IoT devices;
- security appliances;
- other hardware dependencies.

This is not intended to be a generic application architecture diagram.

Its purpose is to answer:

> **What depends on what from a cryptographic and PQC-migration perspective?**

Example:

```text
Web Application
      │
      │ TLS
      ▼
API Service
      │
      ├──── RSA key transport ──── Crypto Library
      │
      ├──── signing key ────────── HSM
      │
      └──── secure channel ─────── Industrial Gateway
                                      │
                                      └── Vendor Firmware
```

The graph should progressively update as the agent learns more about the system.

---

## 10. Dependency Graph Node Types

The prototype should support a lightweight common model for nodes such as:

```text
APPLICATION

SERVICE

SOURCE COMPONENT

CRYPTO IMPLEMENTATION

CRYPTO LIBRARY

ALGORITHM

CERTIFICATE

KEY

PROTOCOL

API

DATABASE

EXTERNAL SERVICE

HSM

SECURE ELEMENT

OT DEVICE

IOT DEVICE

SECURITY APPLIANCE

VENDOR DEPENDENCY

TEST / MOCK
```

Relationships may include:

```text
USES

DEPENDS_ON

AUTHENTICATES_WITH

ENCRYPTS_WITH

SIGNS_WITH

STORES_KEY_IN

CONNECTS_TO

TESTED_BY

SIMULATED_BY

CONTROLLED_BY

REQUIRES_MIGRATION_WITH
```

A simple graph model is sufficient for the prototype.

No graph database is required.

---

## 11. Evidence-Backed Graph

Every significant graph node and relationship must retain evidence.

Each node/edge should support metadata such as:

```json
{
  "source": "src/security/CryptoService.java:48",
  "evidence_type": "SOURCE_CODE",
  "confidence": 1.0,
  "evidence_class": "OBSERVED"
}
```

or:

```json
{
  "source": "Security Architecture.pdf, page 17",
  "evidence_type": "DOCUMENT",
  "confidence": 0.83,
  "evidence_class": "INFERRED"
}
```

The system should distinguish:

- **OBSERVED** — directly established from source/config/specification;
- **INFERRED** — reasoned from available evidence and not directly confirmed.

This prevents the dependency graph from becoming an unauditable AI-generated architecture diagram.

The same evidence model should be reused by Screen 3.

---

## 12. Migration Impact Highlighting

As discoveries are made, affected graph elements should be classified.

Possible classifications:

```text
MIGRATION REQUIRED

MIGRATION LIKELY

NO PQC CHANGE REQUIRED

DEPENDENCY REQUIRES INVESTIGATION

VENDOR CONTROLLED

HARDWARE CONTROLLED

BLOCKED

UNKNOWN
```

The graph becomes the user's visual explanation of why particular code, infrastructure, or hardware is relevant.

---

## 13. Discovery Completion

When the agent determines that it has enough evidence to produce an assessment:

1. complete the discovery phase;
2. generate the assessment;
3. generate a proposed migration plan;
4. make the assessment report available;
5. update the project stage to:

```text
ASSESSMENT READY
```

The live screen should provide a link/action to open the report.

The system does **not** automatically begin modifying the application.

This is the first intentional human-in-the-loop boundary.

---

## 14. Screen 3 — Assessment & Migration Decision

Screen 3 is the user's review and decision point.

It functions as:

- PQC assessment report;
- migration dashboard;
- evidence browser;
- proposed migration plan;
- human approval gate.

The screen must clearly answer:

1. **What exists?**
2. **What is vulnerable or needs change?**
3. **What does the agent propose to change?**
4. **What will the agent not change or cannot safely change?**

---

## 15. Findings

Present findings in clear structured categories.

### Cryptographic Findings

- RSA usage;
- ECC/ECDH/ECDSA usage;
- vulnerable key-exchange mechanisms;
- certificate dependencies;
- cryptographic libraries.

### Application Findings

- affected source components;
- configuration;
- dependencies;
- protocols;
- test coverage.

### Hardware / Infrastructure Findings

- HSM dependencies;
- secure elements;
- OT devices;
- IoT devices;
- vendor-controlled cryptography;
- firmware-controlled crypto.

### Migration Deviations / Blockers

- unsupported dependency;
- externally controlled protocol;
- vendor dependency;
- unavailable PQC support;
- test deficiency;
- architecture constraint.

---

## 16. Finding Evidence and Attribution

Every significant finding must retain its source.

Examples:

```text
Finding:
RSA-2048 used for key establishment

Source:
src/security/CryptoService.java:48
```

or:

```text
Finding:
Hardware signing keys stored in HSM

Source:
Security Architecture.pdf
Page 17
```

or:

```text
Finding:
Industrial gateway supports RSA certificates only

Source:
Gateway-X200 Technical Specification
Section 8.4
```

Where practical, users should be able to click the source reference and inspect the underlying evidence.

For repository findings, provide links/references to the relevant code.

For uploaded documents, provide references to the originating document/location.

---

## 17. Proposed Migration Plan

Screen 3 must include an explicit proposed plan describing what the agent intends to do after approval.

Example:

```text
CryptoService
→ Autonomous migration
→ RSA key transport to ML-KEM-768

Crypto dependency
→ Autonomous update
→ Upgrade to approved compatible library version

Partner simulator
→ Test-environment adaptation
→ Update only if tests prove the mock represents obsolete behavior

HSM
→ No autonomous change
→ Capability not established from supplied specification

Industrial gateway
→ Vendor dependency
→ Retain as unresolved external migration item
```

The user approves this scope, not just a generic request to "start migration."

---

## 18. Migration Disposition

Each finding should have a proposed disposition such as:

```text
AUTONOMOUS MIGRATION

ASSISTED MIGRATION

NO CHANGE REQUIRED

VENDOR DEPENDENCY

HARDWARE REPLACEMENT

HUMAN DECISION REQUIRED

NEEDS FURTHER INVESTIGATION
```

For autonomously eligible items, the report should explain what the system expects to modify.

---

## 19. Assessment Report Download

Users should be able to download the assessment report.

The report should include at minimum:

- project information;
- repository information;
- analyzed inputs;
- findings;
- evidence/source attribution;
- dependency relationships;
- proposed migration plan;
- proposed migration scope;
- blockers;
- hardware/OT/IoT findings;
- recommendations.

---

## 20. Human Migration Approval

Screen 3 contains the explicit migration approval action.

Example:

**Proceed with Migration**

Before proceeding, inform the user that the autonomous migration phase will:

- create a migration branch;
- capture and validate the behavioral baseline;
- generate or extend automated tests where required;
- generate or modify mocks;
- validate the existing tests;
- modify source code;
- modify dependencies/configuration when appropriate;
- build the application;
- execute tests;
- inspect failures;
- autonomously attempt repairs;
- rebuild and retest;
- verify the resulting cryptographic state;
- deploy a verified build into a sandbox environment;
- provide a link to the sandbox-deployed application;
- produce a complete migration evidence report.

The user then confirms.

After confirmation, the agent is authorized to perform reversible engineering work inside the migration branch and sandbox without asking for routine approvals.

---

## 21. Screen 4 — Live Autonomous Migration

This screen is the second primary **WOW moment**.

Once the user approves migration, the agent begins autonomous engineering work.

The screen continuously streams meaningful updates such as:

- current stage;
- current activity;
- completed milestones;
- engineering actions;
- test results;
- failures;
- diagnoses;
- autonomous repairs;
- verification state.

The user should be able to understand what the autonomous engineer is doing without interacting with it.

---

## 22. Migration Stages

The live migration should expose meaningful milestones such as:

```text
PREPARING MIGRATION

CREATING BRANCH

CAPTURING BASELINE

ASSESSING TEST COVERAGE

CREATING / EXTENDING TESTS

PREPARING MOCKS

VALIDATING BASELINE TESTS

APPLYING MIGRATION CHANGES

BUILDING

RUNNING TESTS

ANALYZING FAILURE

REPAIRING

REBUILDING

RETESTING

CRYPTO VERIFYING

SANDBOX DEPLOYING

END-TO-END VERIFYING

COMPLETED
```

These are lifecycle milestones, not necessarily individual model calls.

---

## 23. Branch Creation

After approval:

1. create a new Git migration branch;
2. associate the branch with the migration project;
3. record the original commit;
4. record all subsequent autonomous modifications.

Example:

```text
agent/pqc/PQC-0184
```

The original branch remains untouched.

---

## 24. Baseline Behavioral Contract

Before modifying application behavior, establish a baseline.

The system should:

- run the original application/build where feasible;
- run existing tests;
- record existing passing/failing tests;
- capture key externally observable behavior relevant to the migration;
- identify security and crypto-related behavioral invariants;
- persist baseline evidence.

Conceptually:

```text
Original Commit
      ↓
Baseline Build
      ↓
Baseline Tests
      ↓
Behavioral Invariants Captured
      ↓
Migration Begins
```

Examples of invariants may include:

- existing API behavior;
- expected successful key establishment;
- expected failure conditions;
- message format where contractually fixed;
- required functional outcomes.

If migration requires changing a legitimate baseline behavioral requirement, the system must create a human gate.

---

## 25. Test and Mock Generation

The agent may autonomously:

- generate tests;
- add regression tests;
- add crypto-specific tests;
- generate fixtures;
- create mocks;
- modify mocks;
- create protocol simulators;
- adjust test infrastructure.

The goal is to produce sufficient automated evidence to confidently evaluate the migration.

The agent must not weaken legitimate behavioral requirements merely to achieve a passing result.

---

## 26. Anti-Test-Cheating Guardrail

Before modifying a test or mock, classify why it failed.

Example:

```text
Failure classification:
MOCK_INCOMPATIBILITY

Reason:
Mock represents the legacy RSA protocol while
the approved migration scope requires ML-KEM.

Baseline behavioral requirement changed?
NO

Safe autonomous modification?
YES
```

If instead:

```text
Baseline behavioral requirement changed?
YES
```

the system must create a human gate.

---

## 27. Migration Execution

The agent should execute migration changes incrementally where practical.

For each meaningful modification, maintain an audit record including:

- what was changed;
- why it was changed;
- files affected;
- associated finding;
- associated dependency;
- test evidence;
- result.

Example:

```text
Modification #3

Finding:
RSA-2048 key transport

Action:
Migrated CryptoService to ML-KEM-768

Files:
CryptoService.java
pom.xml

Reason:
Required by approved PQC migration policy

Build:
PASS

Integration test:
FAILED

Next action:
Investigating partner compatibility
```

---

## 28. Failure Diagnosis and Repair

When build/test/verification fails:

1. capture structured evidence;
2. analyze the root cause;
3. classify the failure;
4. determine whether it is inside the autonomous boundary;
5. modify the branch as appropriate;
6. rerun relevant checks;
7. continue.

Example:

```text
TEST FAILED

PartnerHandshakeIntegrationTest

Diagnosis:
Mock partner assumes legacy RSA handshake.

Classification:
MOCK_INCOMPATIBILITY

Autonomous action:
Update partner simulator.

Result:
RETESTING
```

The user should see this progress in the live stream.

The agent should not ask:

> Should I update the mock?

---

## 29. Failure Classification

Use categories such as:

```text
BUILD_DEFECT

IMPLEMENTATION_DEFECT

DEPENDENCY_INCOMPATIBILITY

CONFIGURATION_DEFECT

TEST_COVERAGE_GAP

TEST_FIXTURE_OUTDATED

MOCK_INCOMPATIBILITY

ENVIRONMENT_FAILURE

EXPECTED_BEHAVIOR_CHANGE

EXTERNAL_DEPENDENCY_BLOCKER

UNKNOWN
```

Certain categories may trigger a human gate.

---

## 30. Human Gates During Migration

Approval at Screen 3 authorizes routine migration engineering.

Additional human intervention should only be requested if the migration encounters something such as:

- intended business behaviour must change;
- baseline behavioral contract must materially change;
- public/external protocol must change;
- security must be weakened;
- material performance tradeoff is required;
- unauthorized infrastructure must be accessed;
- production access is required;
- hardware must be replaced;
- vendor selection/procurement is required;
- materially different architecture choices exist.

The migration should continue with unrelated eligible work wherever possible.

---

## 31. Autonomous Retry Policy

Set:

```text
MAX_MEANINGFUL_AUTONOMOUS_ATTEMPTS = 4
```

The limit applies to repeated attempts against the same unresolved problem.

The agent may freely perform routine command retries where appropriate.

If the meaningful-attempt limit is reached, create a clearly auditable human-action requirement.

---

## 32. Test Environment

Use a disposable engineering environment for repeated testing.

For the hackathon:

**Cloud Build** is the primary environment for:

- compiling;
- unit testing;
- integration testing;
- running mocks;
- validating dependencies;
- collecting execution evidence.

Typical flow:

```text
Migration Branch
       ↓
Cloud Build
       ↓
Compile
       ↓
Unit Tests
       ↓
Mocks / Dependencies
       ↓
Integration Tests
       ↓
Evidence
```

A test failure returns control to the agent.

The agent modifies the migration branch and triggers another validation cycle.

---

## 33. Structured Failure Evidence

Do not send enormous raw logs to Gemini by default.

Convert failures into compact structured evidence.

Example:

```json
{
  "attempt": 1,
  "phase": "integration_test",
  "command": "mvn verify",
  "exit_code": 1,
  "failed_test": "PartnerHandshakeIntegrationTest",
  "error": "Unsupported key exchange ML_KEM_768",
  "relevant_logs": [
    "Expected RSA_PUBLIC_KEY",
    "Received ML_KEM_PUBLIC_KEY"
  ]
}
```

Full logs remain available if deeper analysis is required.

---

## 34. Deterministic Verification

The agent cannot declare success based only on reasoning.

A deterministic verification layer must confirm:

```text
Baseline behavioral invariants preserved?

Build successful?

Required tests passed?

Prohibited cryptography absent?

Required PQC implementation present?

Migration policy satisfied?

Critical unresolved blocker present?

Sandbox deployment successful?

E2E verification successful?
```

Only verified tool output can mark a migration complete.

---

## 35. Migration Completion Rule

A migration is not considered verified merely because tests pass.

Completion requires:

```text
Baseline behavioral invariants preserved
            +
Build passes
            +
Automated tests pass
            +
Prohibited crypto usage removed
            +
Expected PQC implementation verified
            +
Migration policy satisfied
            +
Sandbox application starts
            +
E2E scenario passes
```

Only then:

```text
VERIFIED MIGRATION
```

---

## 36. Sandbox Deployment

After the migration passes the required build/test/security checks:

1. build the resulting application image;
2. deploy it into an isolated Cloud Run sandbox;
3. validate service startup;
4. run the required end-to-end tests;
5. retain a sandbox application URL for user review.

For the hackathon prototype, the application may remain available long enough for demonstration/review rather than being immediately destroyed.

The sandbox environment must not be represented as production.

---

## 37. Sandbox Application Link

Once successful, Screen 4 should expose access to:

**Tested Sandbox Application**

This is an important completion artifact.

The user can inspect the running migrated application after the agent has:

- modified it;
- rebuilt it;
- tested it;
- repaired it;
- verified it.

---

## 38. Live Activity vs Audit Trail

Screen 4 should not become terminal spam.

The product should distinguish:

### Live Activity Stream

Shows meaningful user-facing milestones such as:

```text
Analyzing failed integration test

Root cause identified:
legacy RSA assumption in partner mock

Updating test counterpart

Retesting
```

### Complete Audit Trail

Retains detailed evidence such as:

- exact command;
- commit;
- source diff;
- build output;
- failed test;
- structured logs;
- diagnosis;
- applied repair;
- verification evidence.

The UI communicates the engineering story clearly while the backend retains full auditability.

---

## 39. Migration Audit Trail

Every significant step must be auditable.

Maintain records of:

- branch created;
- baseline commit;
- baseline behavior;
- discovery finding;
- migration decision;
- tests created;
- mocks created;
- source modifications;
- dependency modifications;
- build executions;
- test executions;
- failures;
- diagnoses;
- autonomous repairs;
- verification results;
- sandbox deployment.

Each action should include appropriate timestamps and evidence references.

---

## 40. Migration Report

Screen 4 should allow the user to generate/download a final migration report.

The report should contain:

### Project Summary

- project;
- repository;
- source revision;
- migration branch.

### Original Assessment

- significant PQC/security findings;
- relevant dependency relationships.

### Approved Migration Plan

- approved migration scope;
- autonomous items;
- excluded items;
- vendor/hardware blockers.

### Baseline

- baseline build result;
- baseline tests;
- captured behavioral invariants.

### Migration Actions

For each modification:

- source finding;
- rationale;
- files changed;
- dependency changed;
- associated tests.

### Test Engineering

- tests added;
- mocks created;
- mocks changed;
- baseline result;
- final result.

### Autonomous Recovery

- failures encountered;
- diagnoses;
- actions taken;
- retry count.

### Security Verification

- legacy cryptography remaining;
- target PQC implementation;
- unresolved security issues.

### External Dependencies

- HSM issues;
- hardware issues;
- OT/IoT dependencies;
- vendor blockers.

### Runtime Verification

- sandbox deployment result;
- E2E verification result;
- sandbox application reference.

### Final Outcome

```text
VERIFIED

PARTIALLY MIGRATED

HUMAN ACTION REQUIRED
```

---

## 41. Event Streaming

Both live screens depend on backend events.

The backend should expose an event stream rather than requiring the frontend to infer workflow state.

Example events:

```text
PROJECT_CREATED

REPOSITORY_CLONED

SOURCE_ANALYSIS_STARTED

FILE_ANALYZED

DEPENDENCY_DISCOVERED

CRYPTO_FINDING_DETECTED

HARDWARE_DEPENDENCY_DISCOVERED

GRAPH_NODE_ADDED

GRAPH_RELATIONSHIP_ADDED

ASSESSMENT_COMPLETED

MIGRATION_APPROVED

BRANCH_CREATED

BASELINE_CAPTURE_STARTED

BASELINE_CAPTURE_COMPLETED

TEST_CREATED

MOCK_CREATED

PATCH_APPLIED

BUILD_STARTED

BUILD_PASSED

BUILD_FAILED

TEST_STARTED

TEST_PASSED

TEST_FAILED

FAILURE_DIAGNOSED

AUTONOMOUS_REPAIR_STARTED

AUTONOMOUS_REPAIR_COMPLETED

CRYPTO_VERIFICATION_STARTED

CRYPTO_VERIFICATION_PASSED

SANDBOX_DEPLOYMENT_STARTED

SANDBOX_DEPLOYMENT_READY

E2E_TEST_PASSED

MIGRATION_COMPLETED

HUMAN_GATE_REQUIRED
```

Server-Sent Events or WebSockets are sufficient for the prototype.

---

## 42. Resumable Project State

Streaming is not the persistence mechanism.

The backend must persist enough state to recover after:

- browser refresh;
- browser close/reopen;
- navigation back to landing screen;
- frontend reconnect;
- transient streaming disconnect.

When a user reopens a project, the UI should:

1. fetch current persisted project state;
2. reconstruct the graph, findings, migration progress, and audit history;
3. reconnect to the event stream for new events.

The workflow must not depend on the browser remaining open.

---

## 43. Project State

A project should retain at minimum:

```json
{
  "project_id": "PQC-0184",
  "name": "Payment API PQC Migration",
  "repository": "...",
  "stage": "MIGRATING",

  "inputs": {
    "hardware_documents": [],
    "existing_findings": [],
    "instructions": ""
  },

  "discovery": {
    "findings": [],
    "dependencies": [],
    "graph": {}
  },

  "assessment": {
    "proposed_migration_plan": []
  },

  "migration": {
    "approved": true,
    "branch": "agent/pqc/PQC-0184",
    "baseline": {},
    "attempts": [],
    "changes": []
  },

  "verification": {},

  "sandbox": {},

  "human_actions": []
}
```

---

## 44. Backend API

The prototype API should support the product workflow.

### Projects

```text
POST /projects

GET /projects

GET /projects/{id}
```

### Project Inputs

```text
POST /projects/{id}/files
```

### Discovery

```text
POST /projects/{id}/discover

GET /projects/{id}/graph

GET /projects/{id}/assessment
```

### Migration

```text
POST /projects/{id}/migration/approve

GET /projects/{id}/migration
```

### Evidence

```text
GET /projects/{id}/events

GET /projects/{id}/diff

GET /projects/{id}/report
```

### Human Gate

Optional:

```text
POST /projects/{id}/decisions/{decision_id}
```

---

## 45. Agent Architecture

Use one orchestrating migration agent.

```text
                    Project
                       │
                       ▼
               Migration Agent
             Google ADK + Gemini
                       │
       ┌───────────────┼────────────────┐
       │               │                │
       ▼               ▼                ▼

   Repository       Analysis         Execution
     Tools            Tools             Tools

   clone            crypto scan       build
   branch           dependency        test
   read             graph             mocks
   patch            documents         deploy
   diff             policy            verify
   revert
```

Do not introduce multiple agents merely for the appearance of agentic architecture.

Sub-agents can be introduced later if the implementation genuinely benefits from them.

---

## 46. Deterministic-First Principle

Gemini reasons.

Tools establish truth.

Gemini may reason about:

- architecture;
- affected components;
- migration sequence;
- root cause;
- test gaps;
- patch strategy;
- external blockers.

Tools must establish:

- actual source content;
- actual Git state;
- actual build status;
- actual test status;
- actual crypto presence;
- actual deployment status.

---

## 47. Core Agent Instruction

The agent should operate under a system instruction similar to:

> You are an autonomous PQC migration engineer operating inside an authorized and disposable engineering environment.
>
> Your objective is to complete as much migration work as safely possible without requiring human involvement in ordinary engineering decisions.
>
> You are authorized to inspect, modify, build, test, diagnose, generate tests, repair mocks, retry, and revert within the approved repository branch and sandbox.
>
> Do not ask the user for permission to perform reversible engineering work within those boundaries.
>
> Request human intervention only when the next action crosses an explicitly defined autonomy boundary.
>
> Never declare success based on reasoning alone.
>
> Build, test, deployment, baseline-preservation, and crypto-verification results must come from tool evidence.
>
> A failing test is evidence to investigate. Do not weaken valid behavioural assertions merely to make tests pass.

---

## 48. Hackathon Implementation Scope

The prototype should fully implement:

```text
Project creation

Repository analysis

Document upload/context

PQC/security dependency graph

Evidence attribution

Assessment

Explicit proposed migration plan

HITL migration approval

Git branch creation

Baseline behavior capture

Test/mocking workflow

Autonomous modification

Build/test/fix/retest loop

Deterministic verification

Sandbox deployment

Live event streaming

Resumable project state

Migration audit report
```

---

## 49. Simplifications Allowed

For rapid implementation:

- support one programming language;
- support one primary PQC migration scenario;
- use one demonstration repository;
- support a narrow crypto scanner;
- support generic PDF/document extraction instead of deep vendor-specific parsers;
- use simple graph JSON rather than a graph database;
- use SQLite/Firestore/simple persistence;
- support one cloud test environment;
- use one sandbox deployment target;
- support a public or pre-authorized repository only.

The product architecture should leave extension points, but those extension points do not need implementation.

---

## 50. Explicitly Deferred

Post-hackathon:

- organization-wide repository discovery;
- full CBOM integration;
- CodeQL enterprise integration;
- multiple languages;
- generic SCM authentication;
- full PKI migration;
- HSM remediation;
- real OT firmware modification;
- certificate fleet migration;
- vendor-management workflows;
- production deployment;
- enterprise RBAC;
- approval-chain configuration;
- Jira/ServiceNow;
- multi-cloud execution;
- organization-wide migration campaign management.

---

## 51. Prototype Definition of Done

The hackathon prototype is successful when a user can:

```text
Open application

      ↓

Create PQC migration project

      ↓

Provide repository +
supporting files +
instructions

      ↓

Watch agent autonomously
analyze the application

      ↓

Watch crypto/security dependency
graph build live with evidence

      ↓

Review attributed findings

      ↓

Review explicit migration plan

      ↓

Download assessment

      ↓

Approve migration once

      ↓

Watch agent create branch

      ↓

Watch baseline behavior captured

      ↓

Watch tests/mocks being prepared

      ↓

Watch migration changes being made

      ↓

Observe a real test failure

      ↓

Watch agent diagnose it

      ↓

Watch agent repair it

      ↓

Watch tests pass

      ↓

Watch deterministic verification pass

      ↓

Open tested sandbox application

      ↓

Download complete migration report
```

---

## 52. Demo WOW Moments

### WOW Moment 1

The agent autonomously understands the application and builds a **live crypto/PQC/security dependency graph** combining code, existing findings, and hardware/OT information.

Important graph relationships are evidence-backed and distinguish observed facts from inferred relationships.

### WOW Moment 2

After one human approval, the user watches an **autonomous engineering loop**:

```text
branch
→ capture baseline
→ establish tests
→ change
→ build
→ fail
→ diagnose
→ repair
→ retest
→ verify
→ deploy
```

The process ends with a functioning sandbox URL and a complete evidence package.

---

## 53. North-Star Metric

The prototype's primary measure is:

> **Percentage of eligible migration engineering work completed from approved finding to verified sandbox deployment without human engineering intervention.**

Discovery and assessment may require one human migration approval.

Once migration is approved, ordinary engineering work should proceed without further human intervention.

For the hackathon scenario:

```text
Eligible migrations        1
Completed autonomously     1
Human engineering actions  0

Autonomous completion      100%
```

---

## 54. Product Extension Points

The prototype intentionally supports:

```text
1 repository
1 language
1 primary migration pattern
1 test environment
1 optional device specification
```

The eventual product can expand toward:

```text
Thousands of repositories

Multiple languages

CBOM/SAST discovery integration

PQC migration campaigns

Certificate and PKI migration

HSM analysis

OT/IoT fleet assessment

Vendor dependency management

Enterprise approval workflows

Organization-wide migration tracking

Continuous crypto-agility management
```

Those capabilities should influence interfaces where useful, but must not increase prototype build time.

---

# Final Product Principle

The user experience should communicate:

> **First, the agent understands what you have and shows you exactly what needs to change, with evidence.**

> **You review and approve the proposed migration scope.**

> **Then it does the engineering work autonomously, proves that required behavior was preserved, and gives you a tested application to review.**

The prototype should prove one thing exceptionally well:

> **An AI agent can perform a bounded cryptographic migration as an autonomous engineer rather than behaving like an assistant that continually asks a human what to do next.**

The hackathon experience should be:

**Give it the context. Watch it understand. Approve once. Watch it work. Review the evidence.**
