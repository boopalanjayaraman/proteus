# Proteus — Infrastructure & Deployment v1

Everything needed to stand the product up in a Google Cloud project: the services, the
identities, the roles each one actually needs and why, the secrets, and the order to
create them in.

Companions: `docs/PQC_Migration_Tech_Stack_v1.md` (what the services are for),
`docs/pqc_migration_data_model_v1.md` (§3.2 for the credential model),
`docs/pqc_migration_folder_structure_v1.md` (where the deployment files live).

---

## 1. What runs where

```text
Firebase Hosting ─────── React frontend            (public bundle, VITE_* only)
        │ REST + SSE
        ▼
Cloud Run service ────── Node backend / API        min-instances 1, CPU always on
        │
        ├── Cloud Run job ─── migration worker     the autonomous loop
        ├── MongoDB Atlas ─── product state        replica set REQUIRED
        ├── Cloud Storage ─── blobs                logs, diffs, PDFs, reports
        ├── Secret Manager ── deployment + per-project secrets
        ├── Cloud Build ───── build/test of the repository UNDER MIGRATION
        │       └── Artifact Registry ─── sandbox images
        │               └── Cloud Run ──── sandbox application  (isolated, not prod)
        └── GitHub ────────── per-project PAT, fetched per call
```

Two things about this shape are easy to get wrong.

**The backend must not be request-scoped.** A migration outlives the HTTP request that
approved it and the browser that watched it start. The API runs with
`--min-instances=1 --no-cpu-throttling`, and the migration loop runs as a **Cloud Run
Job**, not inside a request handler.

**Cloud Build here is not CI for this repository.** It is the disposable engineering
environment in which the agent compiles and tests *somebody else's* application. That is
the least trusted code in the system, which is what drives the service-account design in
§4.

---

## 2. Enable the APIs

```bash
export PROJECT_ID=your-project-id
export REGION=us-central1
gcloud config set project "$PROJECT_ID"

gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  storage.googleapis.com \
  iam.googleapis.com \
  iamcredentials.googleapis.com \
  firebase.googleapis.com \
  identitytoolkit.googleapis.com \
  aiplatform.googleapis.com          # only if GOOGLE_GENAI_USE_VERTEXAI=true
```

---

## 3. Storage, registry, database

```bash
# Blobs. Uniform access — per-object ACLs make the audit story unprovable.
gcloud storage buckets create "gs://proteus-${PROJECT_ID}" \
  --location="$REGION" --uniform-bucket-level-access

# Sandbox images.
gcloud artifacts repositories create proteus-sandbox \
  --repository-format=docker --location="$REGION"
```

**MongoDB Atlas** — an M0 free tier is enough for the prototype, but it **must be a
replica set**. The SSE fan-out tails a change stream and a standalone `mongod` cannot
open one. Atlas is a replica set by default; a local Docker instance needs `--replSet`.
Allow the Cloud Run egress addresses, or use a VPC connector with Atlas private
endpoints if you want the database off the public internet.

---

## 4. Service accounts and roles

Four identities. Each gets only what its job needs, and the reason is recorded because a
role granted without one is a role nobody dares remove later.

### 4.1 `proteus-api` — the backend service

```bash
gcloud iam service-accounts create proteus-api \
  --display-name="Proteus backend API"
API_SA="proteus-api@${PROJECT_ID}.iam.gserviceaccount.com"
```

| Role | Why |
|---|---|
| `roles/secretmanager.secretAccessor` | Read per-project GitHub PATs and deployment secrets at call time. |
| `roles/secretmanager.admin` **scoped to `proteus-*` secrets** | Create a project's secret at creation and destroy it at deletion. Project-wide admin would let the API read every secret in the project, including ones that have nothing to do with it. |
| `roles/storage.objectAdmin` **on the bucket only** | Write uploads, extracted text, diffs, reports. |
| `roles/cloudbuild.builds.editor` | Trigger and poll build/test runs. |
| `roles/run.developer` | Deploy sandbox services. |
| `roles/iam.serviceAccountUser` **on `proteus-sandbox` only** | Required to deploy a Cloud Run service that runs *as* the sandbox identity. |
| `roles/aiplatform.user` | Only when using Vertex AI instead of a Gemini API key. |
| `roles/datastore.user` *(not used)* | — Firestore is explicitly out of scope; MongoDB is the system of record. |

