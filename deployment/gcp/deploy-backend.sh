#!/usr/bin/env bash
# Ships the backend to the VM and (re)starts it behind Caddy.
#
#   deployment/gcp/deploy-backend.sh
#
# Idempotent: run it again to deploy a new revision.
set -euo pipefail

PROJECT="${PROJECT:-project-proteus-506911}"
ZONE="${ZONE:-us-central1-a}"
NAME="${NAME:-proteus-api}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

IP=$(gcloud compute instances describe "$NAME" --zone="$ZONE" --project="$PROJECT" \
  --format="value(networkInterfaces[0].accessConfigs[0].natIP)")
HOST="${IP//./-}.nip.io"
SSH="gcloud compute ssh $NAME --zone=$ZONE --project=$PROJECT --command"

echo "deploying to $NAME ($IP) — API will be https://$HOST"

# --- wait for first boot to finish -----------------------------------------
echo "waiting for the startup script…"
for _ in $(seq 1 60); do
  if $SSH "test -f /var/log/proteus-startup-complete" >/dev/null 2>&1; then break; fi
  sleep 10
done
$SSH "test -f /var/log/proteus-startup-complete" \
  || { echo "startup script has not finished; check the serial console" >&2; exit 1; }

# --- refuse to interrupt a live migration -----------------------------------
#
# Migration jobs run unawaited inside the API process (TD-010), so `systemctl
# restart` kills whatever is mid-build. Nothing resumes it: the lease expires,
# `findOrphans` can see it, and no worker acts on it. The project sits at
# MIGRATING for ever.
#
# A deploy at 17:40 UTC killed PQC-0025 in RUNNING_TESTS exactly this way.
#
# A build container is the reliable signal that work is in flight — the loop
# spends nearly all its time inside `docker run maven`. Not a proof of absence:
# a run between builds shows nothing here. It catches the case that actually
# happened, and DEPLOY_FORCE=1 is there for when you know better.
if [ "${DEPLOY_FORCE:-0}" != "1" ]; then
  BUILDING=$($SSH "sudo docker ps --filter ancestor=maven:3.9-eclipse-temurin-17 --format '{{.ID}}' | wc -l" 2>/dev/null | tr -d '\r\n ' || echo 0)
  if [ "${BUILDING:-0}" != "0" ]; then
    echo "REFUSING: a migration build is running on $NAME." >&2
    echo "Restarting now would kill it mid-run and it will not resume." >&2
    echo "Wait for it to finish, or re-run with DEPLOY_FORCE=1 to override." >&2
    exit 1
  fi
fi

# --- source ----------------------------------------------------------------
# A git archive of the working tree, so what deploys is what is on disk here —
# including uncommitted work. Faster and more predictable than cloning and
# hoping the branch is pushed.
echo "packing the working tree…"
TAR=$(mktemp -t proteus-XXXX.tar.gz)
trap 'rm -f "$TAR"' EXIT
tar --exclude-vcs --exclude=node_modules --exclude='**/dist' --exclude='**/target' \
    --exclude='.env' -czf "$TAR" -C "$ROOT" .

gcloud compute scp "$TAR" "$NAME:/tmp/proteus.tar.gz" --zone="$ZONE" --project="$PROJECT"
$SSH "sudo rm -rf /opt/proteus/app && sudo mkdir -p /opt/proteus/app \
      && sudo tar -xzf /tmp/proteus.tar.gz -C /opt/proteus/app \
      && sudo chown -R proteus:proteus /opt/proteus"

# --- configuration ---------------------------------------------------------
# The .env never enters the repository or this script's output. It is copied
# straight across, then three values are rewritten for the deployed environment.
echo "copying configuration…"
gcloud compute scp "$ROOT/src/backend/.env" "$NAME:/tmp/.env" --zone="$ZONE" --project="$PROJECT"
$SSH "sudo install -o proteus -g proteus -m 600 /tmp/.env /opt/proteus/app/src/backend/.env \
      && rm -f /tmp/.env"

# ALLOWED_ORIGINS  the Firebase Hosting origin, or CORS refuses every call
# SANDBOX_PUBLIC_HOST  so a sandbox link is one a person can open
# LOG_FORMAT=GCP   so Cloud Logging indexes severity and message
# GOOGLE_APPLICATION_CREDENTIALS  removed: the VM's own service account is used,
#                  and the local path points at a file that does not exist here
$SSH "sudo -u proteus bash -c '
  cd /opt/proteus/app/src/backend
  sed -i \"/^GOOGLE_APPLICATION_CREDENTIALS=/d;/^SANDBOX_PUBLIC_HOST=/d;/^LOG_FORMAT=/d\" .env
  sed -i \"s#^ALLOWED_ORIGINS=.*#ALLOWED_ORIGINS=${ALLOWED_ORIGINS:-https://proteus-web-c4d4d.web.app}#\" .env
  printf \"\nSANDBOX_PUBLIC_HOST=$IP\nLOG_FORMAT=GCP\nNODE_ENV=production\n\" >> .env
'"

# --- build -----------------------------------------------------------------
echo "installing and building…"
$SSH "sudo -u proteus bash -lc 'cd /opt/proteus/app && npm ci --no-audit --fund=false && npm run build -w @proteus/backend'"

# --- service ---------------------------------------------------------------
$SSH "sudo tee /etc/systemd/system/proteus.service >/dev/null <<'UNIT'
[Unit]
Description=Proteus API
After=network-online.target docker.service
Requires=docker.service

[Service]
Type=simple
User=proteus
WorkingDirectory=/opt/proteus/app/src/backend
ExecStart=/usr/bin/node dist/server.js
Restart=always
RestartSec=5
# Journald forwards to Cloud Logging via the ops agent; the JSON the app emits
# is already in the shape Cloud Logging indexes.
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT"

# One origin for the UI and the API.
#
#   /api/*  -> the backend, prefix stripped
#   /*      -> the built SPA, with try_files so client-side routes reload
#
# Same-origin removes CORS entirely, and removes the mixed-content trap: a page
# served over HTTPS calling an http:// backend is blocked silently, in the
# console, which is a bad thing to discover during a demo.
#
# `flush_interval -1` is not optional. Without it Caddy buffers the response and
# the SSE feed arrives in one lump when the migration finishes, which looks
# exactly like the live updates being broken.
$SSH "sudo tee /etc/caddy/Caddyfile >/dev/null <<CADDY
${HOST} {
    handle_path /api/* {
        reverse_proxy 127.0.0.1:8080 {
            flush_interval -1
        }
    }
    handle {
        root * /opt/proteus/web
        try_files {path} /index.html
        file_server
    }
}
CADDY"

$SSH "sudo install -d -o proteus -g proteus /opt/proteus/web" 

$SSH "sudo systemctl daemon-reload && sudo systemctl enable --now proteus \
      && sudo systemctl restart proteus && sudo systemctl restart caddy"

echo
echo "waiting for health…"
for _ in $(seq 1 30); do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "https://${HOST}/api/healthz" || true)
  [ "$CODE" = "200" ] && { echo "API healthy at https://${HOST}/api"; exit 0; }
  sleep 5
done
echo "API did not become healthy. Check: gcloud compute ssh $NAME --zone=$ZONE --command='sudo journalctl -u proteus -n 100'" >&2
exit 1
