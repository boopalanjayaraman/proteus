# PRD-17 · Project Lifecycle — Archiving and Deleting

| | |
|---|---|
| **Increment** | 17 |
| **Status** | `DELIVERED` |
| **Depends on** | PRD-05 (project lifecycle, credentials), PRD-15 (platform admin role, activity log), PRD-16 (sandbox capacity and teardown) |
| **Unblocks** | — |
| **Demoable outcome** | Archive a finished project: it goes read-only, its sandbox is released, its slot comes back. A platform admin deletes a test project and it disappears — with nothing orphaned behind it. |
| **Created** | 2026-08-29 |
| **Delivered** | 2026-08-29 |

---

## 1. Problem

A project can be created and it can be worked. It cannot be finished with, and it cannot
be removed — and the one endpoint that claims to remove it does damage.

**Archiving does not exist.** A completed migration stays indefinitely mutable: its
assessment can be regenerated, its gates re-resolved, its sandbox extended. There is no way
to say "this is done, keep the evidence, stop touching it", which is the state a reviewed
migration should end in.

**Deleting is a partial hard delete that looks total.** `DELETE /projects/:id` removes
three collections — `project_files`, `events`, `projects` — plus the credential and the
blobs. The model has **twenty-four**. Everything else survives its project:

```
evidence          discovery_runs     findings           graph_nodes
graph_edges       recommendations    assessments        migration_runs
baselines         migration_attempts problem_threads    migration_changes
execution_runs    verification_results  sandbox_deployments  human_gates
agent_actions     artifacts
```

Eighteen collections of rows pointing at a `projectId` that no longer resolves —
unreachable through any endpoint, and invisible to anyone looking for them.

**And it leaks a sandbox permanently.** `delete()` never calls the deployer, so a live
Cloud Run service and its Artifact Registry image outlive the project. The leak is
asymmetric: `SandboxCapacityService.state()` counts live deployments **globally** for the
platform total but attributes them per-user by joining back through `projects`. Delete the
project and the deployment still consumes one of the thirty platform slots forever, while
counting against nobody's three. Thirty deletions and the platform can never retain another
sandbox, with no project on any screen to explain why.

## 2. Sources of truth

| Source | Reference |
|---|---|
| Requirement | The archive and delete semantics stated by the product owner, quoted in §10 |
| Data model | §3.2 credential lifecycle — "destroyed with the project; an orphaned secret is a live credential nobody is watching" |
| PRD-15 | `User.role`, `PLATFORM_ADMIN_EMAILS`, and the activity log that must outlive what it records |
| PRD-16 / D-020 | Sandbox capacity caps what is **retained**; a released slot must actually come back |
| Deployment §4.3 | The sandbox identity, and why an unreferenced Cloud Run service is not merely untidy |

> The spec has no section on ending a project's life. Recorded honestly rather than
> citing something that does not say it.

## 3. Scope

**In**

- A **`lifecycle` field on `Project`**, separate from `stage`: `ACTIVE`, `ARCHIVED`,
  `DELETED`.
- **Archive** — the owner's action. Every option disabled, reports and data viewable,
  no sandbox deployment and no sandbox link. Irreversible in the application.
- **Delete** — platform admins only, and a **soft delete**: the project disappears from
  the product, and every row that referenced it keeps referencing something that still
  exists. Irreversible. For clearing test data and retesting.
- Releasing the sandbox and its capacity slot on both.
- Destroying the credential on delete, because a soft-deleted project must not leave a
  live token behind.
- A one-off sweep for the orphans and stranded slots that today's hard delete has already
  produced.

**Out** — and where it lands instead

- **Unarchiving and undeleting** → deliberately absent. "Irreversible from the
  application" is the requirement; a restore path turns both into filters nobody trusts.
  A database write can still do it, and that should feel like a different kind of act.
- **Hard purge** → a later, offline operation (§8 risk 4). Soft delete makes it *safe* to
  write, because the data model has no dangling references by construction — but nothing
  in the product needs to reclaim the space yet.
- **Bulk delete and retention sweeps** → one project at a time.
- **Deleting a user** → a much larger question.

---

## 4. Functional requirements

### The lifecycle field

