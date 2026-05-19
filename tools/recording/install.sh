#!/usr/bin/env bash
# install.sh — drop recording scripts into ~/.ycal/ and verify deps.
set -euo pipefail
SRC="$(cd "$(dirname "$0")" && pwd)"
DST="${HOME}/.ycal"
mkdir -p "$DST/models" "$DST/recordings"
cp "$SRC/record-meet.sh" "$DST/record-meet.sh"
cp "$SRC/post-meet.sh"   "$DST/post-meet.sh"
chmod +x "$DST/record-meet.sh" "$DST/post-meet.sh"
echo "Installed scripts → $DST/"

pass=0; fail=0
mark() { if [[ "$1" = ok ]]; then printf '  \033[32m✓\033[0m %s\n' "$2"; ((pass++)) || true
        else                       printf '  \033[31m✗\033[0m %s\n' "$2"; ((fail++)) || true; fi; }

echo
echo "Dependency check:"
for bin in ffmpeg whisper-cli claude; do
  if command -v "$bin" >/dev/null 2>&1; then
    mark ok "$bin → $(command -v "$bin")"
  else
    mark no "$bin NOT on PATH"
  fi
done

if [[ -f "$DST/models/ggml-large-v3-turbo.bin" ]]; then
  mark ok "whisper model ($(du -h "$DST/models/ggml-large-v3-turbo.bin" | cut -f1)) at ~/.ycal/models/"
else
  mark no "whisper model missing — run: curl -L --fail -o ~/.ycal/models/ggml-large-v3-turbo.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin"
fi

echo
echo "Audio device check (ffmpeg's view):"
"$DST/record-meet.sh" list-devices 2>/dev/null | sed 's/^/  /'

if "$DST/record-meet.sh" list-devices 2>/dev/null | grep -iq BlackHole; then
  mark ok "BlackHole audio device detected"
else
  mark no "BlackHole NOT installed — run: brew install --cask blackhole-2ch (then sign out + back in)"
fi

echo
if (( fail == 0 )); then
  echo "$pass checks passed. Next: set up a Multi-Output Device that includes BlackHole — see README."
else
  echo "$fail issues — fix the items above before recording."
  exit 1
fi
