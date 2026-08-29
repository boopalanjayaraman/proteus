# PRD-16 · GCP Execution & Sandbox Hosting

| | |
|---|---|
| **Increment** | 16 |
| **Status** | `DELIVERED` |
| **Depends on** | PRD-11, PRD-12, PRD-13, PRD-14 |
| **Unblocks** | — public demo |
| **Demoable outcome** | Proteus runs as a hosted service: it builds and tests the repository on Cloud Build with the feed moving line by line, and the migrated application is reachable on a real `*.run.app` URL that disappears on its own. |
| **Created** | 2026-08-29 |
| **Delivered** | 2026-08-29 |

---

## 1. Problem

The sandbox works but is unreachable by anyone else. `LocalDockerDeployer` builds the
migrated application's own Dockerfile and runs it on the machine that ran the migration,
so the "tested sandbox application" the completion screen offers is a loopback address —
fine for a laptop demo, useless for a link in a message.

The second problem only appears once the first is fixed. A demo shown to an audience
produces one Cloud Run service and one container image per migration, and nothing in the
product removes either. Ten curious people leave ten services and ten images behind, and
the thing that fails is not the bill — it is that a URL labelled *not production* stays
live indefinitely with nobody watching it.

## 2. Sources of truth

| Source | Reference |
|---|---|
| Product spec | §36 sandbox deployment · §37 sandbox link |
| Data model | §3.16 sandbox deployments — `service.url`, `expiresAt`, `isProduction` |
| Deployment | §3 storage and registry · §4.3 `proteus-sandbox` service account · §8 teardown · §9 cost notes |
| Rulesets | `EXEC-REP-004` — deployment is gated on the verification verdict |
| PRD-12 | §3 "Cloud Build integration" and risk 1 "stream stage and step events during the build" — both deferred there, both land here |
| PRD-13 | `SandboxDeployer` interface, `LocalDockerDeployer`, `ScriptedDeployer` |
| PRD-14 | `POST /maintenance/rotation-sweep` — the sweep-as-endpoint pattern |
| Decisions | D-020 — hosting caps, and what happens past them |

## 3. Scope

**In**
- `CloudBuildExecutor` implementing the existing `BuildExecutor` interface —
  the half of PRD-12's scope that was deferred rather than dropped
- Live progress during a build: PRD-12 risk 1, still open
- `CloudRunDeployer` implementing the existing `SandboxDeployer` interface
- Image build and push to Artifact Registry via Cloud Build
- Cloud Run deploy with the cost and blast-radius limits of §4
- Two capacity caps on **retained** sandboxes — 3 per user, 30 platform-wide, both configurable
- Past a cap: still deploy and still verify, then release immediately
- A rerun of the same project replaces its container rather than adding one
- Every limit in §4 read from the environment, not hardcoded
- Lifecycle: absolute TTL, extended on access, hard ceiling
- `POST /maintenance/sandbox-sweep` — delete expired services **and their images**
- `POST /projects/{id}/sandbox/extend` and `DELETE /projects/{id}/sandbox`
- Completion screen: expiry shown, extend and tear down offered

**Out** — and where it lands instead
- Custom domains, TLS beyond the default `*.run.app` certificate → out of MVP
- Traffic-based inactivity via Cloud Monitoring → §8 risk 3; the access clock here is a
  deliberate approximation and its limits are stated
- Cost alerting and budget alarms → an operator concern, `gcloud billing budgets`

---

## 4. Functional requirements

### Build execution

| ID | Requirement | Source |
|---|---|---|
| FR-A | `CloudBuildExecutor` satisfies `BuildExecutor` unchanged; `BUILD_EXECUTOR` selects it | PRD-12 §3 |
| FR-B | It submits `deployment/cloudbuild/migration-build.yaml`, already written, and returns the same `ExecutionOutcome` shape — JUnit XML included, so every check downstream reads what it reads today | PRD-11 |
| FR-C | The repository credential reaches Cloud Build through Secret Manager, never through a substitution — substitutions are echoed into build logs | Deployment §5 |
| FR-D | Progress is emitted **during** a build, not only at its ends: each Cloud Build step and each `Tests run:` line becomes a DETAIL event | PRD-12 risk 1 |
| FR-E | The same streaming applies to `ProcessExecutor`, which today buffers the whole run through `execFile` and emits nothing until it exits | PRD-12 risk 1 |
| FR-F | The Cloud Build pipeline restores and saves a Maven dependency cache keyed by the build manifest, so a cold repository is paid once rather than once per execution | Measured, 2026-08-29 |
| FR-G | **Each end-to-end scenario emits its own event as it completes.** `runScenarios` already executes them one at a time and already has per-scenario status; it simply reports once at the end. It becomes an event per scenario | User challenge, 2026-08-29 |
| FR-H | A test run reports **grouped progress against a known total** — suites and tests completed out of the number the baseline recorded, split into three groups by what each suite is evidence *for*. See §17 | User challenge, 2026-08-29 |
| FR-I | The first run of a repository has no total and says so, rather than showing a bar that cannot fill. Every run after the baseline has one | §17 |

### Deployment

| ID | Requirement | Source |
|---|---|---|
| FR-1 | `CloudRunDeployer` satisfies `SandboxDeployer` unchanged; selecting it is configuration, not a code path | PRD-13 |
| FR-2 | The image is built by Cloud Build from the migrated branch's own Dockerfile and pushed to `ARTIFACT_REGISTRY_REPO` | Deployment §3 |
| FR-3 | The service runs as `proteus-sandbox`, which holds no IAM roles | Deployment §4.3 |
| FR-4 | Deployment still requires the verification verdict; nothing in this increment weakens `EXEC-REP-004` | `EXEC-REP-004` |
| FR-5 | The service is deployed with `--allow-unauthenticated`, and the record still says `isProduction: false` | Spec §36, §37 |

