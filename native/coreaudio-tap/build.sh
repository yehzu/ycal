#!/usr/bin/env bash
# build.sh — compile coreaudio-tap into a universal macOS binary and drop
# it at build/native/coreaudio-tap (the vendoring slot electron-builder
# bundles into Resources/native/). First-party rewrite; re-run whenever
# main.swift changes. macOS 13+ (ScreenCaptureKit audio capture).
set -euo pipefail

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SRC_DIR/../.." && pwd)"
OUT_DIR="$REPO_ROOT/build/native"
OUT="$OUT_DIR/coreaudio-tap"
mkdir -p "$OUT_DIR"

FRAMEWORKS=(-framework ScreenCaptureKit -framework AVFoundation -framework CoreMedia -framework Foundation)
MIN=13.0

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

build_slice() {
  local arch="$1"
  swiftc -O -target "${arch}-apple-macos${MIN}" \
    "$SRC_DIR/main.swift" "${FRAMEWORKS[@]}" \
    -o "$tmp/coreaudio-tap-${arch}"
}

echo "building arm64…"
build_slice arm64
slices=("$tmp/coreaudio-tap-arm64")

if build_slice x86_64 2>/dev/null; then
  echo "building x86_64… ok"
  slices+=("$tmp/coreaudio-tap-x86_64")
else
  echo "x86_64 slice failed — shipping arm64-only" >&2
fi

lipo -create -output "$OUT" "${slices[@]}"
chmod +x "$OUT"
echo "→ $OUT"
lipo -info "$OUT"
