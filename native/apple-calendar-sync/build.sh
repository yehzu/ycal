#!/usr/bin/env bash
# Build the EventKit bridge as a universal helper bundled in Resources/native.
set -euo pipefail

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SRC_DIR/../.." && pwd)"
OUT_DIR="$REPO_ROOT/build/native"
OUT="$OUT_DIR/apple-calendar-sync"
MIN=13.0

# Allow an explicit SDK for machines with multiple CLT/Xcode installs. The
# current macOS 26 CLT can occasionally ship a compiler one patch ahead of its
# default SDK's Swift modules; the bundled 15.4 SDK is stable for our macOS 13
# deployment target and contains every EventKit API used here.
if [[ -n "${YCAL_MACOS_SDK:-}" ]]; then
  SDK="$YCAL_MACOS_SDK"
elif [[ -d /Library/Developer/CommandLineTools/SDKs/MacOSX15.4.sdk ]]; then
  SDK=/Library/Developer/CommandLineTools/SDKs/MacOSX15.4.sdk
else
  SDK="$(xcrun --sdk macosx --show-sdk-path)"
fi

mkdir -p "$OUT_DIR"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
MODULE_CACHE="$tmp/swift-module-cache"
mkdir -p "$MODULE_CACHE"

build_slice() {
  local arch="$1"
  CLANG_MODULE_CACHE_PATH="$MODULE_CACHE" \
  SWIFT_MODULECACHE_PATH="$MODULE_CACHE" \
  swiftc -O -parse-as-library -sdk "$SDK" -target "${arch}-apple-macos${MIN}" \
    "$SRC_DIR/main.swift" \
    -framework AppKit -framework EventKit -framework Foundation \
    -Xlinker -sectcreate \
    -Xlinker __TEXT \
    -Xlinker __info_plist \
    -Xlinker "$SRC_DIR/Info.plist" \
    -o "$tmp/apple-calendar-sync-${arch}"
}

echo "building arm64…"
build_slice arm64
slices=("$tmp/apple-calendar-sync-arm64")

if build_slice x86_64 2>/dev/null; then
  echo "building x86_64… ok"
  slices+=("$tmp/apple-calendar-sync-x86_64")
else
  echo "x86_64 slice failed — shipping arm64-only" >&2
fi

lipo -create -output "$OUT" "${slices[@]}"
chmod +x "$OUT"
echo "→ $OUT"
lipo -info "$OUT"