| ID | Requirement | Source |
|---|---|---|
| FR-1 | `Project.lifecycle` is `ACTIVE \| ARCHIVED \| DELETED`, defaulting to `ACTIVE`, and is **independent of `stage`** | Requirement |
| FR-2 | Transitions are one-way: `ACTIVE → ARCHIVED → DELETED`, and `ACTIVE → DELETED`. Nothing moves backwards | Requirement |
| FR-3 | Each transition records who and when: `archivedAt`/`archivedBy`, `deletedAt`/`deletedBy` | §9 |
| FR-4 | Neither transition touches `stage`. A deleted project still records that it had `COMPLETED` | §10 |

### Archive

| ID | Requirement | Source |
|---|---|---|
| FR-5 | The owner may archive. Archiving is refused while a migration or discovery holds a lease | Requirement, §9 |
| FR-6 | An archived project is **read-only**: every mutating endpoint refuses with 409. Enforced in `loadOwnedProject`, not at ten call sites | §9 |
| FR-7 | Reports, evidence, diffs, graph, assessment and verification stay readable and downloadable | Requirement |
| FR-8 | Archiving **tears down the sandbox** and returns its capacity slot | §1, D-020 |
| FR-9 | An archived project has no sandbox link and no extend action; `POST /sandbox/extend` refuses | Requirement |
| FR-10 | Actions are disabled in the UI **and** refused by the API. A disabled button is a courtesy; the 409 is the rule | §9 |
| FR-11 | Archived projects still appear in the list, visually distinct, excluded from the "awaiting approval" and "needs human action" counts — neither is actionable | §9 |

### Delete (soft)

| ID | Requirement | Source |
|---|---|---|
| FR-12 | Delete requires `role === 'PLATFORM_ADMIN'`. A non-admin gets 404, not 403 — the rule the rest of the product follows | PRD-15 |
| FR-13 | Delete requires the caller to type the `projectId` in the body. A mismatch removes nothing | §9 |
| FR-14 | Delete sets `lifecycle: 'DELETED'`. **No row in any collection is removed.** Every reference stays resolvable | Requirement |
| FR-15 | A deleted project is invisible: `byId` and `listForOwner` exclude it, so every project-scoped route 404s without needing its own check | §9 |
| FR-16 | Delete tears down the sandbox and releases its capacity slot | §1 |
| FR-17 | Delete **destroys the Secret Manager secret** and marks the credential `REVOKED`. A project the owner believes is gone must not leave a usable token behind | Data model §3.2 |
| FR-18 | Blobs are **retained**, because the artifacts they hold are still referenced by rows that still exist | §9 |
| FR-19 | The rotation sweep and the sandbox capacity attribution both skip deleted projects | §9 |
| FR-20 | Delete is refused while a lease is held | §9 |
| FR-21 | A dry run reports what would happen — the sandbox, the secret, the row counts that will become invisible — and changes nothing | §9 |
| FR-22 | Both actions are recorded in the activity log, which is never deleted | PRD-15 |

---

## 5. Data model

**Collections touched** — read `R`, write `W`

| Collection | Archive | Delete |
|---|---|---|
| `projects` | W | W |
| `sandbox_deployments` | W (torn down) | W (torn down) |
| `user_activity` | W (append) | W (append) |
| everything else | — | **untouched** |

**Schema change** — `Project` gains a lifecycle, alongside its stage:

```ts
/**
 * Where the project is in its own life — not how far the migration got.
 *
 * `stage` answers "did it complete?" and keeps answering it forever. This
 * answers "is anyone allowed to touch it?". Conflating them would overwrite an
 * outcome with a filing decision.
 */
lifecycle: z.enum(['ACTIVE', 'ARCHIVED', 'DELETED']).default('ACTIVE'),
archivedAt: Timestamp.optional(),
archivedBy: FirebaseUid.optional(),
deletedAt: Timestamp.optional(),
deletedBy: FirebaseUid.optional(),
```

**Why not a `ProjectStage` value.** `stage` records how far the migration got —
`COMPLETED`, `FAILED`, `NEEDS_HUMAN_ACTION` — and every `railProgress`, `STAGE_LABEL` and
`STAGE_COLOR` lookup is total over it. An `ARCHIVED` stage would destroy the outcome it
replaced and force a special case through all three.

**Indexes** — `projects` gains `{ ownerId: 1, lifecycle: 1, 'summary.lastActivityAt': -1 }`,
replacing `owner_activity`, so the list filters and sorts in one index.

