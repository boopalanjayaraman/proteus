# Deploying Proteus to Google Cloud

Two Cloud Run services — the backend API and the frontend — from a standing start to a
working URL. Everything here has been checked against the code in this repository rather
than written from the shape the architecture doc describes.

**Companion:** [`docs/pqc_migration_deployment_v1.md`](../docs/pqc_migration_deployment_v1.md)
is the infrastructure spec: what each identity is for, why each role is granted, and how
the credential model works. This file is the runbook. Where they disagree, §9 says which
is right and why.

---

## 1. What you end up with

```text
proteus-frontend  (Cloud Run)  nginx + static bundle, public
        │  REST + SSE, cross-origin
        ▼
proteus-api       (Cloud Run)  min-instances=1, CPU always on
        │
        ├── MongoDB Atlas      product state, replica set REQUIRED
        ├── Cloud Storage      logs, diffs, reports
        ├── Secret Manager     deployment + per-project secrets
        ├── Cloud Build        builds and tests the repo UNDER MIGRATION
        │      └── Artifact Registry ──► Cloud Run  the sandbox application
        └── GitHub             per-project PAT, fetched per call
```

Two properties of this shape are load-bearing.

**The API cannot be request-scoped.** A migration outlives the request that approved it.
`--min-instances=1 --no-cpu-throttling` is not a performance setting: without it the SSE
change-stream tail is suspended between requests and every live screen silently stops
updating.

**A Cloud Run container cannot start another container.** No Docker daemon, no socket, no
privileged mode. So a hosted Proteus must set `BUILD_EXECUTOR=CLOUD_BUILD` and
`SANDBOX_PLACEMENT=CLOUD_RUN`; the defaults are `LOCAL`, which is a development
convenience and will fail at the first `mvn` invocation. The server checks this at startup
and logs an error rather than waiting to fail forty minutes into a migration.

---

## 2. Before you start

- **`gcloud`**, authenticated: `gcloud auth login`
- **A GCP project** with billing enabled
- **A MongoDB Atlas cluster** — M0 free tier is enough, but it **must be a replica set**.
  SSE tails a change stream and a standalone `mongod` cannot open one. Atlas is a replica
  set by default.
