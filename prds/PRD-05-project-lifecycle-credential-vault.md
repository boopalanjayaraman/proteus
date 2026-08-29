# PRD-05 · Project Lifecycle & Credential Vault

| | |
|---|---|
| **Increment** | 05 |
| **Status** | `DELIVERED` |
| **Depends on** | PRD-02, PRD-03, PRD-04 |
| **Unblocks** | PRD-06 |
| **Demoable outcome** | Create a project with a repository URL, a GitHub PAT and supporting documents; see it appear as a tile on the landing screen. |
| **Created** | 2026-08-29 |
| **Delivered** | 2026-08-29 |

---

## 1. Problem

Nothing else can start without a project, and a project cannot reach its repository
without a credential. UX v1.2 moved that credential from a deployment-wide token to one
per project, which makes this increment the first place the product handles a secret —
and the place where getting it wrong is least recoverable.

## 2. Sources of truth

| Source | Reference |
|---|---|
| Product spec | §4 landing screen · §5 create migration project |
| UX design | v1.2 — Landing (tiles, rail, action labels); Create (01 project, 02 credentials, 03–05 optional) |
| Data model | §3.2 project + credential rules · design rule 8 |
| Tech stack | §11 GitHub scope · §15 secrets |
| Deployment | §5 per-project secrets |

## 3. Scope

**In**
- `POST /projects` — name, repository URL, PAT, optional uploads and instructions
- PAT written to Secret Manager as `proteus-{projectId}-github-pat`, version pinned
- Secret *reference* persisted; token never touches MongoDB
- File upload to GCS with kind classification and text extraction queued
- `GET /projects` landing list, one query
- Project tile: stage pill, 8-segment rail, activity line, action label, live border
- Project deletion destroys its secret

**Out**
- Cloning or reading the repository → PRD-06
- Document text extraction beyond queueing the job → PRD-06
- Discovery kickoff → PRD-07

---

## 4. Functional requirements

| ID | Requirement | Source |
|---|---|---|
| FR-1 | `POST /projects` accepts the PAT in the body, writes it to Secret Manager, and never assigns it to a document | Data model rule 8 |
| FR-2 | The stored reference holds `secretName`, pinned `secretVersion`, `displayPrefix` (≤12 chars), `declaredScopes`, `status`, `rotationDueAt` = +90 days | UX v1.2, data model §3.2 |
| FR-3 | No endpoint returns the token; `GET /projects/{id}` exposes `displayPrefix` and `status` only | Data model rule 8 |
| FR-4 | The create screen lists the three required scopes verbatim | UX v1.2 |
| FR-5 | Credential lifecycle emits `CREDENTIAL_STORED`; failure to store fails project creation atomically | Data model §3.18 |
| FR-6 | Uploads are stored at the `gcsPath` layout with kind and sha256; metadata only in Mongo | Data model §1, §3.3 |
| FR-7 | Sections 03–05 are optional; a project is creatable with repository and PAT alone | UX v1.2 |
| FR-8 | `GET /projects` returns tiles from `summary` in a single query | Data model §3.2 |
| FR-9 | The rail is `railProgress(stage)`; the action label derives from stage + `actionRequired`; neither is stored | Data model §3.2 |
| FR-10 | Deleting a project destroys its Secret Manager secret | Deployment §5 |
| FR-11 | Project ids are `PQC-####`, allocated once, never reused | Data model §1 |

## 5. Data model

| Collection | Access | Fields of note |
|---|---|---|
| `projects` | C/R/W | `repository.credential`, `summary`, `stage` |
| `project_files` | C/R | `gcsUri`, `kind`, `extraction.status` |
| `counters` | W | project id allocation |
| `events` | W | `PROJECT_CREATED`, `CREDENTIAL_STORED` |

**Schema changes** — none; `RepositoryCredential` and `CreateProjectInput.githubToken` already exist.

## 6. Interfaces

**API**

| Method | Path | Notes |
|---|---|---|
| POST | `/projects` | multipart: fields + files. Token write-only. |
| GET | `/projects` | landing list |
| GET | `/projects/{id}` | never includes the token |
| POST | `/projects/{id}/files` | additional uploads |
| DELETE | `/projects/{id}` | destroys the secret |

