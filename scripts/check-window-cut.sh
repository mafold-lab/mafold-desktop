#!/bin/bash
# check-window-cut.sh <Mafold.app> [team]: the window's corner cut in a packaged
# app (native/windowCut.m, windowCorners.ts). A package that leaves it behind, or
# a macOS that refuses it, ends in an ordinary window and a line in a log, and
# nothing fails by itself. So: it's there as a real file, for both architectures,
# signed (by `team`, for a release), and an app this machine can run loads it and
# cuts its window.
set -euo pipefail
app="$1"
team="${2:-}"
fail() { echo "::error::$app: $*"; exit 1; }

cut="$app/Contents/Resources/app.asar.unpacked/dist/native/windowCut.node"
[ -f "$cut" ] || fail "no corner cut at $cut"
archs=" $(lipo -archs "$cut") "
[[ "$archs" == *" arm64 "* && "$archs" == *" x86_64 "* ]] || fail "the corner cut is built for$archs"
codesign --verify --strict --verbose=2 "$cut" || fail "the corner cut's signature doesn't verify"
if [ -n "$team" ]; then
  codesign -dv "$cut" 2>&1 | grep -q "^TeamIdentifier=$team$" || fail "the corner cut is not signed by team $team"
fi

if [ "$(lipo -archs "$app/Contents/MacOS/Mafold")" != "$(uname -m)" ]; then
  echo "$app: signed, and not this machine's to run"
  exit 0
fi

# window-corners.json is what the page leaves for the next launch. The log is
# the app's own, and has been written to before.
profile="$(mktemp -d)"
echo '{"on":true}' > "$profile/window-corners.json"
log="$HOME/Library/Logs/Mafold/main.log"
before="$(wc -l 2>/dev/null < "$log" || echo 0)"
written() { tail -n "+$((before + 1))" "$log" 2>/dev/null || true; }

"$app/Contents/MacOS/Mafold" --user-data-dir="$profile" > "$profile/launch.log" 2>&1 &
pid=$!
trap 'kill "$pid" 2>/dev/null || true' EXIT
for _ in $(seq 1 40); do
  [[ "$(written)" == *"the window's corner cut is loaded"* ]] && break
  kill -0 "$pid" 2>/dev/null || break
  sleep 0.5
done
# The window is made, and cut, right after the module loads.
sleep 3
out="$(written)"
if [[ "$out" != *"the window's corner cut is loaded"* || "$out" == *"the window has no layer to cut"* ]] || ! kill -0 "$pid" 2>/dev/null; then
  echo "$out"
  cat "$profile/launch.log" || true
  fail "the app didn't load the corner cut and cut its window"
fi
echo "$app: the corner cut is loaded ✓"
