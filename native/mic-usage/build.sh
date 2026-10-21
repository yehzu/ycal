#!/usr/bin/env bash
# build.sh — compile mic-usage into a universal macOS binary and drop
# it at build/native/mic-usage (the vendoring slot electron-builder
# bundles into Resources/native/, mirroring coreaudio-tap).
#
# Re-run this whenever main.swift changes. The output binary is committed
# to the repo so the release pipeline doesn't need a swift build step
# (same rationale as the vendored coreaudio-tap).
set -euo pipefail

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SRC_DIR/../.." && pwd)"
OUT_DIR="$REPO_ROOT/build/native"
OUT="$OUT_DIR/mic-usage"
mkdir -p "$OUT_DIR"

FRAMEWORKS=(-framework CoreAudio -framework Foundation)
MIN=14.0

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

build_slice() {
  local arch="$1"
  swiftc -O -target "${arch}-apple-macos${MIN}" \
    "$SRC_DIR/main.swift" "${FRAMEWORKS[@]}" \
    -o "$tmp/mic-usage-${arch}"
}

echo "building arm64…"
build_slice arm64
slices=("$tmp/mic-usage-arm64")

# x86_64 slice is best-effort: keeps the binary universal (matches
# coreaudio-tap) so Intel Macs are covered, but a host that can't target
# x86_64 still gets a working arm64-only binary.
if build_slice x86_64 2>/dev/null; then
  echo "building x86_64… ok"
  slices+=("$tmp/mic-usage-x86_64")
else
  echo "x86_64 slice failed — shipping arm64-only" >&2
fi

lipo -create -output "$OUT" "${slices[@]}"
chmod +x "$OUT"
echo "→ $OUT"
lipo -info "$OUT"
