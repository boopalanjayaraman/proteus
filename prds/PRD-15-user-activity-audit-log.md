# PRD-15 · User Activity & Audit Log

| | |
|---|---|
| **Increment** | 15 |
| **Status** | `DELIVERED` |
| **Depends on** | PRD-03 (auth, SSE), PRD-05 (project lifecycle, credentials) |
| **Unblocks** | — |
| **Demoable outcome** | Open Activity and see everything you have done, newest first, filterable and searchable. A platform admin sees everyone's. |
| **Created** | 2026-08-29 |
| **Delivered** | 2026-08-29 |

---

## 1. Problem

The product records in detail what the *agent* did — `events`, `agent_actions`,
`migration_changes`, `execution_runs` — and almost nothing about what the *person* did. Who
approved a migration, who replaced a repository token, who downloaded an evidence package,
who tried to open a project they do not own: none of it is answerable today.

That gap matters most exactly where this product is pointed. A tool that rewrites
cryptographic code on someone's behalf will be asked *who authorised this*, and "the agent
has a full audit trail" does not answer it. The migration audit trail says a branch was
created; it does not say which human's single approval permitted it.

## 2. Sources of truth

| Source | Reference |
|---|---|
| Product spec | §38 live activity vs audit trail · §39 migration audit trail — **adjacent, not the same thing.** Both describe the agent's actions; neither covers user activity |
| Data model | §3.19 agent actions · §0 rule 8 (nothing token-shaped is ever stored or logged) |
| PRD-05 | Credential handling — a token change is auditable, a token value is not |
| PRD-10 | `HumanGate` and the approval record — the one user action already captured, and the model this follows |

> **No spec section requires this.** It is a product addition, and §8 records that
> honestly rather than manufacturing a citation. Everything here traces to the data model's
> redaction rule, PRD-05's credential discipline, or the user's stated requirement.

## 3. Scope

**In**
- An append-only `user_activity` collection, separate from `events`
- Server-recorded activity for everything, derived from requests the backend already serves
- Page visits recorded from a screen's first call, labelled by one request header
- `role` on `User`, with `PLATFORM_ADMIN` seeded from configuration
- Activity screen: newest first, filter, search, cursor-paged, ISO-8601 UTC timestamps
- Own activity for every user; all activity for a platform admin
- Retention through a TTL index

**Out** — and where it lands instead
- Changing the agent's own audit trail → it already exists and is unaffected
- Exporting activity as a file → the evidence package (PRD-14) is the export story;
  revisit if someone asks
- Alerting on suspicious activity → recording is the prerequisite; detection is a
  separate product
- SSO, groups, per-project roles → out of MVP. One flag, two values
- Sign-in and sign-out as discrete events → not recorded. Firebase Auth is client-side and
  the backend observes neither. `SESSION_STARTED` is derived instead (§5), and named for
  what it is rather than for what it is not

---

## 4. Functional requirements

### Recording

| ID | Requirement | Source |
|---|---|---|
| FR-1 | Every entry records who, what, when, and — where one applies — which project | Requirement |
| FR-2 | An entry is **append-only**. No endpoint updates or deletes one, and the repository exposes no path that could | Audit integrity |
| FR-3 | Every entry is written by the backend from a request it authenticated. No endpoint accepts an audit entry from the browser | §9 |
| FR-3a | `ApiClient` sends `x-proteus-screen` on every call. Its value is validated against a **closed set of six screens** and rejected otherwise — never stored as free text | §9 |
| FR-3b | Each entry records `provenance: OBSERVED \| DECLARED`. `DECLARED` means the screen label came from the header; everything else about the entry is observed | §9 |
| FR-4 | `redactTokens` runs before write, and a credential change records the secret name and version only — never a value, not even a prefix | Data model rule 8 |
| FR-5 | Recording never fails the action it describes. A write that throws is logged and swallowed | §9 |
| FR-6 | Activity is recorded for the categories in §5, including refusals — a denied access attempt is the entry most worth having | Requirement |
| FR-6a | A page visit is recorded from the **first call a screen makes**, not from a beacon | Requirement |
| FR-6b | Repeat calls collapse: one entry per `(userId, screen, projectId)` within a 30-second window. A screen making seven parallel calls on load produces one entry, not seven | §9 |
| FR-6c | `ACCOUNT_CREATED` is recorded at the `GET /me` upsert, on the branch where no user document existed | Requirement |
| FR-6d | `SESSION_STARTED` is recorded when `GET /me` arrives and `lastSeenAt` is older than the session gap. It is **not** a login and is not labelled as one | §10 |

