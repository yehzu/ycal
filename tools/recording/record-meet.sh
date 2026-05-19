#!/usr/bin/env bash
# record-meet.sh — start/stop a meeting recording.
#
# System audio is captured via Apple's ScreenCaptureKit (no BlackHole, no
# Multi-Output Device). The bundled `coreaudio-tap` helper streams 16 kHz
# mono float32 PCM to stdout; we pipe it through a FIFO to ffmpeg, which
# also opens the default microphone via avfoundation and `amix`-es the
# two streams into an m4a in ~/Recordings/yCal/.
#
# Usage:
#   record-meet.sh start <event_id> <title> [max_seconds]
#   record-meet.sh stop  <event_id>
#   record-meet.sh status <event_id>
#   record-meet.sh list-devices
#
# `max_seconds` is a safety net: if yCal crashes (or quits without
# polling), ffmpeg's `-t` self-terminates at that boundary rather than
# recording the user's life. Set to ~event_duration + 10min slack.
#
# Env overrides:
#   YCAL_RECORDING_DIR     output directory (default ~/Recordings/yCal)
#   YCAL_MIC_NAME          substring match for mic (default: first audio device)
#   YCAL_COREAUDIO_TAP     path to the coreaudio-tap binary
#                          (default: ~/.ycal/bin/coreaudio-tap)
#
# State (PIDs + audio path) lives in ~/.ycal/recordings/ keyed by event id.

set -euo pipefail

YCAL_DIR="${HOME}/.ycal"
STATE_DIR="${YCAL_DIR}/recordings"
OUT_DIR="${YCAL_RECORDING_DIR:-${HOME}/Recordings/yCal}"
TAP_BIN="${YCAL_COREAUDIO_TAP:-${YCAL_DIR}/bin/coreaudio-tap}"
mkdir -p "$STATE_DIR" "$OUT_DIR"

list_devices() {
  # ffmpeg exits non-zero when given an empty input — expected. We strip
  # to just the audio-device lines so callers can grep.
  { ffmpeg -hide_banner -f avfoundation -list_devices true -i "" 2>&1 || true; } \
    | awk '
        /AVFoundation audio devices:/ { flag=1; next }
        /AVFoundation video devices/  { flag=0; next }
        flag && /\[[0-9]+\] / { print }
      '
}

# macOS ships BSD awk, which lacks gawk's 3-arg match($0, /regex/, m).
# We use POSIX match() + substr() + index() instead. Each device line
# looks like `[AVFoundation indev @ 0xNNN] [N] Name`; we anchor on the
# rightmost \[[0-9]+\] segment to pull idx + the trailing name.
device_index() {
  list_devices | awk -v name="$1" '
    {
      if (match($0, /\[[0-9]+\] /)) {
        idx  = substr($0, RSTART+1, RLENGTH-3)
        rest = substr($0, RSTART+RLENGTH)
        if (index(tolower(rest), tolower(name)) > 0) { print idx; exit }
      }
    }'
}

first_mic_index() {
  list_devices | awk '
    {
      if (match($0, /\[[0-9]+\] /)) {
        idx = substr($0, RSTART+1, RLENGTH-3)
        print idx; exit
      }
    }'
}

