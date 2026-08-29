# PRD-16 · GCP Execution & Sandbox Hosting

| | |
|---|---|
| **Increment** | 16 |
| **Status** | `PLANNED` |
| **Depends on** | PRD-11, PRD-12, PRD-13, PRD-14 |
| **Unblocks** | — public demo |
| **Demoable outcome** | Proteus runs as a hosted service: it builds and tests the repository on Cloud Build with the feed moving line by line, and the migrated application is reachable on a real `*.run.app` URL that disappears on its own. |
| **Created** | 2026-08-29 |
| **Delivered** | |

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

- [ ] All FRs implemented
- [ ] All ACs verified
- [ ] Typecheck and tests pass
- [ ] `docs/pqc_migration_deployment_v1.md` §8 and §9 updated with the real policy
- [ ] §10 records what was actually built

---

## 10. Delivery log

| Date | Change | Why |
|---|---|---|

**Deviations from plan** —

**Deferred** —

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

**Per-test-method streaming is not offered.** Surefire does not print it; obtaining it
would mean injecting a JUnit `RunListener` into the repository under migration, which
changes someone's build configuration to improve our own progress bar — a scope change
`EXEC-VER-001` would rightly flag. The per-method detail still arrives, from the JUnit XML,
the moment the run finishes: that is where every failing test's name, message and stack
head comes from today and will continue to.

So the user sees test classes tick past live, then the full per-test detail on completion.

The change is contained: `execFile` becomes `spawn` with a line reader, and the executor
gains an optional `onLine` callback the loop turns into DETAIL events. Cloud Build gives
the same three shapes — step boundaries from the build resource, and the Maven lines from
the streamed log. The buffered path stays for `ScriptedExecutor`, so no existing test
changes.
