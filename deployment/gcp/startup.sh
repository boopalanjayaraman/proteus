#!/usr/bin/env bash
# Runs once, on first boot, as root. Installs what Proteus needs and nothing else.
set -euxo pipefail

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl gnupg git debian-keyring debian-archive-keyring apt-transport-https

# --- Docker ----------------------------------------------------------------
# The reason this VM exists. Migration builds run in maven:3.9-eclipse-temurin-17
# and sandboxes run the migrated image; both are `docker run` from the backend.
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io

# --- Node 22 ---------------------------------------------------------------
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

# --- Caddy -----------------------------------------------------------------
# TLS is not optional: Firebase Hosting serves the frontend over HTTPS, and a
# page there calling http:// is blocked as mixed content — silently, in the
# browser console. Caddy gets a Let's Encrypt certificate for <ip>.nip.io, which
# resolves to this machine without anyone buying a domain.
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  > /etc/apt/sources.list.d/caddy-stable.list
apt-get update
apt-get install -y caddy

# --- the account the service runs as ---------------------------------------
id -u proteus >/dev/null 2>&1 || useradd -m -s /bin/bash proteus
usermod -aG docker proteus
install -d -o proteus -g proteus /opt/proteus

# Pre-pull the build toolchain so the first migration does not pay for it.
docker pull maven:3.9-eclipse-temurin-17 || true

# The Maven cache volume, owned by the account that will write to it.
#
# Builds run with `--user`, because a container writing as root leaves a
# root-owned target/ in the bind-mounted checkout that the service account then
# cannot delete. The same constraint applies to the cache: Docker creates a
# named volume owned by root, and a non-root container cannot write into it, so
# every build would re-download the world and log a warning about it.
PROTEUS_UID=$(id -u proteus)
PROTEUS_GID=$(id -g proteus)
docker volume create proteus-m2 >/dev/null
docker run --rm -v proteus-m2:/m2 alpine chown -R "$PROTEUS_UID:$PROTEUS_GID" /m2 || true

touch /var/log/proteus-startup-complete
