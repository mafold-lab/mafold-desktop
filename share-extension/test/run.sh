#!/bin/bash
# ShareSpool against the real NSItemProvider. macOS only.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
swiftc -swift-version 5 -module-name SpoolTest \
  "$here/../ShareSpool.swift" "$here/../ShareInboxReader.swift" "$here/main.swift" -o "$out/spool-test"
"$out/spool-test"

# The iPhone extension and reader compile against the iOS SDK too. Linking waits
# for the app's own build; the app's Xcode project lives in mafold-rn.
swiftc -typecheck -swift-version 5 -parse-as-library -module-name MafoldShare \
  -target arm64-apple-ios15.1-simulator -sdk "$(xcrun --show-sdk-path --sdk iphonesimulator)" \
  "$here/../ShareSpool.swift" "$here/../ShareInboxReader.swift" "$here/../ios/ShareViewController.swift"
