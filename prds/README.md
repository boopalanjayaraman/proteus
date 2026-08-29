# Proteus — Increment PRDs

One PRD per increment. Written before implementation, amended during, and the record of
what was actually built after. `PRD-TEMPLATE.md` is the shape they all follow.

## How the work is split

Feature slices, not layers. Each increment after the foundations delivers something a
person can see working, because an increment that cannot be demonstrated cannot be
reviewed — and an increment nobody reviews is where scope quietly rots.

Three increments are foundations with no visible surface. They are marked as such rather
than dressed up with a screen they do not really deliver.

| # | PRD | Delivers | Visible on |
|---|---|---|---|
| 01 | Rules Engine | 110 rules evaluate deterministically; no model in the loop | — foundation |
| 02 | Persistence & Event Log | Product state survives restart; ordered, resumable events | — foundation |
| 03 | API Foundation, Auth & SSE | Authenticated REST, live stream that resumes by `seq` | — foundation |
| 04 | Frontend Shell & Design System | Sign-in, routing, theme, the persistent header | Login |
| 05 | Project Lifecycle & Credential Vault | Create a project, PAT to Secret Manager, project tiles | Landing · Create |
| 06 | Repository Access & Crypto Discovery | Clone read-only, detect crypto, produce findings | — foundation |
| 07 | Discovery Agent & Live Activity | The agent works unattended; the feed streams | Live Discovery |
| 08 | PQC Dependency Graph | Graph builds live, evidence-backed, inspectable | Live Discovery |
| 09 | Assessment, Plan & Recommendations | Findings, dispositions, plan, recommendations, report | Assessment |
| 10 | Human Approval Gate | One approval authorises the migration scope | Assessment |
| 11 | Branch, Baseline & Test Engineering | Branch, baseline contract, generated tests and mocks | Live Migration |
| 12 | Build/Test Loop, Diagnosis & Repair | Change → build → fail → diagnose → repair → retest | Live Migration |
| 13 | Deterministic Verification & Sandbox | Nine checks, then a running sandbox and E2E | Live Migration · Sandbox |
| 14 | Reports & Evidence Package | Assessment and migration reports, git diff, evidence | Sandbox & Report |

## Dependency order

```text
01 ─┬─► 06 ─► 07 ─► 08 ─┐
    │                    ├─► 09 ─► 10 ─► 11 ─► 12 ─► 13 ─► 14
02 ─┴─► 03 ─► 04 ─► 05 ─┘
```

01 and 02 are independent of each other. Everything from 06 onward is a chain: the
migration loop cannot be built before the plan it executes exists.

## Status

| PRD | Status |
|---|---|
| 01 | `DELIVERED` — written retroactively; the code exists and is tested |
| 02 | `DELIVERED` — 2026-08-29, 17 acceptance tests on a real replica set |
| 03 | `DELIVERED` — 2026-08-29, 19 acceptance tests on a real server |
| 04 | `DELIVERED` — 2026-08-29, 12 acceptance tests; shell renders and builds |
| 05 | `DELIVERED` — 2026-08-29, 18 acceptance tests; landing and create screens |
| 06–14 | `PLANNED` |

## Conventions

- **Traceability.** Every functional requirement names its source. A requirement with no
  source in the spec, the UX, or the data model is an open question, not a requirement.
- **Acceptance criteria are binary.** Verified by a test, a screen, or a command.
- **§10 is filled in as the work happens.** A deviation recorded is information; a
  deviation discovered later in the code is archaeology.
- **Out-of-scope items name where they land.** Deferring without a destination is how an
  increment grows until it never ships.
