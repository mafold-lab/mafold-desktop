#!/usr/bin/env bash
# Put a built release onto cdn.mafold.com/desktop/stable/ — the moment it goes
# live for the download page and every installed app's updater.
#
#   scripts/r2-publish.sh <dir with the release files> <X.Y.Z | X.Y.Z-beta.N>
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
# The version decides who gets it. The feed holds two release lines, told
# apart by electron-updater's channel files (src/main/updateChannel.ts):
#
#   X.Y.Z         everyone. The build wrote latest-mac.yml / latest.yml; they
#                 go up under their names AND, the same bytes, as
#                 beta-mac.yml / beta.yml — so the machines on beta get every
#                 stable release too (what electron-builder's
#                 generateUpdatesFilesForAllChannels would write, done here so
#                 the build and its draft stay the same twelve files).
#   X.Y.Z-beta.N  only the machines that opted into beta. electron-builder
#                 named its feeds beta-mac.yml / beta.yml itself (the version's
#                 prerelease tag); only those go up, with the versioned files.
#                 Never step 2, never latest*.yml: nothing a stable machine or
#                 the download page reads.
#
# Anything else is refused, and so are feeds announcing another version —
# both before anything is uploaded.
#
# Env: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY (R2, desktop/ only),
#      R2_ACCOUNT_ID, R2_BUCKET.
set -euo pipefail

dir="${1:?usage: r2-publish.sh <dir> <X.Y.Z | X.Y.Z-beta.N>}"
V="${2:?version}"
if [[ "$V" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  channel=latest
elif [[ "$V" =~ ^[0-9]+\.[0-9]+\.[0-9]+-beta\.[0-9]+$ ]]; then
  channel=beta
else
  echo "::error::$V is neither X.Y.Z (stable) nor X.Y.Z-beta.N (beta)"; exit 1
fi
[ -n "${AWS_ACCESS_KEY_ID:-}" ] || { echo "::error::R2 secrets are not set on this repo"; exit 1; }
EP="https://${R2_ACCOUNT_ID:?}.r2.cloudflarestorage.com"
DEST="s3://${R2_BUCKET:?}/desktop/stable"
put() { aws s3 cp --endpoint-url "$EP" --only-show-errors --cache-control "$3" "$1" "$DEST/$2"; }

cd "$dir"
for f in "$channel-mac.yml" "$channel.yml"; do
  [ -f "$f" ] || { echo "::error::$f is missing — not a $V build"; exit 1; }
  said=$(awk '/^version:/ {print $2; exit}' "$f")
  [ "$said" = "$V" ] || { echo "::error::$f announces '$said', not $V"; exit 1; }
done

for f in *.dmg *.zip *.blockmap *.exe; do put "$f" "$f" "public, max-age=31536000, immutable"; done
if [ "$channel" = latest ]; then
  put "Mafold-$V-arm64.dmg" "Mafold-mac-arm64.dmg" "no-cache"
  put "Mafold-$V-x64.dmg"   "Mafold-mac-x64.dmg"   "no-cache"
  put "Mafold-Setup-$V.exe" "Mafold-Setup.exe"     "no-cache"
  put latest-mac.yml latest-mac.yml "no-cache"
  put latest.yml     latest.yml     "no-cache"
fi
put "$channel-mac.yml" beta-mac.yml "no-cache"
put "$channel.yml"     beta.yml     "no-cache"
if [ "$channel" = latest ]; then
  echo "cdn.mafold.com/desktop/stable/ now serves $V, to everyone"
else
  echo "cdn.mafold.com/desktop/stable/ now serves $V to the beta machines only"
fi
