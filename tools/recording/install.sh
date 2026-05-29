#!/usr/bin/env bash
# install.sh — install scripts + bundled coreaudio-tap into ~/.ycal/.
set -euo pipefail
SRC="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SRC/../.." && pwd)"
DST="${HOME}/.ycal"
mkdir -p "$DST/models" "$DST/recordings" "$DST/bin"

cp "$SRC/record-meet.sh" "$DST/record-meet.sh"
cp "$SRC/post-meet.sh"   "$DST/post-meet.sh"
chmod +x "$DST/record-meet.sh" "$DST/post-meet.sh"
echo "Installed scripts → $DST/"

# coreaudio-tap lives in build/native/ in the dev tree, and
# Resources/native/ inside the packaged app. yCal itself sets
# YCAL_COREAUDIO_TAP when it spawns the script — this copy is for users
# running record-meet.sh by hand from a Terminal.
TAP_SRC=""
for candidate in \
    "$REPO_ROOT/build/native/coreaudio-tap" \
    "${YCAL_COREAUDIO_TAP:-}" \
    "/Applications/yCal.app/Contents/Resources/native/coreaudio-tap"; do
  [[ -n "$candidate" && -x "$candidate" ]] && { TAP_SRC="$candidate"; break; }
done
if [[ -n "$TAP_SRC" ]]; then
  cp "$TAP_SRC" "$DST/bin/coreaudio-tap"
  chmod +x "$DST/bin/coreaudio-tap"
  echo "Installed coreaudio-tap from $TAP_SRC"
else
  echo "WARN: coreaudio-tap not found in repo or installed app — yCal will copy" >&2
  echo "      it from its app bundle on first launch." >&2
fi

# voiceproc-mic — Voice-Processing mic helper (Apple AEC). Same vendoring
# slots as coreaudio-tap. Optional: record-meet.sh falls back to raw
# avfoundation capture when it's absent.
VPIO_SRC=""
for candidate in \
    "$REPO_ROOT/build/native/voiceproc-mic" \
    "${YCAL_VPIO_BIN:-}" \
    "/Applications/yCal.app/Contents/Resources/native/voiceproc-mic"; do
  [[ -n "$candidate" && -x "$candidate" ]] && { VPIO_SRC="$candidate"; break; }
done
if [[ -n "$VPIO_SRC" ]]; then
  cp "$VPIO_SRC" "$DST/bin/voiceproc-mic"
  chmod +x "$DST/bin/voiceproc-mic"
  echo "Installed voiceproc-mic from $VPIO_SRC"
else
  echo "INFO: voiceproc-mic not found — raw mic capture will be used until yCal" >&2
  echo "      copies it from its app bundle on first launch." >&2
fi

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

if [[ -x "$DST/bin/coreaudio-tap" ]]; then
  mark ok "coreaudio-tap → $DST/bin/coreaudio-tap"
else
  mark no "coreaudio-tap missing — copy from yCal.app or repo build/native/"
fi

if [[ -f "$DST/models/ggml-large-v3-turbo.bin" ]]; then
  mark ok "whisper model ($(du -h "$DST/models/ggml-large-v3-turbo.bin" | cut -f1)) at ~/.ycal/models/"
else
  mark no "whisper model missing — run: curl -L --fail -o ~/.ycal/models/ggml-large-v3-turbo.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin"
fi

echo
echo "Audio device check (ffmpeg's view of mic inputs):"
"$DST/record-meet.sh" list-devices 2>/dev/null | sed 's/^/  /' || true

echo
if (( fail == 0 )); then
  echo "$pass checks passed. First recording will prompt for Screen Recording + Microphone permission — grant both."
else
  echo "$fail issues — fix the items above before recording."
  exit 1
fi