### Access

| ID | Requirement | Source |
|---|---|---|
| FR-7 | `User.role` is `USER` or `PLATFORM_ADMIN`, defaulting to `USER` | Requirement |
| FR-8 | Admins are seeded from `PLATFORM_ADMIN_EMAILS`, applied at sign-in. No endpoint grants the role | Requirement |
| FR-9 | A user sees only their own activity. The scope is applied server-side in the query, never by a client-supplied filter | Requirement |
| FR-10 | A platform admin sees all activity and may filter by user | Requirement |
| FR-11 | A non-admin asking for another user's activity gets their own, not a 403 — the filter is ignored rather than the request refused, because there is nothing to refuse | §9 |
| FR-12 | Reading the activity log is itself recorded when an admin reads someone else's | §9 |

### The screen

| ID | Requirement | Source |
|---|---|---|
| FR-13 | Newest first, always. Sorted by timestamp descending with a stable tiebreak | Requirement |
| FR-14 | Timestamps are ISO 8601 UTC — `2026-08-29T14:32:11Z` — stored and displayed | Requirement (see §10) |
| FR-15 | Filter by category, by project, by outcome, and by date range | Requirement |
| FR-16 | Free-text search across the summary and the target | Requirement |
| FR-17 | **Cursor** paging, not offset. An append-only log grows while you read it, and offset paging on a growing collection repeats and skips rows | §9 |
| FR-18 | Page views are recorded but excluded from the default view, behind a toggle | §9 |

---

## 5. Data model

**Collections touched** — read `R`, write `W`, create `C`

| Collection | Access | Fields of note |
|---|---|---|
| `user_activity` | C/R | new — see below |
| `users` | R/W | `role` |

**Schema changes required**

`User` gains one field:

```ts
role: z.enum(['USER', 'PLATFORM_ADMIN']).default('USER')
```

A new collection, `user_activity`:

```ts
export const UserActivity = z.object({
  ...baseDocFields,
  activityId: Id,
  userId: FirebaseUid,
  /** Denormalised so the admin view lists people without joining every row. */
  userEmail: z.string().email(),

  category: ActivityCategory,
  action: z.string().min(1),          // "MIGRATION_APPROVED"
  summary: z.string().min(1),         // what a person reads
  /** What it happened to: a project id, an artifact id, a route. */
  target: z.string().optional(),
  projectId: ProjectId.optional(),

  outcome: z.enum(['SUCCESS', 'DENIED', 'FAILED']).default('SUCCESS'),
  /**
   * OBSERVED: the backend derived every field from the request.
   * DECLARED: the `screen` came from the request header; the rest is observed.
   */
  provenance: z.enum(['OBSERVED', 'DECLARED']),
  /** Closed set. Which screen the request came from, for every category. */
  screen: Screen.optional(),

  /** Small, bounded, and never anything token-shaped. */
  detail: z.record(z.string(), z.unknown()).optional(),

  requestId: z.string().optional(),
  ip: z.string().optional(),
  userAgent: z.string().max(300).optional(),

  at: Timestamp,
});
```

**`Screen`** — closed, and the same six the router declares in `App.tsx`:

```ts
export const Screen = z.enum([
  'PROJECTS', 'PROJECT_CREATE', 'DISCOVERY', 'ASSESSMENT', 'MIGRATION', 'SANDBOX',
]);
```

A closed enum rather than a path or a free-text label: the only thing a browser can
misstate is which of six screens it was on, and a path would carry project ids into a
field that gets regex-searched.

**Categories**, and what each covers:

