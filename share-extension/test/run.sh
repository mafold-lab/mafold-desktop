#!/bin/bash
# ShareSpool against the real NSItemProvider. macOS only.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
swiftc -swift-version 5 -module-name SpoolTest \
  "$here/../ShareSpool.swift" "$here/main.swift" -o "$out/spool-test"
"$out/spool-test"