### Cost and blast radius

| ID | Requirement | Source |
|---|---|---|
| FR-6 | `min-instances=0` — an idle sandbox costs nothing. Never overridden | Deployment §9 |
| FR-7 | `max-instances` is capped (default 2) so a runaway migrated app cannot autoscale | §8 risk 2 |
| FR-8 | CPU, memory and request timeout are bounded (default 1 CPU, 512 MiB, 60 s) | §8 risk 2 |
| FR-9 | A rerun of the same project replaces its container. The service name is derived from `projectId`, the previous revision and image are superseded, and the project never holds two | D-020 |
| FR-10 | At most **3** projects per user hold a GCP sandbox at once | D-020 |
| FR-11 | At most **30** sandbox containers exist platform-wide at once | D-020 |
| FR-12 | Both caps reclaim expired sandboxes before refusing; a live one is never evicted to make room | §8 risk 1 |
| FR-13 | **The caps limit what is RETAINED, never what is deployed.** Every migration deploys, probes and exercises a real sandbox. Past a cap it is released immediately after the end-to-end scenarios pass, so verification is complete and only the shareable link is absent | D-020, revised 2026-08-29 |
| FR-14 | A released sandbox is recorded as `TORN_DOWN` with reason `CAPACITY`, and the report distinguishes that from a sandbox that failed. Both leave no link; only one is a defect | Spec §40 |
| FR-15 | Capacity refusals are a typed error carrying both counts and the cap that bound. They surface as a named API error code, a named check detail and a named event — never a 500 and never a generic message | D-020 |

### Lifecycle

| ID | Requirement | Source |
|---|---|---|
| FR-16 | Every deployment carries `expiresAt`, default 7 days from deploy | Data model §3.16 |
| FR-17 | Opening the sandbox through Proteus extends `expiresAt` by the same window — the "inactivity" clock | §8 risk 3 |
| FR-18 | A hard ceiling (default 30 days from first deploy) that extension cannot pass | §8 risk 3 |
| FR-19 | The sweep deletes the Cloud Run service **and** the Artifact Registry image; an image left behind is the part that actually accrues cost | §8 risk 4 |
| FR-20 | Teardown sets `status: TORN_DOWN`, clears `summary.sandboxUrl`, and emits an event — the completion screen stops offering a dead link | Spec §37 |
| FR-21 | A user can extend or tear down their own sandbox from the completion screen — the way to free a slot without waiting for expiry | UX v1.2 |
| FR-22 | Deleting a project deletes its sandbox and image | PRD-05 |
| FR-23 | A **locally** deployed sandbox is torn down too. `LocalDockerDeployer.dispose()` is never called today, so containers accumulate on the host — see §12 | Found 2026-08-29 |

---

## 5. Data model

| Collection | Access | Fields of note |
|---|---|---|
| `sandbox_deployments` | C/W | `service.url`, `service.revision`, `status`, `expiresAt`, `imageUri` |
| `projects` | W | `summary.sandboxUrl`, `summary.sandboxDeployed` |
| `execution_runs` | C | `IMAGE_BUILD`, `DEPLOY` |

**Schema changes required** — three fields on `SandboxDeployment`:

- `lastAccessedAt: Timestamp.optional()` — what FR-17 extends from.
- `hardExpiresAt: Timestamp.optional()` — the ceiling of FR-18.
- `placement: 'CLOUD_RUN' | 'LOCAL'` — which caps apply, and whether the URL is
  shareable. The screen already labels from `isProduction`; it labels reachability
  from this.

All optional or defaulted, so existing documents remain valid.

**Configuration** — every limit is an environment variable, documented in
`src/backend/.env.example` and validated at startup with the other GCP settings:

| Variable | Default | What it bounds |
|---|---|---|
| `SANDBOX_PLACEMENT` | `LOCAL` | `CLOUD_RUN` or `LOCAL`. Required to be `CLOUD_RUN` when Proteus itself runs on Cloud Run |
| `SANDBOX_MAX_PER_USER` | `3` | Retained sandboxes one user may hold |
| `SANDBOX_MAX_TOTAL` | `30` | Retained sandboxes platform-wide |
| `SANDBOX_TTL_DAYS` | `7` | Days from last access before reclaim |
| `SANDBOX_HARD_TTL_DAYS` | `30` | Ceiling no extension passes |
| `SANDBOX_MAX_INSTANCES` | `2` | Autoscale bound on untrusted code |
| `SANDBOX_CPU` / `SANDBOX_MEMORY` | `1` / `512Mi` | Per-instance resources |
| `SANDBOX_REQUEST_TIMEOUT_SECONDS` | `60` | Request timeout |
| `BUILD_EXECUTOR` | `LOCAL` | `CLOUD_BUILD` or `LOCAL` — where the migration's own build and tests run |
| `BUILD_IMAGE` | `maven:3.9-eclipse-temurin-17` | Toolchain for a `LOCAL` build |

`min-instances` is deliberately **not** configurable. It is always 0, because that is
what keeps an idle sandbox free, and no sandbox has a reason to want otherwise.

**Counting for the caps.** Both are counts of `sandbox_deployments` with
`placement: CLOUD_RUN` and a status that is neither `TORN_DOWN` nor `FAILED`. The
per-user count joins through `projects.ownerId`; a project appears once however many
times it has been rerun, because FR-9 makes a rerun replace rather than add. That is what
makes "3 per user" a count of *projects* rather than of runs.

## 6. Interfaces

**API**

| Method | Path | Notes |
|---|---|---|
| `POST` | `/projects/{id}/sandbox/extend` | Extends `expiresAt`, never past `hardExpiresAt`. Records `lastAccessedAt` |
| `DELETE` | `/projects/{id}/sandbox` | Tears down on demand |
| `POST` | `/maintenance/sandbox-sweep` | Cloud Scheduler calls it; deletes expired services and images |
| `GET` | `/sandbox/capacity` | What is used and what is free, per user and platform-wide. The screen needs it to explain a local fallback before it happens rather than after |

