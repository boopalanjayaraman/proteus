#!/usr/bin/env bash
# Creates the GCE instance Proteus runs on, and the firewall rules it needs.
#
#   deployment/gcp/provision-vm.sh
#
# WHY A VM AND NOT CLOUD RUN
#
# Proteus builds the repository under migration and then runs the migrated
# application. Both are `docker run`. A Cloud Run container cannot start another
# container — no daemon, no socket, no privileged mode — so the LOCAL executor
# and the LOCAL sandbox deployer cannot work there, and `assertRuntimeAvailable`
# refuses to boot rather than failing at the first migration.
#
# The GCP-native path exists (Cloud Build for the migration build, Cloud Run for
# the sandbox) and is not usable today: the migration pipeline clones
# `_REPO_URL` at `_COMMIT_SHA`, and the loop commits locally and pushes only at
# the end, so that commit is not on the remote yet. See PRD-16.
#
# A VM with Docker needs no such change, and is still entirely on GCP.
set -euo pipefail

PROJECT="${PROJECT:-project-proteus-506911}"
ZONE="${ZONE:-us-central1-a}"
NAME="${NAME:-proteus-api}"
# 4 vCPU / 16GB. A Spring Boot suite under Maven inside Docker, plus a sandbox
# container beside it, is the sizing constraint — not Proteus itself.
MACHINE="${MACHINE:-e2-standard-4}"
SA_NAME="proteus-api"
SA="${SA_NAME}@${PROJECT}.iam.gserviceaccount.com"

echo "project=$PROJECT zone=$ZONE name=$NAME machine=$MACHINE"

# --- service account -------------------------------------------------------
if ! gcloud iam service-accounts describe "$SA" --project="$PROJECT" >/dev/null 2>&1; then
  gcloud iam service-accounts create "$SA_NAME" \
    --project="$PROJECT" --display-name="Proteus API"
fi

# Least privilege that still lets the product work:
#   storage.objectAdmin  — logs, diffs, reports, uploaded context (one bucket)
#   secretmanager.admin  — creates a per-project PAT secret and destroys it on
#                          delete. Scoped to the project because the secrets it
#                          owns are created at runtime and cannot be pre-named.
#   aiplatform.user      — Vertex, for Gemini
for ROLE in roles/storage.objectAdmin roles/secretmanager.admin roles/aiplatform.user; do
  gcloud projects add-iam-policy-binding "$PROJECT" \
    --member="serviceAccount:${SA}" --role="$ROLE" --condition=None >/dev/null
done

# --- firewall --------------------------------------------------------------
# 443 for the API behind Caddy. 8080 is deliberately NOT opened: nothing should
# reach the backend except through TLS.
gcloud compute firewall-rules describe proteus-https --project="$PROJECT" >/dev/null 2>&1 || \
  gcloud compute firewall-rules create proteus-https \
    --project="$PROJECT" --allow=tcp:443,tcp:80 \
    --target-tags=proteus --description="Proteus API behind Caddy"

# Sandbox containers bind an ephemeral host port, chosen by the kernel — on
# Debian that is 32768-60999 (`net.ipv4.ip_local_port_range`). The range is
# matched to what will actually be picked rather than to a tidier number, which
# would leave most sandboxes unreachable and look like a deployment failure.
#
# These serve somebody else's migrated code. Bounded on purpose, and the
# description says so wherever the rule is read.
gcloud compute firewall-rules describe proteus-sandbox --project="$PROJECT" >/dev/null 2>&1 || \
  gcloud compute firewall-rules create proteus-sandbox \
    --project="$PROJECT" --allow=tcp:32768-60999 \
    --target-tags=proteus --description="Proteus sandbox applications — NOT production"

# --- instance --------------------------------------------------------------
if gcloud compute instances describe "$NAME" --zone="$ZONE" --project="$PROJECT" >/dev/null 2>&1; then
  echo "instance $NAME already exists"
else
  gcloud compute instances create "$NAME" \
    --project="$PROJECT" --zone="$ZONE" --machine-type="$MACHINE" \
    --image-family=debian-12 --image-project=debian-cloud \
    --boot-disk-size=100GB --boot-disk-type=pd-balanced \
    --tags=proteus \
    --service-account="$SA" \
    --scopes=https://www.googleapis.com/auth/cloud-platform \
    --metadata-from-file=startup-script="$(dirname "$0")/startup.sh"
fi

IP=$(gcloud compute instances describe "$NAME" --zone="$ZONE" --project="$PROJECT" \
  --format="value(networkInterfaces[0].accessConfigs[0].natIP)")

echo
echo "instance ready.  external IP: $IP"
echo "API host:        https://${IP//./-}.nip.io"
echo "sandbox host:    $IP  (ports 32768-60999)"
echo
echo "Next: deployment/gcp/deploy-backend.sh"
