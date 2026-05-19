#!/usr/bin/env bash
# record-meet.sh — start/stop a meeting recording.
#
# Mixes BlackHole 2ch (system audio you hear in the Meet) with your
# default microphone into a single AAC/m4a file in ~/Recordings/yCal/.
# State (pid + filename) lives in ~/.ycal/recordings/ keyed by event id
# so yCal can stop it cleanly later.
#
# Usage:
#   record-meet.sh start <event_id> <title> [max_seconds]   # echoes the audio file path
#   record-meet.sh stop  <event_id>                          # echoes the audio file path
#   record-meet.sh status <event_id>                         # "running" | "stopped"
#   record-meet.sh list-devices                              # debug: what ffmpeg sees
#
# `max_seconds` is a safety net: if yCal crashes (or quits without
# polling), ffmpeg exits on its own at that boundary rather than
# recording the user's life. Set to ~event_duration + 10min slack.
#
# Env overrides:
#   YCAL_RECORDING_DIR   output directory (default ~/Recordings/yCal)
#   YCAL_MIC_NAME        substring to match in audio device list (default: first non-BlackHole)
#   YCAL_BH_NAME         BlackHole name fragment (default: "BlackHole")

set -euo pipefail

YCAL_DIR="${HOME}/.ycal"
STATE_DIR="${YCAL_DIR}/recordings"
OUT_DIR="${YCAL_RECORDING_DIR:-${HOME}/Recordings/yCal}"
BH_NAME="${YCAL_BH_NAME:-BlackHole}"
mkdir -p "$STATE_DIR" "$OUT_DIR"

list_devices() {
  # ffmpeg exits non-zero when given an empty input — that's expected;
  # the device list lands on stderr along the way. We pull just the
  # audio section between the two header lines. `|| true` keeps the
  # pipefail-armed caller from aborting on ffmpeg's normal failure here.
  { ffmpeg -hide_banner -f avfoundation -list_devices true -i "" 2>&1 || true; } \
    | awk '
        /AVFoundation audio devices:/ { flag=1; next }
        /AVFoundation video devices/  { flag=0; next }
        flag && /\[[0-9]+\] / { print }
      '
}

# macOS ships BSD awk, which lacks gawk's 3-arg match($0, /regex/, m).
# We use POSIX match()+substr() and an index() containment check instead.
# Each device line looks like:
#   [AVFoundation indev @ 0xNNN] [N] Device Name
# match() locates the rightmost `[<digits>] ` segment (the device index),
# substr() peels out the digits and the trailing name.

device_index() {
  # $1 = case-insensitive name fragment. Echoes the first matching index.
  list_devices | awk -v name="$1" '
    {
      if (match($0, /\[[0-9]+\] /)) {
        idx  = substr($0, RSTART+1, RLENGTH-3)
        rest = substr($0, RSTART+RLENGTH)
        if (index(tolower(rest), tolower(name)) > 0) { print idx; exit }
      }
    }'
}

first_non_bh_index() {
  list_devices | awk -v bh="$BH_NAME" '
    {
      if (match($0, /\[[0-9]+\] /)) {
        idx  = substr($0, RSTART+1, RLENGTH-3)
        rest = substr($0, RSTART+RLENGTH)
        if (index(tolower(rest), tolower(bh)) == 0) { print idx; exit }
      }
    }'
}

start() {
  local event_id="${1:?event_id required}"
  local title="${2:-meeting}"
  local max_seconds="${3:-}"
  local pid_file="${STATE_DIR}/${event_id}.pid"
  local audio_marker="${STATE_DIR}/${event_id}.file"

  if [[ -f "$pid_file" ]] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then
    echo "[record-meet] already recording $event_id (pid $(cat "$pid_file"))" >&2
    [[ -f "$audio_marker" ]] && cat "$audio_marker"
    return 0
  fi

  local bh; bh="$(device_index "$BH_NAME")"
  if [[ -z "$bh" ]]; then
    echo "[record-meet] BlackHole audio device not found. Install with: brew install --cask blackhole-2ch" >&2
    return 2
  fi

  local mic
  if [[ -n "${YCAL_MIC_NAME:-}" ]]; then
    mic="$(device_index "$YCAL_MIC_NAME")"
  else
    mic="$(first_non_bh_index)"
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

  # amix sums the two streams. normalize=0 so a quiet participant doesn't
  # attenuate your own voice. duration=longest = file ends when both are done.
  # SIGINT (handled by `stop`) lets ffmpeg flush the moov atom cleanly.
  # -t <max_seconds> is a safety net so a crashed yCal can't leave ffmpeg
  # running until disk-full — we cap at the meeting length + slack.
  local ts_arg=()
  [[ -n "$max_seconds" ]] && ts_arg=(-t "$max_seconds")
  nohup ffmpeg -hide_banner -nostdin -y \
    -f avfoundation -ar 48000 -ac 2 -i ":${bh}" \
    -f avfoundation -ar 48000 -ac 1 -i ":${mic}" \
    -filter_complex "[0:a]aresample=async=1[a0];[1:a]aresample=async=1[a1];[a0][a1]amix=inputs=2:duration=longest:normalize=0[a]" \
    -map "[a]" -c:a aac -b:a 128k -movflags +faststart \
    "${ts_arg[@]}" \
    "$file" \
    > "${STATE_DIR}/${event_id}.ffmpeg.log" 2>&1 &

  local pid=$!
  # ffmpeg returns immediately if either input is bad. Give it 500ms then
  # confirm the process is still alive before we record state.
  sleep 0.5
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "[record-meet] ffmpeg died on startup — see ${STATE_DIR}/${event_id}.ffmpeg.log" >&2
    return 3
  fi
  echo "$pid"  > "$pid_file"
  echo "$file" > "$audio_marker"
  echo "[record-meet] started pid=$pid → $file" >&2
  printf '%s\n' "$file"
}

stop() {
  local event_id="${1:?event_id required}"
  local pid_file="${STATE_DIR}/${event_id}.pid"
  local audio_marker="${STATE_DIR}/${event_id}.file"
  local file=""
  [[ -f "$audio_marker" ]] && file="$(cat "$audio_marker")"

  if [[ ! -f "$pid_file" ]]; then
    echo "[record-meet] no active recording for $event_id" >&2
    [[ -n "$file" ]] && printf '%s\n' "$file"
    return 1
  fi
  local pid; pid="$(cat "$pid_file")"
  if kill -0 "$pid" 2>/dev/null; then
    kill -INT "$pid" 2>/dev/null || true
    for _ in $(seq 1 50); do
      sleep 0.1
      kill -0 "$pid" 2>/dev/null || break
    done
    kill -TERM "$pid" 2>/dev/null || true
  fi
  rm -f "$pid_file" "$audio_marker"
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
