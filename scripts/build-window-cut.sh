#!/bin/bash
# Builds the window's corner cut (native/windowCut.m, windowCorners.ts) to
# dist/native/windowCut.node, both architectures in one binary, the way
# build-share-extension.sh builds the extension: one file, and the public mirror
# builds from this folder alone. It runs on the headers of the Node that's
# building it: Node-API is the same in Electron, and needs no Electron headers.
# electron-builder signs it with the app.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
out="$root/dist/native/windowCut.node"
headers="$(dirname "$(dirname "$(node -p 'process.execPath')")")/include/node"

mkdir -p "$(dirname "$out")"
xcrun clang -O2 -fobjc-arc -fvisibility=hidden -Wall -Werror \
  -arch arm64 -arch x86_64 -mmacosx-version-min=12.0 \
  -isystem "$headers" \
  -bundle -undefined dynamic_lookup -framework AppKit -framework QuartzCore \
  "$root/native/windowCut.m" -o "$out"
echo "built $out ($(lipo -archs "$out"))"