**Error codes** — capacity is never a 500 and never generic:

| Code | Status | Meaning |
|---|---|---|
| `SANDBOX_USER_CAP_REACHED` | 409 | This user already holds 3 hosted sandboxes. Names them, so the user knows which to tear down |
| `SANDBOX_PLATFORM_CAP_REACHED` | 503 | 30 of 30 platform-wide. Names when the earliest expires — a wait, not a refusal |
| `SANDBOX_NO_RUNTIME` | 503 | Beyond a cap and no local runtime either. The migration is verified except for the two sandbox checks, and the report says so |

**Events emitted** — `SANDBOX_DEPLOYMENT_STARTED`, `SANDBOX_DEPLOYMENT_READY` (MILESTONE),
and a teardown event at ACTIVITY.

**Agent involvement** — none. Deployment and teardown are deterministic; `EXEC-REP-004`
already decides whether a deploy may happen at all.

**Rules consumed** — `EXEC-REP-004` (unchanged), `EXEC-VER-010`/`-011` (unchanged — the
startup probe and the end-to-end scenarios run against the Cloud Run URL exactly as they
run against a local one).

## 7. Acceptance criteria

| ID | Criterion | Verified by |
|---|---|---|
| AC-1 | A verified migration produces a reachable `*.run.app` URL, and the end-to-end scenarios pass against it | command |
| AC-2 | The deployed service has `minScale=0` and the configured `maxScale`; a runaway app cannot scale past it | command |
| AC-3 | The sandbox service account holds no IAM role | command |
| AC-4 | At a cap, an expired sandbox is reclaimed and the deploy proceeds | test |
| AC-5 | A fourth project for one user still reaches `VERIFIED` — the sandbox deployed, the scenarios passed — and is then released with no link | test |
| AC-6 | A 31st sandbox platform-wide behaves the same, whoever owns it | test |
| AC-7 | A capacity release and a failed deployment are distinguishable in the report; only one is a defect | test |
| AC-8 | Rerunning a migration on the same project leaves exactly one service, one image and one live deployment record | test |
| AC-9 | Tearing down one sandbox frees a slot immediately — the next deploy is hosted | test |
| AC-10 | The sweep deletes both the service and its image | test · command |
| AC-11 | Opening the sandbox extends its expiry; the hard ceiling is never passed | test |
| AC-12 | A torn-down sandbox leaves no dead link on the completion screen | test · screen |
| AC-13 | Deleting a project removes its sandbox and image | test |
| AC-14 | A local sandbox is disposed when the run ends; reruns do not collide on the container name | test |
| AC-15 | Switching deployers is configuration only — the same tests pass against `ScriptedDeployer` | test |

## 8. Risks and open questions

| # | Risk or question | Impact | Resolution or owner |
|---|---|---|---|
| 1 | **How many can run at once?** Cloud Run's own limit is ~1,000 services per region — not the binding constraint. The real one is that nothing reclaims them | Forgotten services with live URLs | **3 per user, 30 platform-wide** (D-020). Beyond either, the migration falls back to local rather than failing. See §11 |
| 2 | **A migrated app under test may be broken in an expensive way** — an infinite loop serving requests, or a fork bomb of instances | Real spend, and it is someone else's code | `max-instances=2`, 1 CPU, 512 MiB, 60 s timeout. A sandbox needs none of the headroom a production service does |
| 3 | **"Inactivity" needs a definition.** True traffic inactivity needs Cloud Monitoring's `request_count`, another client and a role | Either extra machinery or a weaker guarantee | Approximate it: the clock resets when the sandbox is opened *through Proteus*. Someone who bookmarks the raw URL will not refresh it — stated plainly rather than papered over. Cloud Monitoring is a later refinement if it proves necessary |
| 4 | **Images, not services, are the persistent cost.** Cloud Run scales to zero; Artifact Registry does not | Slow unbounded growth | FR-14 deletes the image with the service, and a native Artifact Registry cleanup policy is the backstop |
| 5 | Cloud Build for the sandbox image is slower than a local Docker build | The last step of the demo gets a visible pause | The image build is already an event; it streams. Multi-stage caching in the fixture's own Dockerfile does most of the work |
| 6 | A public `*.run.app` URL running unreviewed third-party code | Reputational, not financial | It is what spec §37 asks for, the service account holds nothing, and the URL is labelled and expires. Worth stating in the demo |
| 7 | **Cloud Run has no Docker daemon**, so a Cloud-Run-hosted Proteus cannot run a container locally — not for the sandbox, and not for the migration's own build | In that topology the local paths are unavailable, not merely slower | Which is why FR-13 no longer falls back to local. Capacity changes what is *retained*, not where anything runs. `SANDBOX_PLACEMENT=CLOUD_RUN` and `BUILD_EXECUTOR=CLOUD_BUILD` are the required settings there, and startup refuses the local values when it detects no container runtime. See §14 |
| 8 | Two users hitting the last platform slot at once | Both deploy, 31 containers | The count is taken inside the same guarded write that claims the slot, the way PRD-10 made approval exactly-once. A lost race falls back to local, which is a correct outcome rather than an error |

## 9. Definition of done

- [x] All FRs implemented
- [x] All ACs verified
- [x] Typecheck and tests pass
- [x] `docs/pqc_migration_deployment_v1.md` §8 and §9 updated with the real policy
- [x] §10 records what was actually built

---

## 10. Delivery log