**Project ids are never reused.** `nextProjectId` is a monotonic counter, so a deleted
`PQC-0184` can never collide with a later project — which is what makes soft delete safe
rather than merely convenient.

## 6. Interfaces

**API**

| Method | Path | Who | Notes |
|---|---|---|---|
| `POST` | `/projects/:id/archive` | Owner | Body `{ confirm: projectId }` |
| `GET` | `/projects/:id/deletion-preview` | Platform admin | FR-21's dry run |
| `DELETE` | `/projects/:id` | Platform admin | Body `{ confirm: projectId }`. Replaces today's partial hard delete |

**The choke point.** `ProjectRepository.byId` and `listForOwner` are the only two reads
that surface a project — every other query in the backend is an `updateOne` scoped by a
`projectId` the caller already holds. Filtering `lifecycle: { $ne: 'DELETED' }` in those
two functions makes a deleted project invisible everywhere at once, and is why FR-15 needs
no per-route work.

Three reads sit outside that path and each needs handling explicitly:

| Where | Why it matters |
|---|---|
| `sweepRotations` | Would keep emitting `CREDENTIAL_ROTATION_DUE` for a credential that has been destroyed |
| `SandboxCapacityService.state()` | Joins deployments back through `projects` to attribute per-user; a deleted project must not silently vanish from that count |
| `sweepSandboxes` | Must still reclaim a deleted project's deployment if teardown failed at delete time |

**Events emitted** — `PROJECT_ARCHIVED` and `PROJECT_DELETED` on the project's own stream,
written before the stream stops being read.

**Activity actions** — `PROJECT_ARCHIVED` (new), `PROJECT_DELETED` (defined in PRD-15,
unused until now), `ACCESS_DENIED` when a non-admin attempts a delete.

**Agent involvement** — none.

## 7. Acceptance criteria

| ID | Criterion | Verified by |
|---|---|---|
| AC-1 | `lifecycle` and `stage` are independent: a deleted project still reports the stage it reached | test |
| AC-2 | No transition moves backwards, and no route sets `lifecycle` to `ACTIVE` | test |
| AC-3 | Archiving makes every mutating endpoint answer 409, enumerated from the route table rather than a hand-picked few | test |
| AC-4 | Every read endpoint still answers 200 on an archived project, and artifacts still download | test |
| AC-5 | Archiving tears down the sandbox, and the freed slot is immediately available to another project | test |
| AC-6 | `POST /sandbox/extend` on an archived project is refused | test |
| AC-7 | Archive and delete are both refused while a lease is held | test |
| AC-8 | A non-admin's delete gets 404 and is recorded as `ACCESS_DENIED` | test |
| AC-9 | Delete with a mismatched `confirm` changes nothing | test |
| AC-10 | After a delete, **every** collection still holds its rows — asserted by iterating `COLLECTIONS`, so nothing is silently orphaned | test |
| AC-11 | After a delete the project is absent from `byId`, from the list, and from every project-scoped route | test |
| AC-12 | Delete releases the sandbox and the capacity slot | test |
| AC-13 | Delete destroys the secret and marks the credential `REVOKED` | test |
| AC-14 | The rotation sweep skips deleted projects | test |
| AC-15 | `user_activity` keeps its entries, including `PROJECT_DELETED` | test |
| AC-16 | The dry run reports counts and changes nothing | test |
| AC-17 | The orphan sweep finds pre-existing hard-deleted projects and reports them | test |
| AC-18 | An archived project renders read-only with every action disabled and a banner saying why | screen |

## 8. Risks and open questions

