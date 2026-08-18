#!/bin/sh
# Golden-file runner for the `ycal watch` replay cases.
#
#   npm run test:watch          compare every case against its .expected
#   npm run test:watch -- bless rewrite the .expected files
#
# Runs the in-process CLI (no GUI, no socket, no Google): --replay feeds
# recorded snapshots through the same detection code the live watcher uses.
# Comparison is on JSON, not the human rendering, because the latter goes
# through toLocaleString and would differ by machine locale and timezone.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
CASES="$ROOT/tests/watch"
ELECTRON="$ROOT/node_modules/.bin/electron"
MODE=${1:-check}

if [ ! -x "$ELECTRON" ]; then
  echo "ERROR: $ELECTRON missing — run npm install" >&2
  exit 1
fi
if [ ! -f "$ROOT/out/main/index.js" ]; then
  echo "ERROR: no build in ./out — run npm run build first" >&2
  exit 1
fi

pass=0
fail=0
for jsonl in "$CASES"/*.jsonl; do
  name=$(basename "$jsonl" .jsonl)
  expected="$CASES/$name.expected"
  actual=$(cd "$ROOT" && "$ELECTRON" . --cli watch --replay "$jsonl" --format json 2>/dev/null)

  if [ "$MODE" = "bless" ]; then
    printf '%s\n' "$actual" > "$expected"
    echo "blessed  $name"
    continue
  fi

  if [ ! -f "$expected" ]; then
    echo "MISSING  $name.expected — run: npm run test:watch -- bless" >&2
    fail=$((fail + 1))
    continue
  fi
  if [ "$actual" = "$(cat "$expected")" ]; then
    echo "ok       $name"
    pass=$((pass + 1))
  else
    echo "FAIL     $name" >&2
    printf '%s\n' "$actual" | diff -u "$expected" - || true
    fail=$((fail + 1))
  fi
done

[ "$MODE" = "bless" ] && exit 0

echo ""
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1