```bash
# Bucket-scoped, not project-wide.
gcloud storage buckets add-iam-policy-binding "gs://proteus-${PROJECT_ID}" \
  --member="serviceAccount:${API_SA}" --role=roles/storage.objectAdmin

for R in secretmanager.secretAccessor cloudbuild.builds.editor run.developer; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${API_SA}" --role="roles/${R}" --condition=None
done
```

**Scoping the secret admin role.** Grant `secretmanager.admin` with an IAM condition so
it only covers the secrets this product owns:

```bash
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${API_SA}" \
  --role=roles/secretmanager.admin \
  --condition='expression=resource.name.extract("/secrets/{n}").startsWith("proteus-"),title=proteus-secrets-only,description=Only secrets this product creates'
```

### 4.2 `proteus-build` — Cloud Build

This is the identity that compiles and runs the repository under migration, plus tests
the agent generated. Treat it as the least trusted principal in the project.

```bash
gcloud iam service-accounts create proteus-build \
  --display-name="Proteus Cloud Build — runs the repo under migration"
BUILD_SA="proteus-build@${PROJECT_ID}.iam.gserviceaccount.com"
```

| Role | Why |
|---|---|
| `roles/logging.logWriter` | Build logs. Cloud Build fails without it. |
| `roles/storage.objectAdmin` **on the bucket only** | Write test reports and structured failure evidence. |
| `roles/artifactregistry.writer` **on the repo only** | Push the sandbox image. |

**Deliberately not granted:** `secretmanager.secretAccessor`. The build must never see
the GitHub PAT — source arrives as an archive staged by the API, so the build never
authenticates to GitHub. Also not granted: `run.developer`. The build produces an image;
the API deploys it. Splitting those means a compromised build cannot deploy itself.

```bash
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${BUILD_SA}" --role=roles/logging.logWriter --condition=None

gcloud storage buckets add-iam-policy-binding "gs://proteus-${PROJECT_ID}" \
  --member="serviceAccount:${BUILD_SA}" --role=roles/storage.objectAdmin

gcloud artifacts repositories add-iam-policy-binding proteus-sandbox \
  --location="$REGION" \
  --member="serviceAccount:${BUILD_SA}" --role=roles/artifactregistry.writer
```

Then set `CLOUD_BUILD_SERVICE_ACCOUNT` in `src/backend/.env` to `$BUILD_SA`. Leaving it
blank falls back to the default Cloud Build account, which is broadly privileged — fine
for a first run, wrong before this touches anything real.

### 4.3 `proteus-sandbox` — the migrated application

The identity the deployed sandbox app runs as.

```bash
gcloud iam service-accounts create proteus-sandbox \
  --display-name="Proteus sandbox application"
```

**No roles at all.** The migrated application is under test, not trusted. It needs no
Google Cloud permissions; if a migration introduces something that tries to reach
project resources, it should fail loudly rather than succeed quietly.

### 4.4 `proteus-worker` — the migration job

May reuse `proteus-api`. Split it if you want the long-running job to hold a different
risk profile from the request-serving API; the roles are identical.

---

## 5. Secrets

Two lifecycles, and conflating them is the main hazard.

### Deployment secrets — created once at provisioning

```bash
printf '%s' "$MONGODB_URI"  | gcloud secrets create proteus-mongodb-uri  --data-file=-
printf '%s' "$GEMINI_KEY"   | gcloud secrets create proteus-gemini-key   --data-file=-
```

Referenced by the Cloud Run deployment (§6), never baked into an image.