| # | Risk or question | Impact | Resolution or owner |
|---|---|---|---|
| 1 | **Today's hard delete already orphaned eighteen collections.** Soft delete fixes the future, not the past | Rows nobody can reach and nobody knows about | A one-off sweep (FR in scope) finds `projectId`s with no project document and **reports** them. It does not delete: the whole point of this increment is that deciding to destroy data is a separate, deliberate act |
| 2 | **The capacity leak is live now.** Already-deleted projects may be consuming platform slots | The platform stops retaining sandboxes with no visible cause | The same sweep releases deployments whose project is gone. Worth running before any demo |
| 3 | **Soft delete only grows the database** | Storage cost, and slower unfiltered queries over time | Accepted for a prototype, and named rather than assumed away. Every project-scoped query is already indexed by `projectId`, so a deleted project's rows cost storage, not query time |
| 4 | **"Delete" no longer means the data is gone** — that is a change from the original requirement | Someone expecting a wipe gets a hide | Stated in §10 and in the confirmation copy. A hard purge stays possible as an offline operation, and is *safer* to write after this increment because there are no dangling references to reason about |
| 5 | **A soft-deleted project keeps a repository URL, a name and file contents** | Data retained past the point a user asked for removal | The credential is destroyed (FR-17), which is the part that could still do harm. Anything more is a data-retention policy this prototype does not have, and inventing one here would be worse than naming its absence |
| 6 | **A lease can outlive the check.** A worker may take a lease microseconds after the transition verified there was none | A migration writing to an archived or deleted project | The write is conditional on `version`, and the loop re-reads the project each iteration; a run that finds its project non-`ACTIVE` stops and records why. Narrow race, named rather than assumed away |
| 7 | **Archiving is irreversible by requirement** | Someone archives the wrong project | Typed confirmation, the action placed away from the primary flow, and the confirmation says plainly that it cannot be undone |
| 8 | **`user_activity` keeps a `projectId` that resolves to nothing visible** | A log referencing something a reader cannot open | Intended. The entry says what happened to `PQC-0184`; that it is gone is the point. The screen renders the id without linking it |

## 9. Definition of done

- [x] All FRs implemented
- [x] All ACs verified — 20 backend tests, 15 frontend tests
- [x] Typecheck, lint, build clean; 410 backend + 109 frontend tests pass
- [ ] The orphan sweep has been run against the working database — `findOrphans` is
      implemented and tested, but has not been run against the live Atlas cluster
- [ ] `docs/pqc_migration_data_model_v1.md` documents `lifecycle` — deferred, see §11
- [x] §11 records what was actually built

---

## 10. Notes on the requirement

**"Archive is not a stage — create another field."** Taken exactly. `lifecycle` is a
separate enum with `ACTIVE`, `ARCHIVED` and `DELETED`, and nothing in this increment writes
to `stage`. The two answer different questions and both keep answering after the other
changes: `stage` says whether the migration completed, `lifecycle` says whether anyone may
touch it.

**"Delete should do a soft delete, so other collections don't get orphaned."** This
supersedes the earlier statement that delete "will delete all related data in the
database", and it is the better call: hard-deleting one project across twenty-four
collections is twenty-four chances to miss one, and the current code already misses
eighteen. Setting one field cannot partially fail.

Two things still have to be destroyed rather than hidden, and §4 says so:

- **The GitHub token.** A soft-deleted project that keeps a live credential is a token
  nobody is watching on a project nobody can see — precisely what the data model's
  credential rule exists to prevent.
- **The sandbox.** A hidden project holding a public Cloud Run URL and one of thirty
  platform slots is the bug this increment was written to fix, not one to preserve.

**"Available to platform admin enabled email ids."** That is PRD-15's
`PLATFORM_ADMIN_EMAILS` and the `PLATFORM_ADMIN` role it grants at sign-in. No new
mechanism.

**"This is for all users."** Archive is the owner's action, and since every project has
exactly one owner, "all users" and "the owner" describe the same set today. Written as an
owner check so it stays correct if sharing is ever added.

---

## 11. Delivery log

| Date | Change | Why |
|---|---|---|
| 2026-08-29 | `ProjectLifecycle` enum, `LIFECYCLE_TRANSITIONS`, `canTransitionLifecycle`, and four fields on `Project` | Transitions are data, so an illegal one is a lookup rather than a forgotten `if` |
| 2026-08-29 | `byId` and `listForOwner` exclude `DELETED`; `byIdIncludingDeleted` added for the two callers that need one | The whole of FR-15 in two functions — every project-scoped route inherits it |
| 2026-08-29 | `core/services/lifecycle.ts` — `LifecycleService` (`archive`, `softDelete`, `preview`) and `findOrphans` | Preview and the delete both enumerate `COLLECTIONS`, so a collection added later is covered without anyone remembering |
| 2026-08-29 | `assertMutable` in `ownership.ts`, inferred from the HTTP method | Ten mutating endpoints; a guard that has to be remembered gets forgotten |
| 2026-08-29 | `loadProjectAsAdmin` — role instead of ownership | Found by a failing test: `loadOwnedProject` blocked an admin from deleting somebody else's project, which is the entire point of the admin gate |
| 2026-08-29 | `POST /projects/:id/archive`, `GET /projects/:id/deletion-preview`, rewritten `DELETE /projects/:id` | |
| 2026-08-29 | `sweepRotations` filters `lifecycle: 'ACTIVE'` | Reminding an archived project is noise nobody can clear, and a deleted one has had its secret destroyed |
| 2026-08-29 | `lib/lifecycle.ts`, `components/ProjectLifecycle.tsx`, the archived banner in `App.tsx`, styles | The banner is in the shell, so every screen carries it without seven copies |
| 2026-08-29 | **Removed `ProjectService.delete`** | Unreferenced after this increment, and dangerous: it is the partial hard delete. A partial delete that looks total is worse than none, and leaving it callable is how it gets called |

