# PRD-03 · API Foundation, Auth & SSE

| | |
|---|---|
| **Increment** | 03 |
| **Status** | `PLANNED` |
| **Depends on** | PRD-02 |
| **Unblocks** | PRD-04, PRD-05 |
| **Demoable outcome** | None — foundation. Verified by command: `curl` the stream, kill it mid-flight, reconnect, and nothing is missed. |
| **Created** | 2026-08-29 |
| **Delivered** | |

---

## 1. Problem

Two screens depend on a live stream, and the product's resumability claim depends on that
stream being a *tail* rather than a source. Getting this wrong is not visible in a happy-path
demo — it shows up as a user who refreshes and loses half the migration history.

Authorization is the other half: every project is owned, and ownership is checked on the
server, never inferred from what the client asked for.

## 2. Sources of truth

| Source | Reference |
|---|---|
| Product spec | §41 event streaming · §42 resumable state · §44 backend API |
| Tech stack | §5 authentication · §14 SSE · §16 auth rule |
| Architecture | §4 authentication architecture · §27 event architecture |
| Data model | §6a–6b reopen and reconnect · §6e change-stream fan-out |

## 3. Scope

**In**
- Fastify server, route registration, error shape
- Firebase ID token verification via Admin SDK
- Project-ownership middleware
- `GET /projects/{id}/events` with `?fromSeq=`
- `GET /projects/{id}/stream` (SSE) with `Last-Event-ID` resume
- Change-stream fan-out so any instance can serve any subscriber
- Startup banner reporting configured feature groups

**Out**
- Project CRUD bodies → PRD-05
- Discovery, assessment, migration routes → their own increments
- Frontend consumption → PRD-04

---

## 4. Functional requirements

| ID | Requirement | Source |
|---|---|---|
| FR-1 | Every request presents a Firebase ID token; an invalid or absent token returns 401 | Tech stack §16 |
| FR-2 | A request for a project the caller does not own returns 404, not 403 | — engineering: 403 confirms the project exists |
| FR-3 | SSE frames set `id: <seq>`; the browser's `Last-Event-ID` resumes from that point | Data model §6b |
| FR-4 | Reconnect replays `seq > n` in order, then continues live, with no gap and no duplicate | Spec §42 |
| FR-5 | A subscriber connected to instance A receives events written by instance B | Data model §6e |
| FR-6 | `GET /projects/{id}/events` supports `level` and `fromSeq` filters | Data model §3.18 |
| FR-7 | The stream sends periodic comments to keep intermediaries from closing an idle connection | — engineering |
| FR-8 | Server errors return a typed shape and never leak an internal message | — engineering |
| FR-9 | The startup banner reports which feature groups are configured | Config §configuredFeatures |

## 5. Data model

| Collection | Access | Fields of note |
|---|---|---|
| `projects` | R | `ownerId` for authorization, `lastEventSeq` for resume |
| `events` | R | `seq`, `level` |
| `users` | R/W | `lastSeenAt` on each authenticated request |

**Schema changes** — none.

## 6. Interfaces

**API**

| Method | Path | Notes |
|---|---|---|
| GET | `/healthz` | unauthenticated; reports configured features |
| GET | `/projects/{id}/events` | `?fromSeq=&level=&limit=` |
| GET | `/projects/{id}/stream` | SSE; honours `Last-Event-ID` |

**Events emitted** — none.

**Agent involvement** — none.

**Rules consumed** — none.

## 7. Acceptance criteria

| ID | Criterion | Verified by |
|---|---|---|
| AC-1 | No token → 401; valid token, other user's project → 404 | test |
| AC-2 | Disconnect after seq 40, reconnect with `Last-Event-ID: 40`, receive 41+ only | test |
| AC-3 | Event written on instance B reaches a subscriber on instance A within 1s | test |
| AC-4 | 100 events written during a disconnect are all delivered on reconnect, in order | test |
| AC-5 | An idle stream stays open past the platform idle timeout | test |
| AC-6 | `/healthz` reports feature groups without leaking any secret value | test |

## 8. Risks and open questions

| # | Risk or question | Impact | Resolution or owner |
|---|---|---|---|
| 1 | Cloud Run CPU throttling suspends the change-stream tail between requests | Live screens stop updating with no error | `--min-instances=1 --no-cpu-throttling` (deployment §6); assert at startup |
| 2 | Long-lived SSE against Cloud Run's request timeout | Stream drops at a fixed interval | Heartbeat plus client auto-reconnect; FR-3/FR-4 make a drop invisible |
| 3 | 404-for-unowned hides genuine 404s in logs | Harder debugging | Log the distinction server-side; return the same status to the caller |

## 9. Definition of done

- [ ] All FRs implemented
- [ ] All ACs verified
- [ ] Typecheck and tests pass
- [ ] §10 records what was actually built

## 10. Delivery log

| Date | Change | Why |
|---|---|---|

**Deviations from plan** —

**Deferred** —