- **A Gemini API key** from [aistudio.google.com/apikey](https://aistudio.google.com/apikey),
  or Vertex AI with `GOOGLE_GENAI_USE_VERTEXAI=true`
- **A Firebase project** with Google sign-in enabled, in the same GCP project

You do **not** need Docker locally — both images build in Cloud Build.

You do **not** need a service-account key file, and downloading one is the single worst
thing you can do to this deployment's security posture. Cloud Run supplies credentials
through the attached service account.

```bash
export PROJECT_ID=your-project-id
export REGION=us-central1
gcloud config set project "$PROJECT_ID"

# Firebase Auth may live in a DIFFERENT project from everything else — that is
# supported and common. The backend verifies tokens against this one and does
# everything else in $PROJECT_ID. Leave it unset if they are the same project.
export FIREBASE_PROJECT_ID=your-firebase-project-id
```

---

## 3. One-time project setup

Skip any step you have already done — all of these are idempotent except the bucket and
repository creations, which fail harmlessly if they exist.

### 3.1 Enable the APIs

```bash
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  storage.googleapis.com \
  iam.googleapis.com \
  iamcredentials.googleapis.com \
  firebase.googleapis.com \
  identitytoolkit.googleapis.com
```

### 3.2 Storage and registries

```bash
# Blobs: logs, diffs, reports, uploaded context.
gcloud storage buckets create "gs://proteus-${PROJECT_ID}" \
  --location="$REGION" --uniform-bucket-level-access

# Where the two Proteus images live.
gcloud artifacts repositories create proteus \
  --repository-format=docker --location="$REGION" \
  --description="Proteus backend and frontend images"

# Where SANDBOX images live — separate on purpose. The sandbox repository holds
# images built from somebody else's code; keeping it apart from the images that
# run Proteus itself means a retention policy can be applied to one and not the
# other.
gcloud artifacts repositories create proteus-sandbox \
  --repository-format=docker --location="$REGION"
```

### 3.3 Service accounts

Three identities, each with only what its job needs.

```bash
gcloud iam service-accounts create proteus-api     --display-name="Proteus backend API"
gcloud iam service-accounts create proteus-build   --display-name="Proteus Cloud Build"
gcloud iam service-accounts create proteus-sandbox --display-name="Proteus sandbox app"

export API_SA="proteus-api@${PROJECT_ID}.iam.gserviceaccount.com"
export BUILD_SA="proteus-build@${PROJECT_ID}.iam.gserviceaccount.com"
export SANDBOX_SA="proteus-sandbox@${PROJECT_ID}.iam.gserviceaccount.com"
```

**`proteus-api`** — reads secrets, writes blobs, triggers builds, deploys sandboxes:

```bash
for R in secretmanager.secretAccessor cloudbuild.builds.editor run.developer; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${API_SA}" --role="roles/${R}" --condition=None
done

gcloud storage buckets add-iam-policy-binding "gs://proteus-${PROJECT_ID}" \
  --member="serviceAccount:${API_SA}" --role=roles/storage.objectAdmin

# Deploying a service that runs AS the sandbox identity requires this, scoped to
# that one account rather than granted project-wide.
gcloud iam service-accounts add-iam-policy-binding "$SANDBOX_SA" \
  --member="serviceAccount:${API_SA}" --role=roles/iam.serviceAccountUser

# Create a project's PAT secret at creation, destroy it at deletion — but only
# for secrets this product owns. Project-wide admin would let the API read every
# secret in the project.
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${API_SA}" \
  --role=roles/secretmanager.admin \
  --condition='expression=resource.name.extract("/secrets/{n}").startsWith("proteus-"),title=proteus-secrets-only,description=Only secrets this product creates'
```

**`proteus-build`** — compiles and runs the repository under migration. Treat it as the
least trusted principal in the project:

```bash
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${BUILD_SA}" --role=roles/logging.logWriter --condition=None

gcloud storage buckets add-iam-policy-binding "gs://proteus-${PROJECT_ID}" \
  --member="serviceAccount:${BUILD_SA}" --role=roles/storage.objectAdmin

gcloud artifacts repositories add-iam-policy-binding proteus-sandbox \
  --location="$REGION" \
  --member="serviceAccount:${BUILD_SA}" --role=roles/artifactregistry.writer
```

Deliberately **not** granted to the build: `secretmanager.secretAccessor`, so it can never
see a GitHub PAT; and `run.developer`, so a compromised build cannot deploy itself. The
build produces an image and the API deploys it.

**`proteus-sandbox`** — **no roles at all.** The migrated application is under test, not
trusted. If a migration introduces something that reaches for project resources, it should
fail loudly rather than succeed quietly.

### 3.4 Deployment secrets

```bash
printf '%s' 'mongodb+srv://...' | gcloud secrets create proteus-mongodb-uri --data-file=-
printf '%s' 'AIza...'           | gcloud secrets create proteus-gemini-key  --data-file=-
```

There is deliberately **no deployment-wide GitHub token**. The PAT is per project,
collected on the create-project screen and written to
`proteus-{projectId}-github-pat`. A shared one would mean a single leak reaches every
migration, and no push could be attributed to the project that made it.

---

## 4. Deploy the backend

### 4.1 Build the image

```bash
export TAG=$(git rev-parse --short HEAD)

gcloud builds submit \
  --config=deployment/cloudbuild/backend.yaml \
  --substitutions="_REGION=${REGION},_TAG=${TAG}"
```

### 4.2 Deploy the service

```bash
gcloud run deploy proteus-api \
  --image="${REGION}-docker.pkg.dev/${PROJECT_ID}/proteus/backend:${TAG}" \
  --region="$REGION" \
  --service-account="$API_SA" \
  --allow-unauthenticated \
  --min-instances=1 --no-cpu-throttling \
  --timeout=3600 \
  --memory=2Gi --cpu=2 \
  --set-env-vars="^##^\
NODE_ENV=production##\
GCP_PROJECT_ID=${PROJECT_ID}##\
GCP_REGION=${REGION}##\
GCS_BUCKET=proteus-${PROJECT_ID}##\
ARTIFACT_REGISTRY_REPO=proteus-sandbox##\
CLOUD_BUILD_SERVICE_ACCOUNT=${BUILD_SA}##\
FIREBASE_PROJECT_ID=${FIREBASE_PROJECT_ID:-$PROJECT_ID}##\
GEMINI_MODEL=gemini-3.5-flash##\
BUILD_EXECUTOR=CLOUD_BUILD##\
SANDBOX_PLACEMENT=CLOUD_RUN##\
ALLOWED_ORIGINS=http://localhost:5173" \
  --set-secrets="MONGODB_URI=proteus-mongodb-uri:latest,GEMINI_API_KEY=proteus-gemini-key:latest"
```

Four of these are not optional and each fails in a different way:

| Setting | If you get it wrong |
|---|---|
| `--min-instances=1 --no-cpu-throttling` | The SSE tail suspends between requests. Live screens stop updating with no error anywhere. |
| `--timeout=3600` | Cloud Run's 5-minute default kills the SSE connection mid-migration. |
| `BUILD_EXECUTOR=CLOUD_BUILD`, `SANDBOX_PLACEMENT=CLOUD_RUN` | The default is `LOCAL`, and a Cloud Run container has no Docker daemon. Startup logs an error; the first migration fails at `mvn`. |
| `GEMINI_MODEL` 3.5 or newer | Refused at startup — Tech Stack §3, enforced in `config/env.ts`. |

`--allow-unauthenticated` is correct here: the service authenticates every request itself
with a Firebase ID token. Cloud Run IAM would additionally require a Google-issued
identity token that a browser does not have.

`^##^` sets `##` as the delimiter for `--set-env-vars`, because a MongoDB URI and a
comma-separated origin list both contain commas.

### 4.3 Capture the URL

```bash
export API_URL=$(gcloud run services describe proteus-api \
  --region="$REGION" --format='value(status.url)')
echo "$API_URL"

curl -s "${API_URL}/healthz" && echo
```

`/healthz` and `/readyz` are the two unauthenticated routes — a probe has no credentials.
`/readyz` is the more useful one: it reports which config groups resolved and whether
change streams are available, and answers 503 rather than 200 when they are not.

---

## 5. Deploy the frontend

The frontend needs the backend's URL at **build** time, because Vite inlines every
`VITE_*` value into the bundle. That is why the backend goes first.

### 5.1 Collect the Firebase web config

Firebase console → Project settings → Your apps → SDK setup and configuration.

```bash
export FB_API_KEY='AIza...'
export FB_AUTH_DOMAIN="${FIREBASE_PROJECT_ID:-$PROJECT_ID}.firebaseapp.com"
export FB_APP_ID='1:...:web:...'
```

All four are **public**. Vite ships them in the bundle, and that is fine — Firebase web
config identifies a project, it does not protect it. Access control lives in this
backend's per-project ownership checks. Never put the Gemini key, the database URI or a
GitHub token behind a `VITE_` prefix.

### 5.2 Build and deploy

```bash
gcloud builds submit \
  --config=deployment/cloudbuild/frontend.yaml \
  --substitutions="^##^_REGION=${REGION}##_TAG=${TAG}##_API_URL=${API_URL}##\
_FB_API_KEY=${FB_API_KEY}##_FB_AUTH_DOMAIN=${FB_AUTH_DOMAIN}##\
_FB_PROJECT_ID=${FIREBASE_PROJECT_ID:-$PROJECT_ID}##_FB_APP_ID=${FB_APP_ID}"

gcloud run deploy proteus-frontend \
  --image="${REGION}-docker.pkg.dev/${PROJECT_ID}/proteus/frontend:${TAG}" \
  --region="$REGION" \
  --allow-unauthenticated \
  --min-instances=0 \
  --memory=256Mi

export APP_URL=$(gcloud run services describe proteus-frontend \
  --region="$REGION" --format='value(status.url)')
echo "$APP_URL"
```

`--min-instances=0` is right here and wrong for the API: static files have no change
stream to keep alive, and a cold start on nginx is milliseconds.

---

## 6. Close the loop

Two things still point at the wrong place, and **the app will not work until both are
fixed**. This is the step people skip.

### 6.1 Tell the backend which origin may call it

```bash
gcloud run services update proteus-api \
  --region="$REGION" \
  --update-env-vars="ALLOWED_ORIGINS=${APP_URL}"
```

The frontend is a different origin from the API in every deployment shape this product
has, so without this the browser refuses every call before it leaves the page — including
the SSE stream. The allowlist is exact-match and deliberately not `*`: requests carry a
Firebase ID token, and a wildcard on a credentialed endpoint is how a token becomes
readable by an unrelated page.

Add `http://localhost:5173` alongside it if you also develop locally against this backend:

```bash
--update-env-vars="^##^ALLOWED_ORIGINS=${APP_URL},http://localhost:5173"
```

### 6.2 Authorize the frontend domain for sign-in

Firebase console → Authentication → Settings → **Authorized domains** → Add domain, and
enter the host part of `$APP_URL` (for example
`proteus-frontend-abc123-uc.a.run.app`, without `https://`).

`signInWithPopup` refuses to run on an unauthorized domain. The symptom is
`auth/unauthorized-domain` in the browser console and a popup that closes immediately.

### 6.3 Make yourself the platform admin

```bash
gcloud run services update proteus-api \
  --region="$REGION" \
  --update-env-vars="PLATFORM_ADMIN_EMAILS=you@example.com"
```

Applied at your next sign-in. It is the only way the role is granted — no endpoint grants
it — and removing an address revokes the role on that user's next request.

---

## 7. Verify

```bash
# 1. The API is up, and ready — /readyz 503s if change streams are unavailable.
curl -s "${API_URL}/healthz"
curl -s "${API_URL}/readyz"

# 2. CORS actually allows the frontend. An empty result here is the failure in §6.1.
curl -s -o /dev/null -D - -X OPTIONS "${API_URL}/projects" \
  -H "Origin: ${APP_URL}" \
  -H 'Access-Control-Request-Method: GET' \
  -H 'Access-Control-Request-Headers: authorization,x-proteus-screen' \
  | grep -i 'access-control-allow-origin'

# 3. The startup banner says what is configured, and complains about what is not.
gcloud run services logs read proteus-api --region="$REGION" --limit=40
```

The banner is the fastest diagnosis you have. It prints which config groups loaded, the
redacted Mongo URI, the index count, whether change streams are available, the build and
sandbox placement, and how many platform admins are configured.

Then open `$APP_URL`, sign in, and create a project against a public repository. If
discovery streams into the graph, everything in this document worked.

---

## 8. Redeploying

```bash
export TAG=$(git rev-parse --short HEAD)

# Backend only.
gcloud builds submit --config=deployment/cloudbuild/backend.yaml \
  --substitutions="_REGION=${REGION},_TAG=${TAG}"
gcloud run deploy proteus-api \
  --image="${REGION}-docker.pkg.dev/${PROJECT_ID}/proteus/backend:${TAG}" \
  --region="$REGION"
```

Re-deploying by image keeps every environment variable and secret binding already on the
service. You only need the full `--set-env-vars` form when a setting changes.

The frontend must be **rebuilt**, not just redeployed, whenever `API_URL` or any Firebase
value changes — they are baked into the bundle.

**Rolling back** is a traffic change, not a rebuild:

```bash
gcloud run revisions list --service=proteus-api --region="$REGION"
gcloud run services update-traffic proteus-api \
  --region="$REGION" --to-revisions=proteus-api-00007-abc=100
```

---

## 9. Where this differs from the architecture doc

`docs/pqc_migration_deployment_v1.md` was written before the images existed. Four things
in it do not work as written, and this file is the one to follow.

| It says | Reality |
|---|---|
| `gcloud run deploy --source=.` | There is no `Dockerfile` at the repository root, and buildpacks cannot build an npm-workspace monorepo. Hence the two Cloud Build configs in §4 and §5. |
| Frontend on Firebase Hosting | Still a valid option (§10), but `deployment/frontend/Dockerfile` exists and Cloud Run keeps both services in one place with one deployment mechanism. |
| No mention of CORS | The backend had none until this runbook was written. Without §6.1 nothing in a browser can reach the API — in production *or* locally. |
| No `BUILD_EXECUTOR` / `SANDBOX_PLACEMENT` | Added by PRD-16. Both default to `LOCAL`, which cannot work on Cloud Run. |

A separate **migration worker** as a Cloud Run Job is described in the architecture doc
and is **not deployed here**. It does not exist yet: discovery, assessment and migration
currently run unawaited inside the API process, which is why `--min-instances=1` and
`--timeout=3600` matter as much as they do. Recorded as TD-010.

---

## 10. Alternative: frontend on Firebase Hosting

Cheaper and it puts the app on a domain Firebase Auth already trusts, so §6.2 becomes
unnecessary. §6.1 still applies.

```bash
cd src/frontend
cat > .env.production <<EOF
VITE_API_BASE_URL=${API_URL}
VITE_FIREBASE_API_KEY=${FB_API_KEY}
VITE_FIREBASE_AUTH_DOMAIN=${FB_AUTH_DOMAIN}
VITE_FIREBASE_PROJECT_ID=${FIREBASE_PROJECT_ID:-$PROJECT_ID}
VITE_FIREBASE_APP_ID=${FB_APP_ID}
EOF
npm run build
npx firebase-tools deploy --only hosting --project "$PROJECT_ID"
```

`firebase.json` needs a rewrite so a deep link is the app's own route rather than a 404:

```json
{
  "hosting": {
    "public": "src/frontend/dist",
    "rewrites": [{ "source": "**", "destination": "/index.html" }]
  }
}
```

---

## 11. What this costs

At rest, with nobody using it:

| | |
|---|---|
| `proteus-api` at `min-instances=1`, CPU always on | roughly **$25–40/month**. This is the whole bill, and it is the price of SSE working. |
| `proteus-frontend` at `min-instances=0` | effectively **$0** |
| Artifact Registry, ~30 sandbox images | a few dollars |
| Cloud Storage, Secret Manager | cents |
| Cloud Build | 120 free minutes/day, then ~$0.003/minute |
| MongoDB Atlas M0 | free |
| Gemini | per token |

To park a demo without deleting it, drop the API to zero and accept that live screens stop
updating until you put it back:

```bash
gcloud run services update proteus-api --region="$REGION" --min-instances=0
```

Sandbox containers are separately capped — 3 per user and 30 platform-wide by default,
with a 7-day inactivity expiry. Those are the `SANDBOX_*` settings in
`src/backend/.env.example` and they bound what is **retained**, never what is deployed:
past a cap a migration still deploys, verifies and releases, so a verdict is never
degraded by how busy the platform is (D-020).

---

## 12. When it does not work

| Symptom | Cause |
|---|---|
| Every API call fails, console says CORS | §6.1 — `ALLOWED_ORIGINS` does not contain the frontend URL exactly, scheme included, no trailing slash |
| Sign-in popup opens and closes; `auth/unauthorized-domain` | §6.2 — the frontend host is not in Firebase authorized domains |
| Sign-in works, every request 401 | `FIREBASE_PROJECT_ID` on the API does not match the project the token came from |
| Screens load but never update | Change streams unavailable (Atlas is not a replica set), or `--min-instances`/`--no-cpu-throttling` missing. The startup banner says which |
| Migration fails at the first build | `BUILD_EXECUTOR` is still `LOCAL`. The startup log says so explicitly |
| Sandbox never gets a URL | `SANDBOX_PLACEMENT` is still `LOCAL`, or the API lacks `iam.serviceAccountUser` on `proteus-sandbox` |
| Startup exits with a config error | Read it — `ConfigError` names the missing variables and the feature that wanted them |
| Cloud Build fails on `docker build` | The build service account needs `roles/logging.logWriter`; Cloud Build fails without it and the error does not say so |