**Events emitted** — `PROJECT_CREATED` (MILESTONE), `CREDENTIAL_STORED` (DETAIL), `FILE_ANALYZED` (DETAIL, on extraction).

**Agent involvement** — none. Deterministic.

**Rules consumed** — none.

## 7. Acceptance criteria

| ID | Criterion | Verified by |
|---|---|---|
| AC-1 | After creating a project, no document in any collection contains the token | test |
| AC-2 | No API response contains the token; `displayPrefix` is present and ≤12 chars | test |
| AC-3 | `secretVersion` is a pinned number, never `latest` | test |
| AC-4 | Secret Manager failure leaves no orphaned project | test |
| AC-5 | Deleting a project deletes its secret | test |
| AC-6 | A project is creatable with only name, URL and PAT | screen |
| AC-7 | Six seeded projects render with correct stage pills, rails and action labels | screen |
| AC-8 | An event whose payload contains a token is stored redacted | test |

## 8. Risks and open questions

| # | Risk or question | Impact | Resolution or owner |
|---|---|---|---|
| 1 | Project creation spans Mongo and Secret Manager; there is no transaction across them | Orphaned project or orphaned secret | Secret first, then project; a secret with no project is swept (deployment §8). An orphaned *secret* is recoverable; an orphaned *project* is broken |
| 2 | The PAT reaches the server in a request body | It exists in transit and in memory | TLS only; never logged; dropped after forwarding. Unavoidable — the user has to hand it over once |
| 3 | `declaredScopes` records what was asked, not what was granted | A project can be created with an under-scoped token | Verify against GitHub in PRD-06 and set `status: INVALID`; a finding, not a crash |
| 4 | Rotation reminder needs something to run it | Reminders never fire | Sweep reads `rotationDueAt`; scheduling deferred to PRD-14 |

## 9. Definition of done

- [x] All FRs implemented
- [x] All ACs verified — 17 backend tests, 1 frontend
- [x] Typecheck and tests pass (118 total)
- [x] §10 records what was actually built

## 10. Delivery log

| Date | Change | Why |
|---|---|---|
| 2026-08-29 | `integrations/secrets/vault.ts` | `SecretVault` interface, GCP and in-memory implementations |
| 2026-08-29 | `integrations/storage/blobs.ts` | `BlobStore` interface, GCS and in-memory implementations |
| 2026-08-29 | `core/services/projects.ts` | Creation, upload, deletion, the single credential read path |
| 2026-08-29 | `api/routes/projects.ts` | CRUD, with the credential stripped from every response |
| 2026-08-29 | `screens/{Projects,CreateProject}.tsx` | Landing tiles and the five-section create form |
| 2026-08-29 | **Fixed `redactTokens` destroying every `Date`** | See below |

**Deviations from plan**

- **A real bug, found by AC-3.** `redactTokens` rebuilt every object through
  `Object.entries()`, and a `Date` has no enumerable own properties — so every date it
  touched became `{}`. Since redaction runs on every write, **every timestamp written
  since PRD-02 was corrupted**, silently, because nothing throws. PRD-02's tests missed
  it by asserting only on strings and numbers. Fixed by recursing into plain objects
  only; three regression tests cover Date, Buffer and the mixed case.
- **Vault and blob store are interfaces with in-memory implementations.** Tests exercise
  the real service and routes against fakes rather than mocking the service itself — the
  point of AC-1 is that the token never reaches Mongo, and mocking the thing under test
  would prove nothing.
- **The project id is allocated before the secret is written**, because the secret name
  contains it. If the project insert then fails, the secret is destroyed on a best-effort
  basis, so the sweep in deployment §8 has less to do. Ordering per decision D-009.
- **Required scopes are served by the API**, not hardcoded in the screen, so the form
  cannot drift from what the backend actually expects.
- **The token input is cleared immediately after a successful create.** It has been
  vaulted; leaving it in a form field or a React state tree serves no purpose.
- **A validation failure never echoes the token.** The 400 names the offending field and
  nothing else — a validation error is not a reason to put a credential in a response.

**Deferred**

- Document text extraction is queued (`extraction.status: PENDING`) but not performed →
  PRD-06.
- Repository profile detection (`PUBLIC · JAVA 17 · MAVEN`) → PRD-06, which is the first
  increment that clones.
- Rotation sweep reads `rotationDueAt` but nothing schedules it → TD-017 / PRD-14.