| Date | Change | Why |
|---|---|---|
| 2026-08-29 | `config/env.ts` — a `Hosting` group; ten variables in `.env.example` | Every limit configurable. `min-instances` deliberately excluded: it is always 0, which is what keeps an idle sandbox free |
| 2026-08-29 | `integrations/gcp/client.ts` — `GoogleApiTransport`, `ScriptedTransport`, `pollUntil` | REST over the gRPC SDKs. Zero new dependency tree, and the log polling FR-D needs is not something a generated client does better |
| 2026-08-29 | `integrations/cloudbuild/executor.ts` — `execFile` → `spawn` with a line reader | FR-E. The partial-line carry matters: a chunk boundary lands mid-line often enough to split `Tests run: 4, Fail…` across two events |
| 2026-08-29 | `integrations/cloudbuild/cloudBuildExecutor.ts` | FR-A/B/C/D. Submits the pipeline, polls to terminal, streams the log tail and step boundaries, returns the same `ExecutionOutcome` shape so every downstream check is unchanged |
| 2026-08-29 | `integrations/cloudrun/cloudRunDeployer.ts` | FR-1…FR-8. Creates or replaces by project-derived name; `minInstanceCount: 0`, `cpuIdle: true`, bounded max; teardown deletes the image as well as the service |
| 2026-08-29 | `integrations/cloudrun/sandbox.ts` — `docker rm -f` before run; `teardown` on the interface | The two live defects. See "Found while building" |
| 2026-08-29 | `core/migration/progress.ts` — `parseLine`, `buildGroups`, `totalsFor`, `ProgressTracker` | FR-H/I. The baseline is the denominator Maven never announces |
| 2026-08-29 | `core/services/sandboxCapacity.ts`, `sandboxLifecycle.ts` | D-020. Caps on retention, reclaim-before-refuse, two clocks, the sweep |
| 2026-08-29 | `worker/verificationJob.ts` — retain-or-release after E2E; teardown on failure | The core of D-020, and the container leak |
| 2026-08-29 | `verification/e2e.ts` — `onScenario` | FR-G. `runScenarios` already had every verdict the moment it existed |
| 2026-08-29 | `integrations/gcp/factory.ts` — `assertRuntimeAvailable` | A `LOCAL` setting on a host with no Docker fails at boot, not forty minutes into a demo |
| 2026-08-29 | `api/routes/` — `POST /sandbox/extend`, `DELETE /sandbox`, `GET /sandbox/capacity`, `POST /maintenance/sandbox-sweep` | FR-15…FR-21 |
| 2026-08-29 | `deployment/cloudbuild/migration-build.yaml` — `restore-cache` / `save-cache` | FR-F. Keyed by a hash of the manifest, written only on a miss |
| 2026-08-29 | Frontend: grouped progress panel, sandbox expiry, extend, tear down, capacity notice | FR-H, FR-21 |
| 2026-08-29 | `test/hosting.test.ts` (29 backend), `test/migration.test.ts` (+5 frontend) | Every AC, with the GCP calls scripted and everything else real |

**Verified against real output, not fixtures**

The parser and the streaming were built against captured Maven output and then run for
real. `ProcessExecutor` against the fixture with one rigged assertion, timestamps as they
arrived:

```
  +1.4s  ▸ Running unit tests
  +3.8s  ✓ CryptoServiceTest — 2 tests  [MIGRATION_TARGET]   7/36 tests · 3/13 suites
  +3.9s  ✗ WrapLengthTest — 2 tests     [REGRESSION_SURFACE] 20/36 tests · 7/13 suites
  +3.9s      ✗ wrapsToTwoFiftySix
  +3.9s        wrapped key length ==> expected: <256> but was: <1088>
  +4.4s  ✓ LedgerRepositoryTest — 3 tests                    36/36 tests · 12/13 suites
```

Grouping correct, counters advancing against a baseline-derived denominator, and the
failing method named with its assertion — all of it arriving during a run that previously
showed nothing until it ended.

**Deviations from plan** —

1. **REST rather than the Google client libraries.** `@google-cloud/cloudbuild` and
   `@google-cloud/run` are gRPC clients pulling in `google-gax`; the two things needed here
   are plain JSON over HTTPS, and `google-auth-library` was already present for the storage
   client. The deciding factor was FR-D: streaming needs the log object polled on a
   schedule this code chooses, which is not what a generated long-running-operation client
   is shaped for.

2. **`SandboxDeployer` gained `teardown`.** The `Deployed` handle was enough for the run
   that created a deployment and useless for everything else — a sweep reclaiming an
   expired sandbox has a name from a document, not a handle from a process that exited days
   ago.

3. **One pipeline serves both build and test executions.** `_BUILD_CMD` and `_TEST_CMD` are
   set to the caller's single command, so the two stay separate `ExecutionRun`s and
   `EXEC-VER-002` keeps something of its own to read. A second pipeline would have
   duplicated the cache and collect steps for no gain.

4. **`assertRuntimeAvailable` logs rather than exits.** A misconfigured runtime is worth
   shouting about at boot, but refusing to start would also take down the API, the
   assessment path and every completed project's report — none of which need Docker.

5. **The frontend rebuilds progress from the event stream rather than holding its own
   state.** The events are already persisted and already replayed on reconnect, so a
   refresh mid-build restores the same picture instead of an empty panel — the property
   every other live screen here already has.

**Found while building** —

**A count that contained its own separator.** The frontend extracted the running total with
`message.split(' · ').at(-1)`, and the total is itself `"4/5 tests · 2/4 suites"` — so the
panel showed half the answer. Now matched with a regex rather than split. A reminder that
parsing prose out of a message is fragile; the alternative is a schema change to carry
progress structurally, which is noted as the thing to do if this grows.

**Both PRD-13 defects fixed and covered.** `LocalDockerDeployer.deploy` now removes any
container of the same name first, so a rerun replaces rather than colliding — the second
migration of a project previously failed to deploy locally. And `deploySandbox` tears the
container down when a deployment fails, where nothing called `dispose` before.

