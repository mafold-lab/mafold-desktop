#!/bin/bash
# Builds the macOS share extension to share-extension/build/MafoldShare.appex, both architectures
# in one binary. scripts/embed-share-extension.cjs puts it in the app and signs
# it; this leaves it unsigned. swiftc rather than an Xcode project: two files and
# a plist, and the public mirror builds from this folder alone.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
src="$root/share-extension"
appex="$src/build/MafoldShare.appex"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

sdk="$(xcrun --show-sdk-path --sdk macosx)"
for arch in arm64 x86_64; do
  swiftc -O -swift-version 5 -application-extension -parse-as-library \
    -module-name MafoldShare \
    -target "$arch-apple-macos12.0" -sdk "$sdk" \
    -Xlinker -e -Xlinker _NSExtensionMain \
    "$src/ShareSpool.swift" "$src/mac/ShareViewController.swift" \
    -o "$work/MafoldShare-$arch"
done

rm -rf "$appex"
mkdir -p "$appex/Contents/MacOS" "$appex/Contents/Resources"
lipo -create "$work"/MafoldShare-* -output "$appex/Contents/MacOS/MafoldShare"
cp "$src/mac/Info.plist" "$appex/Contents/Info.plist"
printf 'XPC!????' > "$appex/Contents/PkgInfo"
plutil -lint "$appex/Contents/Info.plist" >/dev/null
echo "built $appex"