**Deviations from plan**

1. **`loadOwnedProject` could not serve the delete route.** Delete exists to clear other
   people's test projects, and the ownership check refused an admin before the role check
   ran. Caught by an acceptance test, not by reading. `loadProjectAsAdmin` replaces
   ownership with the role rather than adding to it, and a non-admin still gets 404.

2. **PRD-05's AC-5 is superseded and its test rewritten.** It asserted an owner-initiated
   hard delete that removed the secret, files and events. Delete is now a platform admin's
   soft delete and the owner's action is archive, so the test now asserts that an owner is
   refused with 404. The half of AC-5 that mattered — the credential is destroyed, not
   hidden — survives unchanged and is covered in `lifecycle.test.ts`.

3. **Two `ProjectLifecycle` names.** The schema's enum and the React component share a
   name across packages. Not renamed: each reads correctly where it lives, and they are
   never imported into the same file.

4. **Archive and delete are reached from a kebab menu in each tile's corner.** Forced by
   an earlier change: a `FAILED` project's tile is not clickable, so there is no screen to
   put the control on — and clearing failed test projects is exactly what delete is for.
   The design has no such control, so this is invention.

   A first attempt used a select on the page ("manage a project"), which was rightly
   rejected: naming the project separately from the one you are looking at is a way to act
   on the wrong one. The menu is a sibling of the tile button rather than a child, because
   a button inside a button is invalid and the browser's recovery is to drop one.
   Confirmation is a native `<dialog>` opened with `showModal()` — focus trapping, Escape
   and the top layer come with it, and each is easy to get subtly wrong by hand on a
   dialog whose whole job is to make someone stop and read.

5. **`PROJECT_ARCHIVED` and `PROJECT_DELETED` added to the event-type enum**, which PRD-17
   did not anticipate needing. Both are emitted on the project's own stream.

6. **A backfill was needed, and the PRD did not say so.** `Repository.findOne` returns the
   raw Mongo document without parsing, so Zod's `.default('ACTIVE')` applied to writes and
   never to reads. Every project created before this increment came back with
   `lifecycle: undefined`, which crashed `canTransitionLifecycle` on a delete and — worse
   — made `assertMutable` treat those projects as archived, turning the whole product
   read-only for exactly the projects that predate the change.

   Fixed in three places, because one was not enough: `core/db/migrations.ts` runs at boot
   and fixes the stored data; `ProjectRepository` hydrates on read so a document that
   escapes the backfill is still correct; and every comparison treats an absent value as
   `ACTIVE` rather than as not-active. Six backend and two frontend tests cover it, all
   built on a raw `$unset` — no fixture written through `insert` can reproduce it, which
   is why the original suite passed.

**Deferred**

- **The orphan sweep has not been run against the live database.** `findOrphans` is
  implemented and tested against a real replica set, but nothing has called it against
  Atlas, so risk 1 and risk 2 remain live: projects hard-deleted before this shipped may
  still be stranding platform sandbox slots. There is no endpoint for it yet either.
- **`docs/pqc_migration_data_model_v1.md` is not updated** with `lifecycle`.
- **No render test** for `ProjectMenu` or `ConfirmDialog`. The menu's composition and the
  confirmation rule are covered by 20 unit tests; nothing asserts that the dialog actually
  opens, traps focus, or that the typed input gates the button in a browser.
- **The archived state is not shown on the project tile's border or pill**, only in the
  footer text and the shell banner.