**Deferred** —

- **Cloud Build source staging for the sandbox image.** `CloudRunDeployer.stageSource`
  returns the `storageSource` shape Cloud Build expects but does not upload the archive
  itself; the working copy still needs tarring to GCS before an image build will succeed
  against a real project. The Cloud Run and Artifact Registry paths are complete.
- **`SANDBOX_STREAM_GENERATED_TESTS`.** The flag is defined and documented; the per-method
  invocation of agent-written suites is not wired. Failing methods already stream with
  their assertion whatever it is set to, so this only adds the names of *passing* methods —
  three seconds of run time for green ticks on the two acceptance tests.
- **Traffic-based inactivity.** The clock resets when the sandbox is opened through
  Proteus. True request-count inactivity needs Cloud Monitoring, another client and another
  role; the approximation and its limit are stated in §11 rather than hidden.
- **A first live run against the real project.** Every GCP call is exercised against a
  scripted transport and every non-GCP path against real Maven, real Docker and a real
  Mongo. Nothing has yet been submitted to an actual Cloud Build or deployed to an actual
  Cloud Run — that needs the credentials in `.env` and is the obvious next step.

---

## 11. What this actually costs, and how many can run

> Not part of the template. It is here because the caps in §4 are otherwise arbitrary
> numbers, and the reasoning behind them is the thing worth keeping.

### Cloud Run is not the cost

Cloud Run bills for CPU and memory **only while a request is being served**, plus a
per-request fee, and scales to zero in between. A sandbox nobody is looking at costs
nothing. The free tier — 2 million requests, 180,000 vCPU-seconds and 360,000 GiB-seconds
per billing account per month — is far beyond what a demo consumes.

The one way to break that is `--no-cpu-throttling` or `min-instances≥1`, which bill
continuously. FR-6 forbids both for sandboxes. (The Proteus **backend** is a different
service and does need `min-instances=1` for SSE — that is the always-on cost the
deployment doc already names.)

### Artifact Registry is the cost, and it is small

Images persist. A Spring Boot image on `eclipse-temurin:17-jre` is roughly 300–400 MB,
and layers shared with other images in the same repository do not pay twice. Storage runs
around **$0.10 per GB per month** above a 0.5 GB free allowance.

Twenty demo sandboxes is single-digit gigabytes — well under a dollar a month. Which is
the point: **the cap in FR-9 is not there to control spend.** It is there so that a URL
labelled *not production* does not stay live with nobody watching it, and so a runaway
app has a bounded blast radius. Ten is a number chosen to be comfortably more than a
demo needs and obviously less than "unbounded".

### Cloud Build

Each sandbox image build is a few minutes. The free allowance on the default machine type
covers a demo; the migration's own build loop is the heavier consumer, and the
four-attempt retry budget already bounds that.

> These figures are the right order of magnitude as of writing and are not a quote.
> Confirm against the current pricing pages before running anything at scale.

### The caps, concretely

```
per user      3 projects with a hosted sandbox
platform     30 containers, all users
rerun         replaces — a project holds one container however often it is migrated

every migration ──► deploy · probe · run the end-to-end scenarios
                      │
                      ├─ expired sandboxes reclaimed first
                      ├─ under both caps ──► RETAINED  · shareable URL, 7-day clock
                      └─ over a cap      ──► RELEASED  · torn down straight after the
                                                          scenarios pass. VERIFIED, but
                                                          no link. Reason: CAPACITY
```

The caps bound what is **kept**, not what is verified. An over-cap sandbox exists for
about a minute, which costs nothing and leaves the verdict untouched — the alternative,
refusing to deploy, would fail `SANDBOX_DEPLOYMENT_SUCCESSFUL` and report someone's
correct migration as unverified because the platform was busy.

Thirty containers is roughly 10 GB of images — a few dollars a month at most, and well
inside every Cloud Run free-tier dimension while idle. The number is not a spend limit.
It is the point past which a demo has more live URLs than anyone is watching.

### The lifecycle, concretely

```
deploy ──► expiresAt = now + 7d
           hardExpiresAt = now + 30d

open through Proteus ──► expiresAt = min(now + 7d, hardExpiresAt)

sweep (hourly) ──► for each deployment past expiresAt:
                     delete Cloud Run service
                     delete Artifact Registry image
                     status = TORN_DOWN, clear summary.sandboxUrl
```

Seven days of not being opened, thirty days maximum, whichever comes first. A sandbox
that is being actively reviewed stays up; one that has been forgotten does not.

---

## 12. One sandbox, not two

> The question this section answers: does the agent test against a local sandbox and then
> separately deploy a GCP one to share? **No — and it should not.**

There is one deployment per migration. `deploySandbox` builds an image, deploys it, probes
it until it answers, runs the end-to-end scenarios against it, and records the URL. The
URL the completion screen offers is the same service the scenarios were executed against.
A two-phase design — verify against one instance, then ship another — would mean the link
a reviewer opens was never the thing that passed.

What varies is *where* that single deployment lives, and that is the whole purpose of the
`SandboxDeployer` interface:

```
                    ┌──────────────────────────────────────┐
  verification ────►│ SandboxDeployer.buildImage + deploy   │────► base URL
                    └──────────────────────────────────────┘         │
                         LocalDockerDeployer  →  127.0.0.1:51921      │
                         CloudRunDeployer     →  https://….run.app    │
                                                                      ▼
                                        probeStartup(url) · runScenarios(url)
                                                                      │
                                                                      ▼
                                        SANDBOX_DEPLOYMENT_SUCCESSFUL · E2E
```