start() {
  local event_id="${1:?event_id required}"
  local title="${2:-meeting}"
  local max_seconds="${3:-}"
  local pid_file="${STATE_DIR}/${event_id}.pid"
  local tap_pid_file="${STATE_DIR}/${event_id}.tap.pid"
  local audio_marker="${STATE_DIR}/${event_id}.file"
  local fifo="${STATE_DIR}/${event_id}.fifo"

  if [[ -f "$pid_file" ]] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then
    echo "[record-meet] already recording $event_id (pid $(cat "$pid_file"))" >&2
    [[ -f "$audio_marker" ]] && cat "$audio_marker"
    return 0
  fi

  if [[ ! -x "$TAP_BIN" ]]; then
    echo "[record-meet] coreaudio-tap not found at $TAP_BIN" >&2
    echo "                Run tools/recording/install.sh, or set YCAL_COREAUDIO_TAP." >&2
    return 2
  fi

  local mic
  if [[ -n "${YCAL_MIC_NAME:-}" ]]; then
    mic="$(device_index "$YCAL_MIC_NAME")"
  else
    mic="$(first_mic_index)"
  fi
  if [[ -z "$mic" ]]; then
    echo "[record-meet] no microphone device found" >&2
    return 2
  fi

  local stamp safe file
  stamp="$(date +%Y-%m-%d_%H%M)"
  safe="$(printf '%s' "$title" | LC_ALL=C tr -c 'A-Za-z0-9_\-' '-' | tr -s '-' | sed -e 's/^-//' -e 's/-$//')"
  [[ -z "$safe" ]] && safe="meeting"
  file="${OUT_DIR}/${stamp}__${safe}__${event_id}.m4a"

  # Named pipe carries 16 kHz mono float32 PCM from coreaudio-tap to ffmpeg.
  # Recreate fresh in case a previous run left a stale node.
  rm -f "$fifo"; mkfifo "$fifo"

  # coreaudio-tap watches its stdin for EOF as a "parent died" signal.
  # /dev/null fires that watcher immediately (read returns 0), so the
  # binary exits cleanly before recording even starts — with no stderr
  # output, which makes it look like a permission failure. Instead we
  # back stdin with a FIFO and keep the write-end pinned open by a
  # silent `sleep` running under nohup. Sleep never writes, so the
  # dispatch read source on the tap side has no data + no EOF and
  # stays dormant until we SIGTERM either process on stop.
  local stdin_fifo="${STATE_DIR}/${event_id}.stdin"
  rm -f "$stdin_fifo"; mkfifo "$stdin_fifo"
  nohup bash -c "exec sleep 86400 > '$stdin_fifo'" >/dev/null 2>&1 &
  local keep_pid=$!

  nohup "$TAP_BIN" < "$stdin_fifo" > "$fifo" 2> "${STATE_DIR}/${event_id}.tap.log" &
  local tap_pid=$!

  # -t <max_seconds> self-terminates ffmpeg in case yCal stops polling.
  local ts_arg=()
  [[ -n "$max_seconds" ]] && ts_arg=(-t "$max_seconds")

  # NOTE: do NOT pass -nostdin here. We feed nothing to ffmpeg's stdin —
  # the FIFO is opened as an explicit input file, so ffmpeg's default
  # stdin behaviour is fine and won't fight the pipe ordering.
  #
  # We DON'T pass -ar / -ac before the avfoundation input. The
  # avfoundation indev only accepts a small set of input options
  # (audio_device_index, pixel_format, framerate, …) — passing -ar
  # there fails with "Option sample_rate not found" before the mic
  # even opens.
  #
  # Filter chain: the tap stream is 16 kHz mono and the mic is whatever
  # native rate / channel count the device serves (USB mics often go
  # 48 kHz stereo). If we let amix pick a common rate it follows the
  # FIRST input, so the mic ends up downsampled to 16 kHz mono and the
  # encoded m4a sounds crackly and band-limited. Resample BOTH to
  # 48 kHz mono explicitly before mixing, then pin the output to 48 kHz
  # mono so the AAC encoder doesn't have to clamp bitrate either.
  # dropout_transition=0 disables amix's automatic volume rebalancing
  # when one stream goes quiet (would otherwise duck the other side).
  nohup ffmpeg -hide_banner -y \
    -f f32le -ar 16000 -ac 1 -i "$fifo" \
    -f avfoundation -i ":${mic}" \
    -filter_complex "[0:a]aresample=48000[a0];[1:a]aresample=48000,aformat=channel_layouts=mono[a1];[a0][a1]amix=inputs=2:duration=longest:normalize=0:dropout_transition=0[a]" \
    -map "[a]" -ar 48000 -ac 1 -c:a aac -b:a 128k -movflags +faststart \
    "${ts_arg[@]}" \
    "$file" \
    > "${STATE_DIR}/${event_id}.ffmpeg.log" 2>&1 &
  local pid=$!

  # ffmpeg fails fast if mic permission isn't granted, or if the FIFO
  # producer never opens. Give the trio a short grace period; if any
  # dies during boot, surface it now instead of producing an empty m4a.
  sleep 0.8
  if ! kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$tap_pid"  2>/dev/null || true
    kill -TERM "$keep_pid" 2>/dev/null || true
    rm -f "$fifo" "$stdin_fifo"
    echo "[record-meet] ffmpeg died on startup — see ${STATE_DIR}/${event_id}.ffmpeg.log" >&2
    return 3
  fi
  if ! kill -0 "$tap_pid" 2>/dev/null; then
    kill -INT  "$pid"      2>/dev/null || true
    kill -TERM "$keep_pid" 2>/dev/null || true
    rm -f "$fifo" "$stdin_fifo"
    echo "[record-meet] coreaudio-tap died on startup — see ${STATE_DIR}/${event_id}.tap.log" >&2
    echo "                Likely: Screen Recording permission not granted." >&2
    return 3
  fi

  echo "$pid"      > "$pid_file"
  echo "$tap_pid"  > "$tap_pid_file"
  echo "$keep_pid" > "${STATE_DIR}/${event_id}.keep.pid"
  echo "$file"     > "$audio_marker"
  echo "[record-meet] started ffmpeg=$pid tap=$tap_pid keep=$keep_pid → $file" >&2
  printf '%s\n' "$file"
}

