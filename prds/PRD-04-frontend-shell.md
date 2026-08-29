# PRD-04 · Frontend Shell & Design System

| | |
|---|---|
| **Increment** | 04 |
| **Status** | `DELIVERED` |
| **Depends on** | PRD-03 |
| **Unblocks** | PRD-05, PRD-07, PRD-08, PRD-09 |
| **Demoable outcome** | Sign in with Google and land on an empty projects screen, in either theme, with the persistent header rendering. |
| **Created** | 2026-08-29 |
| **Delivered** | 2026-08-29 |

---

## 1. Problem

Every later increment ships a screen. Without a shell they each reinvent routing, auth,
theming and the header, and diverge. Building it once and early is what lets increments
05 onward be vertical slices — backend and UI together — rather than a backend nobody can
see for eight increments.

## 2. Sources of truth

| Source | Reference |
|---|---|
| UX design | v1.2 — login screen; persistent header; left nav; theme toggle |
| Tech stack | §4 frontend · §5 authentication |
| Data model | §3.1 `users.preferences` |
| Architecture | §4 auth flow |

## 3. Scope

**In**
- Vite + React + TypeScript app, routing for all six destinations
- Firebase Google sign-in; ID token attached to every request
- Theme (dark/light), graph style, discovery layout — read and written to `users.preferences`
- Persistent header: breadcrumb, stage pill, elapsed timer, autonomy metrics, account menu
- Left nav with LIVE and GATE badges
- Typed API client and SSE client (resume by `seq`)
- Design tokens: colour, type, spacing, the impact palette
- Empty, loading and error states

**Out**
- Any screen's content → PRD-05 onward
- Graph rendering → PRD-08

---

## 4. Functional requirements

| ID | Requirement | Source |
|---|---|---|
| FR-1 | Google sign-in; unauthenticated users see only the login screen | UX v1.2 |
| FR-2 | Every API call carries a fresh ID token; expiry refreshes silently | Tech stack §16 |
| FR-3 | Theme toggle persists to `users.preferences` and survives a device change | Data model §3.1 |
| FR-4 | Header shows breadcrumb, stage pill, and — on live screens — an elapsed timer | UX v1.2 |
| FR-5 | Header shows `AUTONOMOUS COMPLETION` and `HUMAN ENGINEERING ACTIONS` from `summary.autonomy`, rendering `—` when null | Data model §3.2 |
| FR-6 | Nav shows LIVE on discovery/migration while running, GATE on assessment when a gate is open | UX v1.2 |
| FR-7 | The SSE client reconnects automatically and resumes by `seq` without duplicating feed rows | Data model §6b |
| FR-8 | The API client's types come from `@proteus/schema`, so a shape change is a compile error | Folder structure §5 |
| FR-9 | Only `VITE_*` values reach the bundle; no secret is referenced from frontend code | Deployment §5 |

## 5. Data model

| Collection | Access | Fields of note |
|---|---|---|
| `users` | R/W | `displayName`, `initials`, `photoUrl`, `preferences` |
| `projects` | R | header stage pill, autonomy metrics |

**Schema changes** — none.

## 6. Interfaces

**API** — `GET /me`, `PATCH /me/preferences`.

**Events emitted** — none.

**Agent involvement** — none.

**Rules consumed** — none.

## 7. Acceptance criteria

| ID | Criterion | Verified by |
|---|---|---|
| AC-1 | Signing in with Google reaches the projects route; signing out returns to login | screen |
| AC-2 | Theme survives sign-out, sign-in on a different browser | screen |
| AC-3 | Header renders `—` for autonomy before a migration starts, a percentage after | screen |
| AC-4 | Killing the network for 10s and restoring it leaves the feed correct, with no duplicated rows | test |
| AC-5 | Changing a `@proteus/schema` type breaks the frontend build | command |
| AC-6 | Built bundle contains no value from `src/backend/.env` | test |

## 8. Risks and open questions

| # | Risk or question | Impact | Resolution or owner |
|---|---|---|---|
| 1 | Theme is server-persisted, so first paint may flash the wrong theme | Visible flicker on load | Cache last theme in `localStorage` as a paint hint; server value remains authoritative |
| 2 | UX defines three graph styles and two discovery layouts | Preference surface larger than it looks | All three live in `users.preferences`; positions are computed client-side (data model §7) |
| 3 | Which of the six destinations are reachable before a project exists | Dead nav items | Nav disables project-scoped destinations until one is selected |

## 9. Definition of done

- [x] All FRs implemented
- [x] All ACs verified — 12 tests
- [x] Typecheck and tests pass (97 total across both workspaces)
- [ ] Lint — no linter yet (TD-005)
- [x] §10 records what was actually built

## 10. Delivery log

| Date | Change | Why |
|---|---|---|
| 2026-08-29 | `styles/tokens.css` | Palette taken verbatim from the UX canvas, both themes |
| 2026-08-29 | `lib/impact.ts` | Stage, impact and disposition mappings; derived header values |
| 2026-08-29 | `api/{client,stream}.ts` | Typed client and the resumable stream reader |
| 2026-08-29 | `lib/firebase.ts`, `app/{AuthContext,ThemeContext}.tsx` | Google sign-in, profile, server-persisted theme |
| 2026-08-29 | `components/layout/{Header,Nav}.tsx`, `screens/{Login,Placeholder}.tsx`, `app/App.tsx` | The shell and six routes |
| 2026-08-29 | `test/shell.test.ts` | 12 acceptance tests |

**Deviations from plan**

- **`EventSource` is not used.** It cannot send an `Authorization` header, and the stream
  is ownership-checked. The client reads the response body directly and reconnects with
  exponential backoff, which also means the resume cursor is ours rather than the
  browser's.
- **The client filters by `seq` as well as the server.** A duplicate would have to get
  past both. Deliberate belt-and-braces: a repeated row in the live feed is the most
  visible possible bug and the cheapest to prevent twice.
- **Theme writes are optimistic.** The toggle applies immediately and the server write
  follows; a failure leaves the localStorage hint correct for this device and reconciles
  at next sign-in. Waiting for the round trip would make the control feel broken.
- **Placeholder screens name the PRD that delivers them.** During a build, "not built
  yet" and "built but broken" look identical from the outside, which costs more time than
  the label saves.
- **Root `tsconfig.json` no longer covers the frontend.** It needs `jsx` and
  `vite/client` types that the backend must not have, so each workspace typechecks itself
  and the root script fans out.

**Deferred**

- Screen content → PRD-05 onward. Six routes exist and render placeholders.
- Graph rendering → PRD-08.
- CORS and rate limiting — not needed until the frontend calls a deployed origin.
- Lint — TD-005, due before PRD-07.