`probeStartup` and `runScenarios` take a base URL and nothing else. Neither knows which
implementation produced it, which is why `SANDBOX_PLACEMENT` is configuration rather than
a code path — and why a locally-hosted sandbox is verified to exactly the same standard as
a hosted one. The only thing that differs is whether the URL can be sent to somebody.

**Where Proteus itself runs decides which placement is possible.** A Cloud Run container
cannot start another container: there is no Docker daemon, no `/var/run/docker.sock`, and
no privileged mode. So in the topology this product is heading for, `LOCAL` is not a
degraded option — it is unavailable, and startup says so rather than failing at the first
migration.

---

## 13. Two defects this increment inherits

> Found while confirming the above. Both affect the **local** path, which FR-13 now makes
> load-bearing rather than a development convenience — so both matter more than they did.

**1 · Local containers are never disposed.** `deploySandbox` obtains a `Deployed` handle
and never calls `dispose()`. Every verified migration leaves a container running on the
host indefinitely. Harmless on a laptop that gets restarted; not harmless once the local
path is the fallback for everyone past a cap.

**2 · A rerun of the same project collides on the container name.**
`LocalDockerDeployer.deploy` passes `--name proteus-sandbox-<projectId>`, and `docker run`
refuses a name already in use. So the second migration of the same project fails to deploy
locally — which is exactly the case FR-9 says must *replace*. The fix is the same one FR-9
describes: remove the existing container first, then start the new one.

Neither is a design problem; both are the delivered code not yet having a lifecycle. FR-9
and FR-23 cover them.

---

## 14. What has to be true for Proteus to run on Cloud Run

> Also raised by the same question, and larger than the sandbox.

The migration's own build and test loop has the identical constraint. `ProcessExecutor`
runs `mvn -B verify` either directly on the host or inside `maven:3.9-eclipse-temurin-17`
via Docker — both need a machine Proteus controls. Neither works inside Cloud Run.

Spec §32 already anticipated this: it names **Cloud Build** as the environment for
compiling, running unit and integration tests, running mocks, and collecting execution
evidence. `ProcessExecutor` was always the local stand-in for it.

So hosting Proteus on Cloud Run requires both substitutions, not one:

| Concern | Local implementation | Hosted implementation | Increment |
|---|---|---|---|
| Migration build and tests | `ProcessExecutor` | `CloudBuildExecutor` | **PRD-16** |
| Sandbox hosting | `LocalDockerDeployer` | `CloudRunDeployer` | **PRD-16** |

Both sit behind interfaces that already exist and are already exercised by tests through
`ScriptedExecutor` and `ScriptedDeployer`, so neither is a redesign. Both are in this
increment because they are one topology change, not two — a hosted Proteus needs both or
neither, and shipping only the sandbox half would leave a service that cannot build the
repository it is migrating.

The alternative, if this increment slips: host the Proteus backend on a **GCE VM or a Compute
Engine–backed environment with Docker**, where both local implementations work today and
the sandbox can still be `CLOUD_RUN` for shareable links. That is a deployment choice, not
a code change, and it is the smaller path to a working public demo.

---

---

## 15. How long it takes, and what the screen shows while it does

> Measured against `fixtures/payments-api` in `maven:3.9-eclipse-temurin-17`, not estimated.

### The migration's own test suite

| | Build (`-DskipTests`) | Test (`mvn -B verify`) |
|---|---|---|
| Fresh tree, warm dependency cache | 1.9 s | 7.1 s |
| Fresh tree, cold cache — first run on a machine | 33.1 s | 9.4 s |

The cold number is Maven downloading the Spring Boot dependency tree, and it is paid once
per cache rather than once per migration. `ProcessExecutor` mounts a persistent `m2`
volume for exactly that reason.

**Cloud Build now does the equivalent.** `migration-build.yaml` gained `restore-cache` and
`save-cache` steps around the build: the repository is restored into `/workspace/.m2` and
Maven is pointed at it with `-Dmaven.repo.local`. The cache key is a hash of the build
manifest, because that is precisely what decides the dependency set — the same `pom.xml`
resolves the same tree, and a changed one should miss. The tar is written **only on a
miss**; re-uploading an unchanged 100 MB archive on every build would cost more egress than
the cache saves. Configure the location with `_CACHE_URI`.

A reference-scenario run executes the suite about five times: baseline, after the patch,
after the repair, then the verification build and test. **Roughly 45 seconds of build on a
warm cache**, plus the sandbox: image build, then a 2.1 s startup probe and three
end-to-end scenarios that complete in about 200 ms combined.

Cloud Build adds a submission round trip — a worker has to be allocated and the source
staged — so expect each execution to cost noticeably more than the local numbers above.
That is what makes FR-D non-optional rather than a nicety.

### What the feed shows during all this — today, nothing

`ProcessExecutor` uses `execFile`, which buffers the entire run and returns when the
process exits. `migrationLoop` emits `BUILD_STARTED` before the call and
`TEST_PASSED`/`TEST_FAILED` after it. Between them the feed does not move, and no
individual test result is streamed — the per-test detail comes from parsing the JUnit XML
*after* Maven has finished writing it.

At 7 seconds nobody notices. At a Cloud Build round trip they will, and it lands on the
screen the product calls its second WOW moment.

FR-D and FR-E close it. **Per test class, live, as it happens — not per test method.**

That is not a compromise chosen for convenience; it is the granularity Maven actually
emits. Captured from a real `mvn -B verify` against the fixture:

```
[INFO] --- compiler:3.11.0:testCompile (default-testCompile) @ payments-api ---
[INFO] --- surefire:3.1.2:test (default-test) @ payments-api ---
[INFO] Running pay.security.CryptoServiceTest
[INFO] Tests run: 2, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.026 s -- in pay.security.CryptoServiceTest
[INFO] Running pay.security.WebhookVerifierTest
[INFO] Tests run: 4, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.013 s -- in pay.security.WebhookVerifierTest
```

