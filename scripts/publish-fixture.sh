#!/usr/bin/env bash
# Publish fixtures/payments-api as a standalone GitHub repository.
#
#   scripts/publish-fixture.sh northwind-pay/payments-api
#   scripts/publish-fixture.sh boopalanjayaraman/settlement-api settlement-api
#
# The second argument names a directory under fixtures/ and defaults to
# payments-api. Only that directory is published — fixtures/README.md, which
# says which test is rigged, must never travel with it.
#
# Builds a clean history in a temp directory and force-pushes. The fixture is
# authored in this repo and published, not developed in place, so its history
# stays free of Proteus's.
set -euo pipefail

TARGET="${1:?usage: publish-fixture.sh <owner>/<repo> [fixture-dir]}"
FIXTURE="${2:-payments-api}"
SRC="$(cd "$(dirname "$0")/.." && pwd)/fixtures/${FIXTURE}"
[ -d "$SRC" ] || { echo "not found: $SRC" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cp -R "$SRC/." "$WORK/"
cat > "$WORK/.gitignore" <<'GI'
target/
*.class
.idea/
.vscode/
.DS_Store
GI

cd "$WORK"
git init -q -b main
git add -A
git -c user.email=fixture@northwind-pay.example \
    -c user.name="Northwind Pay" \
    commit -qm "payments-api: settlement service"

echo "Publishing to https://github.com/${TARGET}"
git remote add origin "https://github.com/${TARGET}.git"
git push -q --force origin main

echo "Published. Base commit: $(git rev-parse --short HEAD)"
echo
echo "Next:"
echo "  1. Create a fine-grained PAT scoped to ${TARGET}"
echo "     contents: read & write · pull_requests: write · metadata: read"
echo "  2. Enter it on the Proteus create-project screen"