stop() {
  local event_id="${1:?event_id required}"
  local pid_file="${STATE_DIR}/${event_id}.pid"
  local tap_pid_file="${STATE_DIR}/${event_id}.tap.pid"
  local keep_pid_file="${STATE_DIR}/${event_id}.keep.pid"
  local audio_marker="${STATE_DIR}/${event_id}.file"
  local fifo="${STATE_DIR}/${event_id}.fifo"
  local stdin_fifo="${STATE_DIR}/${event_id}.stdin"
  local file=""
  [[ -f "$audio_marker" ]] && file="$(cat "$audio_marker")"

  if [[ ! -f "$pid_file" && ! -f "$tap_pid_file" ]]; then
    echo "[record-meet] no active recording for $event_id" >&2
    [[ -n "$file" ]] && printf '%s\n' "$file"
    return 1
  fi

  # SIGINT ffmpeg first — gives it time to flush the moov atom. Without
  # that the m4a header is missing and players can't seek (or open at
  # all). 5s budget; fall back to SIGTERM if it's still around.
  if [[ -f "$pid_file" ]]; then
    local pid; pid="$(cat "$pid_file")"
    if kill -0 "$pid" 2>/dev/null; then
      kill -INT "$pid" 2>/dev/null || true
      for _ in $(seq 1 50); do
        sleep 0.1; kill -0 "$pid" 2>/dev/null || break
      done
      kill -TERM "$pid" 2>/dev/null || true
    fi
  fi
  # Then stop coreaudio-tap. SIGTERM is what its main.swift handler
  # listens for; it exits cleanly.
  if [[ -f "$tap_pid_file" ]]; then
    local tap_pid; tap_pid="$(cat "$tap_pid_file")"
    if kill -0 "$tap_pid" 2>/dev/null; then
      kill -TERM "$tap_pid" 2>/dev/null || true
      for _ in $(seq 1 20); do
        sleep 0.1; kill -0 "$tap_pid" 2>/dev/null || break
      done
      kill -KILL "$tap_pid" 2>/dev/null || true
    fi
  fi
  # Finally the stdin keeper (the silent `sleep` that held the FIFO
  # write-end open). Untouched by either SIGINT or SIGTERM up to this
  # point — if we orphaned it on a crash it would idle for 24h until
  # the script's exec'd sleep timed out, which is annoying but bounded.
  if [[ -f "$keep_pid_file" ]]; then
    local keep_pid; keep_pid="$(cat "$keep_pid_file")"
    kill -TERM "$keep_pid" 2>/dev/null || true
  fi
  rm -f "$pid_file" "$tap_pid_file" "$keep_pid_file" "$audio_marker" "$fifo" "$stdin_fifo"
  echo "[record-meet] stopped $event_id" >&2
  [[ -n "$file" ]] && printf '%s\n' "$file"
}

status() {
  local event_id="${1:?event_id required}"
  local pid_file="${STATE_DIR}/${event_id}.pid"
  if [[ -f "$pid_file" ]] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then
    echo "running"; return 0
  fi
  echo "stopped"; return 1
}

cmd="${1:-}"; shift || true
case "$cmd" in
  start)        start "$@" ;;
  stop)         stop  "$@" ;;
  status)       status "$@" ;;
  list-devices) list_devices ;;
  *) echo "usage: $0 {start|stop|status|list-devices} ..." >&2; exit 2 ;;
esac