Three line shapes are worth an event, and all three arrive while the run is still going:

| Line | Event |
|---|---|
| `--- <plugin>:<goal> …` | phase boundary — compiling, running unit tests, running integration tests |
| `Running <suite>` | that test class has started |
| `Tests run: N, Failures: F … in <suite>` | that class finished, with its counts |

On the reference fixture that is **13 classes × 2 lines, plus phase boundaries — about 30
live rows** during a run that currently shows none.

### Why the repository's own tests are not driven one at a time

The obvious alternative is to stop invoking `mvn verify` once and instead invoke Maven per
test — `-Dtest=pay.security.CryptoServiceTest` — so the loop is ours and every result is
ours to report. It needs no change to anyone's build configuration; `-Dtest` is a
command-line flag. Two real reasons not to, and the second is the one that matters.

**It costs 3.7× at class granularity and roughly ten times at method granularity.**
Measured on the fixture:

| | Time |
|---|---|
| `mvn -B verify` — 13 classes, 36 tests, one JVM | **9.5 s** |
| `-Dtest=pay.util.CryptoUtilsTest` — plain unit class | 1.3 s |
| `-Dtest=pay.security.CryptoServiceTest` | 3.0 s |
| `-Dtest=pay.SettlementControllerTest` — `@SpringBootTest` | 3.9 s |

Thirteen classes at ~2.7 s each is **≈35 s** against 9.5 s. Per method — 36 invocations —
is minutes. A reference run executes the suite five times, so this is the difference
between about 50 seconds of build and about three minutes of it.

**It changes what the tests mean, and would manufacture false regressions.** Spring caches
its application context across test classes inside one JVM; that is the entire gap between
1.3 s and 3.9 s above. Split into separate JVMs and every class rebuilds it. Worse, a suite
with shared or static state — which the fixture deliberately has, an in-memory
`LedgerRepository` and a stateful `IdempotencyStore`, because real code looks like that —
behaves differently in isolation than in sequence.

That collides directly with `EXEC-VER-003`, which asserts that **every test passing at
baseline still passes**. If the baseline ran as one suite and verification ran class by
class, the two sides of that subset relation were produced by different execution modes,
and a test that only passes in a shared context would be reported as a regression the
migration did not cause. The check would be measuring our harness rather than the
migration.

So the repository's suite runs the way its own developers run it, and progress comes from
reading Maven's output as it goes. The per-method detail still arrives from the JUnit XML
the moment the run finishes — that is where every failing test's name, message and stack
head comes from today and will continue to.

### The scenarios we wrote are different, and you were right about them

`SETTLEMENT_SCENARIOS` are ours, not the repository's. `runScenarios` already loops over
them one at a time, already has each one's pass, fail and latency, and already continues
past a failure so the report is complete. Everything needed to stream them exists — they
are simply reported once at the end.

FR-G fixes that: one event per scenario, as it completes. No new machinery, no cost, and it
is the phase where a viewer is most engaged, watching a real URL answer.

So: test classes tick past live during the build, our own scenarios tick past live against
the sandbox, and full per-test detail lands on completion.

The change is contained: `execFile` becomes `spawn` with a line reader, and the executor
gains an optional `onLine` callback the loop turns into DETAIL events. Cloud Build gives
the same three shapes — step boundaries from the build resource, and the Maven lines from
the streamed log. The buffered path stays for `ScriptedExecutor`, so no existing test
changes.

---

## 16. Where the tests we write are kept

> Asked directly. The answer is yes, on both sides, and the reason it is both matters.

A generated test has two homes, and neither is a copy of the other:

**On the branch.** `git.writeFile` writes it into the working copy and `ChangeRecorder`
commits it to `agent/pqc/{projectId}`. That is where it belongs — a test written to prove
a migration is part of the migration, and a reviewer pulling the branch must find it beside
the code it exercises. It is also what makes it runnable: `mvn verify` picks it up because
it is in `src/test/`, not because we told Maven about it.

**On our side, in the diff.** `ChangeRecorder` calls `git show --patch` for each commit and
stores the result at `gcsPath.changeDiff(projectId, changeId)`. A newly added file's patch
*is* its full contents, so the complete text of every generated test is retained in blob
storage, independent of the repository. `MigrationChange` records the paths, the summary,
the rationale and — for a test, mock or fixture — the `testIntegrity` record; the
`GIT_DIFF` artifact assembles all of it with each modification's reasoning printed above
its hunk.

So if the branch is deleted, force-pushed over, or the repository access is revoked, the
evidence package still contains every line the agent wrote and why. That independence is
the point of keeping both.

**What is deliberately not kept:** a separate first-class "tests we wrote" collection. It
would be a third copy that can disagree with the other two, and the question it answers —
*what did the agent add, and why was that safe?* — is already answered by the diff and the
integrity record, in the one place a reviewer is looking anyway.

---

## 17. Grouped live progress

> The middle ground between "nothing until it finishes" and per-method streaming that
> would corrupt the evidence. Nothing here is invented: every number comes from either the
> baseline inventory or a line Maven has already printed.

### The denominator already exists

The reason a progress bar looked impossible is that Maven does not announce how many test
classes it is about to run. But **the baseline does.** `Baseline.tests.inventory` records
every test that ran on the base commit — 36 tests across 13 suites on the reference
fixture — and it is captured before any modification precisely so later runs can be
compared against it.

Add the suites the agent generated, which are known from the `MigrationChange` records
with `intent: TEST_ENGINEERING`, and the total for every subsequent run is exact:

```
total suites = baseline suites + generated suites
total tests  = baseline tests  + generated tests
```

The baseline run itself has no denominator, and FR-I makes it say so rather than render a
bar that cannot fill.

### Three groups, because they answer three different questions