| Category | Actions |
|---|---|
| `AUTH` | `ACCOUNT_CREATED`, `SESSION_STARTED` |
| `PROJECT` | `PROJECT_CREATED`, `PROJECT_UPDATED`, `PROJECT_DELETED`, `FILES_UPLOADED` |
| `CREDENTIAL` | `TOKEN_STORED`, `TOKEN_REPLACED`, `ROTATION_REMINDER_SEEN` |
| `ANALYSIS` | `DISCOVERY_STARTED`, `ASSESSMENT_GENERATED`, `ASSESSMENT_REGENERATED` |
| `MIGRATION` | `MIGRATION_APPROVED`, `MIGRATION_RERUN`, `GATE_RESOLVED` |
| `SANDBOX` | `SANDBOX_OPENED`, `SANDBOX_EXTENDED`, `SANDBOX_TORN_DOWN` |
| `ARTIFACT` | `REPORT_DOWNLOADED`, `DIFF_DOWNLOADED`, `EVIDENCE_DOWNLOADED` |
| `ACCESS` | `ACCESS_DENIED`, `CAPACITY_REACHED`, `RATE_LIMITED` |
| `ADMIN` | `ACTIVITY_VIEWED`, `ROLE_APPLIED` |
| `NAVIGATION` | `PAGE_VIEWED` |

**Indexes**

```
{ userId: 1, at: -1 }        the user's own view
{ at: -1 }                   the admin view
{ projectId: 1, at: -1 }     one project's history
{ category: 1, at: -1 }      the category filter
{ at: 1 }  expireAfterSeconds: 15552000   180-day retention
{ activityId: 1 } unique
```

Text search is a regex over `summary` and `target` rather than a text index: the corpus is
small per user, and a text index would rank by relevance when the requirement is strictly
reverse-chronological.

## 6. Interfaces

**API**

| Method | Path | Notes |
|---|---|---|
| `GET` | `/activity` | The log. `?category=&projectId=&outcome=&from=&to=&q=&cursor=&limit=&includeNavigation=` |
| `GET` | `/activity/users` | Admin only: who has activity, for the user filter |

**No write endpoint.** Every entry is written as a side effect of a request the backend
already authenticated and served. An endpoint that writes audit entries from a browser is a
way to forge an audit log rather than a way to fill one, so there isn't one.

**Request header** — `x-proteus-screen`, sent by `ApiClient.request` on every call:

```
x-proteus-screen: SANDBOX
```

One header, added at the single `fetch` wrapper in `src/frontend/src/api/client.ts`, so no
screen has to remember to send it. Rejected unless it is one of the six values in §5.

**Events emitted** — none. Activity is not project state and must never reach the SSE
migration feed; putting page views beside "migration approved" would make the feed useless
and the audit log unreadable.

**Agent involvement** — none. Deterministic recording.

**Rules consumed** — none.

## 7. Acceptance criteria

| ID | Criterion | Verified by |
|---|---|---|
| AC-1 | A user requesting activity sees only their own, even when asking for another's | test |
| AC-2 | A platform admin sees all, and can filter to one user | test |
| AC-3 | Admins come from `PLATFORM_ADMIN_EMAILS`; no request can grant the role | test |
| AC-4 | An approval, a token replacement, a report download and a denied access each produce one entry with the right category and outcome | test |
| AC-4a | A screen load making seven parallel calls produces exactly one `PAGE_VIEWED` | test |
| AC-4b | An unrecognised `x-proteus-screen` value is rejected and never stored | test |
| AC-4c | A first-ever `GET /me` records `ACCOUNT_CREATED`; a later one after the session gap records `SESSION_STARTED`; one inside the gap records neither | test |
| AC-5 | No entry contains a token-shaped string, including on a token replacement | test |
| AC-6 | A recording failure does not fail the action being recorded | test |
| AC-7 | Cursor paging returns every row exactly once while new rows are being written | test |
| AC-8 | Results are newest-first with a stable order for identical timestamps | test |
| AC-9 | Filters and search narrow correctly and compose | test |
| AC-10 | Page views are recorded and hidden by default | test · screen |
| AC-10a | No entry has `provenance: DECLARED` outside the `NAVIGATION` category | test |
| AC-11 | An admin reading another user's activity is itself recorded | test |
| AC-12 | Timestamps render as `2026-08-29T14:32:11Z` | screen |