### Per-project secrets — created and destroyed with the project

Since **UX v1.2** the GitHub PAT is collected on the create-project screen, one per
project, and written to:

```text
projects/{PROJECT_ID}/secrets/proteus-{projectId}-github-pat/versions/{n}
```

Required scopes, as the screen states them: `contents: read & write`,
`pull_requests: write`, `metadata: read`.

The rules, which the API enforces and `redactTokens()` backstops:

- **Written once**, during `POST /projects`. Accepted in the request body, forwarded,
  dropped. Never assigned to a MongoDB document.
- **Read only** by the GitHub adapter, by secret name, at the moment of a call.
- **Never returned.** `GET /projects/{id}` gives `displayPrefix` and `status` — enough
  to recognise the token, nowhere near enough to use it.
- **Never logged.** Events, agent actions and reports are redacted before write.
- **Version pinned, not `latest`.** A migration that starts under one token and finishes
  under another cannot be audited: the evidence package could not say which credential
  wrote the branch. Rotation adds a version; in-flight runs keep theirs.
- **Destroyed with the project.** An orphaned secret is a live credential nobody is
  watching.

There is deliberately **no deployment-wide `GITHUB_TOKEN`**. One would defeat the
per-project model: a single leak would reach every migration, and a push could not be
attributed to the project that made it.

A rotation sweep reads `repository.credential.rotationDueAt` (90 days from storage) and
emits `CREDENTIAL_ROTATION_DUE`.

---

## 6. Deploying

### Backend API

```bash
gcloud run deploy proteus-api \
  --source=. \
  --region="$REGION" \
  --service-account="$API_SA" \
  --min-instances=1 --no-cpu-throttling \
  --set-env-vars="GCP_PROJECT_ID=${PROJECT_ID},GCP_REGION=${REGION},GCS_BUCKET=proteus-${PROJECT_ID},ARTIFACT_REGISTRY_REPO=proteus-sandbox,CLOUD_BUILD_SERVICE_ACCOUNT=${BUILD_SA},GEMINI_MODEL=gemini-3.5-flash,FIREBASE_PROJECT_ID=${PROJECT_ID}" \
  --set-secrets="MONGODB_URI=proteus-mongodb-uri:latest,GEMINI_API_KEY=proteus-gemini-key:latest"
```

`--min-instances=1 --no-cpu-throttling` is not a performance setting. Without it the SSE
change-stream tail is suspended between requests and live screens stop updating.

`GEMINI_MODEL` must be **3.5 or newer** — Tech Stack §3, enforced at startup. Confirm the
exact id against the current model list before first deploy.

### Migration worker

```bash
gcloud run jobs create proteus-worker \
  --source=. --region="$REGION" --service-account="$API_SA" \
  --task-timeout=3600s --max-retries=0 \
  --set-secrets="MONGODB_URI=proteus-mongodb-uri:latest,GEMINI_API_KEY=proteus-gemini-key:latest"
```

`--max-retries=0` is deliberate. Retry is the orchestrator's job, governed by
`MAX_MEANINGFUL_AUTONOMOUS_ATTEMPTS` and the lease; a platform-level retry would start a
second worker against a run that already holds a lease.

### Frontend

```bash
cd src/frontend && npm run build
firebase deploy --only hosting
```

Only `VITE_*` values reach the bundle, and they are public by design.

---

## 7. Local development

```bash
gcloud auth application-default login     # do NOT set GOOGLE_APPLICATION_CREDENTIALS
cp src/backend/.env.example src/backend/.env
cp src/frontend/.env.example src/frontend/.env
```

Config validates per feature, so you can work without the full estate:

| To run | Needs |
|---|---|
| rules engine, tests | nothing |
| API, database, SSE | `MONGODB_URI` (replica set) |
| agents | + `GEMINI_API_KEY` or Vertex AI |
| build, test, sandbox | + `GCP_PROJECT_ID`, `GCS_BUCKET`, Artifact Registry |
| sign-in | + Firebase project |