Grouping by package would be arbitrary. Grouping by what a suite is *evidence for* is not,
and it maps to what a viewer actually wants to know:

| Group | Membership | The question it answers |
|---|---|---|
| **Migration targets** | Suites whose subject appears in an approved plan item's `expectedChanges` — `CryptoServiceTest` for `CryptoService.java` | Does the thing you changed still work? |
| **New evidence** | Suites the agent wrote — the characterization and acceptance tests | Does the thing you added prove anything? |
| **Regression surface** | Everything else in the baseline inventory | Did you break anything you were not touching? |

Membership is decided once, before the run, from data that already exists. A suite Maven
reports that belongs to no group is a suite the baseline never saw — which is itself worth
showing, and lands in **New evidence** with a note.

### What arrives, and when

Every line below is one Maven already prints; the executor streams stdout and the loop
turns three shapes into events.

```
RUNNING TESTS                                        21 / 36 tests · 7 of 13 suites

  Migration targets      ██████░░░░   2 / 3 suites
    ✓ pay.security.CryptoServiceTest          2 tests   0.03s
    ✓ pay.util.CryptoUtilsTest                3 tests   0.01s
    ▸ pay.security.SettlementSignerTest       running…

  New evidence           ██████████   1 / 1 suites
    ✓ pay.security.CryptoServiceKemTest       2 tests   0.31s

  Regression surface     ████░░░░░░   4 / 9 suites
    ✓ pay.SettlementControllerTest            4 tests   1.20s
    ✓ pay.store.LedgerRepositoryTest          3 tests   0.00s
    …
```

| Maven line | Effect |
|---|---|
| `--- surefire:3.1.2:test …` | phase changes to *unit tests*; `--- failsafe:…` to *integration tests* |
| `Running pay.security.CryptoServiceTest` | that row appears as running, in its group |
| `Tests run: 2, Failures: 0 … in pay.security.CryptoServiceTest` | the row resolves with its counts; both bars advance |
| `pay.X.methodName -- Time elapsed: … <<< FAILURE!` | **the failing method, named, nested under its suite** |
| `org.opentest4j.AssertionFailedError: expected: <256> but was: <1088>` | that method's assertion message, verbatim |
| `at pay.X.methodName(X.java:42)` | the source line it failed on |

### Failures already stream per method — verified

The last three rows are the finding that decides how much the optional extra is worth.
Surefire is asymmetric, and asymmetric in exactly the useful direction. Captured from a
real run with one rigged assertion:

```
[INFO]  Running pay.WrapLengthTest
[ERROR] Tests run: 2, Failures: 1, Errors: 0, Skipped: 0, Time elapsed: 0.027 s <<< FAILURE! -- in pay.WrapLengthTest
[ERROR] pay.WrapLengthTest.wrapsToTwoFiftySix -- Time elapsed: 0.016 s <<< FAILURE!
org.opentest4j.AssertionFailedError: wrapped key length ==> expected: <256> but was: <1088>
	at pay.WrapLengthTest.wrapsToTwoFiftySix(WrapLengthTest.java:5)
```

**Passing methods are never named** — a suite reports only its count. **Failing methods
are named individually, live, with the assertion message and the source line.**

That is the right asymmetry for a feed. Nobody needs thirty-four passing test names
scrolling past; they need the one that broke, named, with why — and that arrives the
moment it happens, several seconds before the JUnit XML exists. The row for the fixture's
own rigged failure reads, live:

```
  Migration targets      ██████░░░░   2 / 3 suites
    ✗ pay.PartnerHandshakeIntegrationTest     1 of 2 failed   0.03s
        transportsASessionKeyToTheAcquirer
        expected: <256> but was: <1088>              PartnerHandshakeIntegrationTest.java:61
```

and the `FAILURE_DIAGNOSED` line that follows explains it. So the failure detail the
screen needs is **already in the stream**, at no cost and with no change to how anything
runs.

A failing suite resolves red and stays visible with its counts, so the viewer sees *which*
group broke while the rest of the run continues.

### Why this is the right stopping point

It gives the thing per-method streaming was wanted for — continuous, specific, honest
movement — without changing how the tests execute. The suite still runs as one invocation,
in one JVM, exactly as its own developers run it, so `EXEC-VER-003`'s subset comparison is
still between two like measurements. The progress is read *off* the run rather than
imposed *on* it.

And the per-method detail is not lost, only deferred by a few seconds: the JUnit XML lands
when Maven finishes, and every failing test's name, message and stack head comes from
there — as it does today.

### Cost

`ExecutionRun.logExcerpt` is capped at 50 lines and the events are `DETAIL` level, which
spec §38 already keeps out of the milestone feed and in the audit drawer. Thirteen suites
produce about 30 events per run; a five-execution migration produces roughly 150. That is
well inside what the SSE stream and the event log carry today — discovery emits more.

### The one thing still missing, and the optional way to get it

After the above, exactly one thing does not stream: **the names of passing methods.**
Surefire does not print them, and that is the whole of the gap.

It matters in one place. The agent's own acceptance tests are the assertions the migration
is *about* — `producesFips203Sizes`, `roundTripsTheSharedSecret` — and watching those two
names tick green is a different experience from watching a suite counter reach 2/2.

`SANDBOX_STREAM_GENERATED_TESTS=true` drives **only the agent-generated suites** one method
at a time, with `-Dtest=Class#method`. The semantics objection does not apply to them: they
were written this run, they have no shared-state history, and there are a handful rather
than thirty-six. On the reference scenario that is 2 extra Maven invocations, measured at
about 1.3 s each — call it three seconds for per-assertion green ticks on precisely the
tests the demo exists to show.

The repository's own suite is never driven this way, for the reasons above. Default off,
because three seconds of an audience's attention is a real cost and the failure detail —
the part that carries the demo — already streams without it.