## 8. Risks and open questions

| # | Risk or question | Impact | Resolution or owner |
|---|---|---|---|
| 1 | **No spec section requires this.** Every requirement traces to the user's stated need or to an existing discipline, not to §1–§54 | A requirement with no source is an opinion | Recorded here rather than dressed up. If it conflicts with something the spec does say, the spec wins |
| 2 | **Sessions have a start and no end.** A closed tab, a crashed browser and a dead battery all end a session silently, and the backend sees none of them | A log that looks like it is missing rows, or worse, one that implies sessions ended cleanly | Not recorded, per the requirement. `SESSION_STARTED` is named for what it observes, and the screen shows no session duration and no "still active" state — both would be inventions |
| 3 | **Page views are most of the volume and least of the value** | A log nobody reads because it is mostly navigation | Own category, excluded by default (FR-18), and collapsed by FR-6b's 30-second window so a screen load is one row rather than one per API call |
| 4 | **IP and user agent are PII** | A GDPR question this prototype has not answered | Recorded because a security audit is the point, and named here so the decision is visible. Configurable off; the 180-day TTL applies |
| 5 | **The screen label is the one thing the client asserts** | A row that says SANDBOX when the user was on ASSESSMENT | Bounded to six enum values, so the worst available lie is small and the log stays internally consistent — the request beside it is real, authenticated, and independently recorded. Marked `DECLARED` so nobody has to guess which half was observed |
| 6 | **Two logs now describe overlapping moments** — `events` for the project, `user_activity` for the person | A reader unsure which to trust | They answer different questions and are deliberately not merged. The event log says a migration was approved; the activity log says who approved it. Cross-referenced by `projectId` |
| 7 | Recording on every request is a write per request | Latency on a hot path | Fire-and-forget, never awaited in the response path, and navigation writes are the only high-volume category |

## 9. Definition of done

- [x] All FRs implemented
- [x] All ACs verified — 32 backend tests, 20 frontend tests
- [x] Typecheck, lint and build clean; 378 backend + 80 frontend tests pass
- [x] `.env.example` documents every new setting
- [x] §11 records what was actually built

---

## 10. Notes on the requirement

> Two places where the requirement needs interpreting, resolved here rather than silently.

**"Use ANSI format for the date."** Read as **ISO 8601 in UTC** — `2026-08-29T14:32:11Z` —
which is what ANSI X3.30 aligned to and what the rest of this system already stores. An
audit log across timezones has to be unambiguous, and a local-time rendering of the same
instant differs by reader. The screen shows UTC and says so.

**Sign-in, sign-out, and how page visits are recorded.** The first draft used a browser
beacon for the three things the backend cannot see. That was dropped: sign-in and sign-out
are not recorded at all, and page visits are recorded from a screen's first call instead.
Three things make this strictly better rather than a concession.

The router declares exactly **six screens**, so the label is a closed enum and not a path —
the only thing a browser can misstate is which of six it was on. `ApiClient.request` is a
**single `fetch` wrapper**, so one header covers every call in the application and no screen
can forget to send it. And there is now **no write endpoint at all**: every entry is a side
effect of a request that was already authenticated and served, which is a stronger guarantee
than the beacon it replaces.

Two things survive from the dropped half, because `GET /me` is the app's first call on load
and already upserts the user. `ACCOUNT_CREATED` comes free from the branch where no user
document existed. `SESSION_STARTED` comes free from `lastSeenAt` being older than the
session gap — and it is deliberately not called a login, because it is an observation about
request timing and calling it a login would be a claim the backend cannot support.

**"If that role is not there, at least we should create a flag."** There is no role field
today — `User` carries identity, preferences and `lastSeenAt`. So this adds one, as an
enum rather than a boolean: `PLATFORM_ADMIN` names what it grants, where `isAdmin: true`
would need a comment to explain what an admin is. Seeded from configuration and applied at
sign-in, because a role that can be granted through the API is a privilege-escalation path
in a product whose whole claim is a bounded autonomy.

---

## 11. Delivery log