A service-account **key file** is not needed for any of this, and downloading one is the
most common way a long-lived credential ends up in a repository. Application-default
credentials cover local development; the attached service account covers Cloud Run.

---

## 8. Teardown

The product reclaims its own sandboxes — `POST /maintenance/sandbox-sweep` deletes every
service past its expiry **and the Artifact Registry image behind it**. Point Cloud
Scheduler at it hourly:

```bash
gcloud scheduler jobs create http proteus-sandbox-sweep \
  --schedule="0 * * * *" --location="$REGION" \
  --uri="https://$API_HOST/maintenance/sandbox-sweep" --http-method=POST \
  --oidc-service-account-email="proteus-api@$PROJECT.iam.gserviceaccount.com"

gcloud scheduler jobs create http proteus-rotation-sweep \
  --schedule="0 9 * * 1" --location="$REGION" \
  --uri="https://$API_HOST/maintenance/rotation-sweep" --http-method=POST \
  --oidc-service-account-email="proteus-api@$PROJECT.iam.gserviceaccount.com"
```

Deleting the image is the half that matters. Cloud Run scales to zero, so a stopped
service was already free; the Artifact Registry storage is the part that accrues, and a
sweep that deleted only services would reclaim nothing.

A cleanup policy on the repository is the backstop for anything the sweep misses:

```bash
gcloud artifacts repositories set-cleanup-policies proteus-sandbox \
  --location="$REGION" --policy=- <<'JSON'
[{"name":"expire-old","action":{"type":"Delete"},
  "condition":{"olderThan":"2592000s","tagState":"ANY"}}]
JSON
```

The manual sweeps remain, for a project being decommissioned:

```bash
gcloud run services list --region="$REGION" --format='value(name)' \
  | grep '^proteus-sandbox-' | xargs -r -n1 gcloud run services delete --region="$REGION" --quiet

# Per-project secrets outlive their projects only by mistake.
gcloud secrets list --format='value(name)' | grep '^proteus-PQC-' \
  | xargs -r -n1 gcloud secrets delete --quiet
```

All of them exist because each leaves something live behind: a running service that is
not production but looks like it, an image nobody is paying attention to, and a
credential with nothing watching it.

---

## 9. Cost notes for a prototype

**The Proteus API is the only always-on cost.** `min-instances=1` is required for SSE, and
it is the one service billed while idle.

**Sandboxes are not.** Every sandbox runs with `min-instances=0` and `cpuIdle: true`, so
CPU and memory are billed only while a request is being served. Thirty idle sandboxes cost
nothing, and the free tier — 2M requests, 180,000 vCPU-seconds, 360,000 GiB-seconds per
billing account per month — is far beyond a demo. `min-instances` is deliberately not
configurable for sandboxes; it is the single setting that makes this true.

**Artifact Registry is the real cost, and it is small.** Images persist while services do
not. A Spring Boot image on a JRE base is roughly 300–400 MB, and layers shared inside one
repository are not paid for twice. Storage runs about $0.10 per GB per month above a 0.5 GB
free allowance, so thirty sandboxes is single-digit gigabytes — under a dollar a month.

So the caps in `SANDBOX_MAX_PER_USER` and `SANDBOX_MAX_TOTAL` are not spend limits. They
exist so a URL labelled *not production* does not stay live with nobody watching it, and so
unreviewed third-party code has a bounded blast radius (D-020).

**Cloud Build bills per build-minute.** The migration loop is the driver and the
four-attempt retry budget bounds it. A cold Maven dependency tree costs 33 seconds on the
reference fixture — measured — which is why the pipeline caches `.m2` to GCS keyed by a
hash of the build manifest. Without that cache a five-execution run pays it five times.

Atlas M0 and Secret Manager at this volume are free.

> These figures are the right order of magnitude as of writing and are not a quote.
> Confirm against the current pricing pages before running anything at scale.
