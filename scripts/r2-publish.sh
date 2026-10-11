#!/usr/bin/env bash
# Put a built release onto cdn.mafold.com/desktop/stable/ — the moment it goes
# live for the download page and every installed app's updater.
#
#   scripts/r2-publish.sh <dir with the release files> <X.Y.Z>
#
# Called by release.yml's `publish` (a plain tag) or `go-live` (a release the
# monorepo's train held as a draft). One copy of the order, because the order
# is the safety property:
#
#   1. the versioned files — immutable;
#   2. the fixed names the download page links — always this release;
#   3. the update feeds LAST: an app must never be told about a file that is
#      not there yet.
#
# Env: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY (R2, desktop/ only),
#      R2_ACCOUNT_ID, R2_BUCKET.
set -euo pipefail

dir="${1:?usage: r2-publish.sh <dir> <X.Y.Z>}"
V="${2:?version}"
[ -n "${AWS_ACCESS_KEY_ID:-}" ] || { echo "::error::R2 secrets are not set on this repo"; exit 1; }
EP="https://${R2_ACCOUNT_ID:?}.r2.cloudflarestorage.com"
DEST="s3://${R2_BUCKET:?}/desktop/stable"
put() { aws s3 cp --endpoint-url "$EP" --only-show-errors --cache-control "$3" "$1" "$DEST/$2"; }

cd "$dir"
for f in *.dmg *.zip *.blockmap *.exe; do put "$f" "$f" "public, max-age=31536000, immutable"; done
put "Mafold-$V-arm64.dmg" "Mafold-mac-arm64.dmg" "no-cache"
put "Mafold-$V-x64.dmg"   "Mafold-mac-x64.dmg"   "no-cache"
put "Mafold-Setup-$V.exe" "Mafold-Setup.exe"     "no-cache"
put latest-mac.yml latest-mac.yml "no-cache"
put latest.yml     latest.yml     "no-cache"
echo "cdn.mafold.com/desktop/stable/ now serves $V"