| Date | Change | Why |
|---|---|---|
| 2026-08-29 | `schema/src/activity.ts` — `Screen`, `ActivityCategory`, `ActivityAction`, `UserActivity`, `ACTIVITY_CATEGORY`, `navigationKey`, `isoUtc` | The action decides the category, so an action cannot be filed under a filter that hides it |
| 2026-08-29 | `User.role`, and `user_activity` in `COLLECTIONS`/`INDEXES` with six indexes and a 180-day TTL | The keyset index carries `activityId` because `at` alone is not a total order |
| 2026-08-29 | `core/services/activity.ts` — `ActivityRecorder` | `record` swallows every failure; `query` pages on `(at, activityId)`; `startsSession` reads the gap |
| 2026-08-29 | `api/middleware/activity.ts` — the `x-proteus-screen` hook pair | `preHandler` builds the context after auth; `onResponse` records the visit off the response path |
| 2026-08-29 | `api/routes/activity.ts` — `GET /activity`, `GET /activity/users` | Scope decided in the route, never taken from a parameter |
| 2026-08-29 | Recording wired into project create/upload/delete, assessment regeneration, artifact and diff downloads, approval, decline, gate resolution, sandbox open/extend/teardown, capacity, and denied ownership | Every site is `void record(...)` — FR-5 holds because no call site awaits |
| 2026-08-29 | `x-proteus-screen` set at `ApiClient.headers`, and the three raw `fetch` calls routed through it | `pinNode`, `tearDownSandbox` and `download` bypassed `request` and would have sent no header |
| 2026-08-29 | `lib/activity.ts`, `screens/Activity.tsx`, `styles/activity.css`, route and nav entry | `screenForPath` is the whole page-view mechanism, so it is tested separately from the component |

**Deviations from plan**

1. **A rejected sign-in is not recorded, and the action was removed from the enum.**
   `requireAuth` throws before `req.user` is set, so a rejected token leaves no uid to
   attribute the row to and no user who could ever read it. An unattributable entry only a
   platform admin can see is a log line, and one already exists in the request log. Removed
   rather than left in the enum unused, so the vocabulary describes what actually happens.

2. **`PROJECT_UPDATED` and `TOKEN_REPLACED` have no call site.** The product has no
   endpoint that edits a project or replaces its token — `POST /projects` and
   `DELETE /projects/:id` are the whole lifecycle. Both actions are defined, categorised
   and covered by the redaction test, so the day that endpoint exists it records correctly.
   Claiming them as delivered would have meant claiming a screen exists that does not.

3. **`ROTATION_REMINDER_SEEN` is unused** for the same reason: the rotation sweep emits a
   project event, and no screen acknowledges it.

4. **Retention is not an environment variable.** The TTL is declared in the shared schema's
   index definitions, which the browser bundle also imports and which cannot read
   `process.env`. Changing it on a live collection is a `collMod` rather than a restart, so
   an environment variable would have implied a control it does not have. The two knobs that
   *are* behavioural — the session gap and the navigation window — are configurable.

5. **`ActivityRecorder.forgetNavigationCache()` exists for tests.** The dedupe fast path is
   keyed by a wall-clock bucket and several tests run inside one, so a page view in the
   second test was suppressed by a key the first one wrote. Found by a failing test, not
   reasoned about in advance.

6. **A module-level recorder handle in `ownership.ts`.** `loadOwnedProject` is called from
   about forty sites and threading an optional recorder through all of them to record one
   event was worse than a `setOwnershipRecorder` set once at server construction.

**Deferred**

- **The activity screen has no automated render test.** Its logic is covered by 20 unit
  tests, and the shell test covers routing, but nothing asserts the table renders.
- **No aggregate view for an admin** — no "most active users", no per-day counts. The list
  answers "what did this person do"; it does not answer "what is happening on the platform".
- **Search is a case-insensitive regex, not a text index.** Correct and fast at this size;
  it will not stay fast at ten million rows.
- **IP and user agent are recorded and never surfaced.** They are in the document and behind
  the row expander's data, but no filter uses them. Deliberate: recording them was the point
  (risk 4), making them searchable was not asked for.
