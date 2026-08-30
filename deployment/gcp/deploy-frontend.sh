#!/usr/bin/env bash
# Builds the frontend against the deployed API and serves it from the same host.
#
#   deployment/gcp/deploy-frontend.sh
#
# Not Firebase Hosting. Same origin as the API, which means no CORS
# configuration to keep in sync and no mixed-content risk. The trade is that the
# Firebase Auth authorised-domains list needs the nip.io host added once —
# Console -> Authentication -> Settings -> Authorized domains.
set -euo pipefail

PROJECT="${PROJECT:-project-proteus-506911}"
ZONE="${ZONE:-us-central1-a}"
NAME="${NAME:-proteus-api}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

IP=$(gcloud compute instances describe "$NAME" --zone="$ZONE" --project="$PROJECT" \
  --format="value(networkInterfaces[0].accessConfigs[0].natIP)")
HOST="${IP//./-}.nip.io"

echo "building the frontend against https://${HOST}/api"

# VITE_* values are compiled into the bundle and are public by design. The
# Firebase web API key belongs here; it identifies the project and is not a
# secret. Nothing unprefixed is readable from the browser, which is why the
# Gemini key and the Mongo URI live only in the backend .env.
( cd "$ROOT/src/frontend" \
  && VITE_API_BASE_URL="https://${HOST}/api" npm run build )

TAR=$(mktemp -t proteus-web-XXXX.tar.gz)
trap 'rm -f "$TAR"' EXIT
tar -czf "$TAR" -C "$ROOT/src/frontend/dist" .

gcloud compute scp "$TAR" "$NAME:/tmp/web.tar.gz" --zone="$ZONE" --project="$PROJECT"
gcloud compute ssh "$NAME" --zone="$ZONE" --project="$PROJECT" --command \
  "sudo rm -rf /opt/proteus/web && sudo mkdir -p /opt/proteus/web \
   && sudo tar -xzf /tmp/web.tar.gz -C /opt/proteus/web \
   && sudo chown -R proteus:proteus /opt/proteus/web \
   && sudo systemctl reload caddy && rm -f /tmp/web.tar.gz"

echo
echo "Proteus is at https://${HOST}"
echo
echo "One manual step, once:"
echo "  Firebase Console -> Authentication -> Settings -> Authorized domains"
echo "  add:  ${HOST}"
