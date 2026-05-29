#!/usr/bin/env bash
# record-meet.sh — start/stop a meeting recording.
#
# System audio is captured via Apple's ScreenCaptureKit (no BlackHole, no
# Multi-Output Device). The bundled `coreaudio-tap` helper streams 16 kHz
# mono float32 PCM to stdout; we pipe it through a FIFO to ffmpeg, which
# joins it with the microphone into a STEREO m4a in ~/Recordings/yCal/ —
# left channel = mic (you), right channel = system audio (everyone else).
# post-meet.sh exploits this for speaker-aware transcription. Pre-stereo
# recordings (mono) still transcribe correctly via the legacy single-pass
# path.
#
# The mic leg has two modes:
#   * raw (default) — ffmpeg opens the mic directly via avfoundation.
#   * VPIO (YCAL_MIC_VPIO=1) — the mic is captured by the bundled
#     `voiceproc-mic` helper through Apple's Voice-Processing I/O (AEC /
#     noise-suppression / AGC) and streamed as 48 kHz mono float32 PCM to
#     a second FIFO. This echo-cancels speaker bleed so an open mic with no
#     headphones doesn't leak the meeting onto the "you" channel. Falls
#     back to raw automatically if the helper binary is missing.
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
#   YCAL_MIC_NAME          substring match for mic. In raw mode selects the
#                          avfoundation device (default: first audio device);
#                          in VPIO mode pins voiceproc-mic's input device.
#   YCAL_MIC_VPIO          set to 1 to capture the mic via voiceproc-mic
#                          (Apple Voice Processing) instead of raw avfoundation.
#   YCAL_COREAUDIO_TAP     path to the coreaudio-tap binary
#                          (default: ~/.ycal/bin/coreaudio-tap)
#   YCAL_VPIO_BIN          path to the voiceproc-mic binary
#                          (default: ~/.ycal/bin/voiceproc-mic)
#
# State (PIDs + audio path) lives in ~/.ycal/recordings/ keyed by event id.

set -euo pipefail

YCAL_DIR="${HOME}/.ycal"
STATE_DIR="${YCAL_DIR}/recordings"
OUT_DIR="${YCAL_RECORDING_DIR:-${HOME}/Recordings/yCal}"
TAP_BIN="${YCAL_COREAUDIO_TAP:-${YCAL_DIR}/bin/coreaudio-tap}"
# Voice-Processing mic helper (Apple AEC/NS/AGC). Used for the mic leg
# instead of raw avfoundation when YCAL_MIC_VPIO=1 and the binary exists —
# cancels speaker bleed so an open mic (no headphones) doesn't pollute the
# "you" channel. Falls back to raw avfoundation otherwise.
VPIO_BIN="${YCAL_VPIO_BIN:-${YCAL_DIR}/bin/voiceproc-mic}"
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

# Background watcher: polls the coreaudio-tap log; if we see the
# restart counter exhaust (10/10) AND subsequent dead-audio events
# (i.e., the tap is permanently gone, not just transiently dying), SIGINT
# ffmpeg so it flushes the moov atom cleanly. The post-stop silence
# gate in meetRecorder.ts then marks the recording as failed instead of
# running 5min of whisper on hallucination-bait. Exits when ffmpeg is
# gone (recording ended for any reason) or when the parent script
# explicitly SIGTERMs it.
watch_tap_health() {
  local tap_log="$1"
  local ffmpeg_pid="$2"
  local marker_file="$3"
  # Trap so a SIGTERM from stop() exits the loop instead of leaving an
  # orphan polling the log after the recording is gone.
  trap 'exit 0' TERM INT
  while kill -0 "$ffmpeg_pid" 2>/dev/null; do
    sleep 10
    [[ -f "$tap_log" ]] || continue
    # Has the restart counter exhausted? `restart 10/10` is the LAST
    # retry attempt in coreaudio-tap's loop.
    grep -q "restart 10/10" "$tap_log" 2>/dev/null || continue
    # After that, count dead-audio events occurring AFTER the 10/10
    # restart line. A single one could be transient (the tap recovered
    # below the threshold); three across our 30s+ window means it's
    # genuinely gone.
    local exhausted_line dead_count
    exhausted_line=$(grep -n "restart 10/10" "$tap_log" | tail -1 | cut -d: -f1)
    dead_count=$(awk -v start="$exhausted_line" 'NR > start && /dead audio/' "$tap_log" | wc -l | tr -d ' ')
    if [[ "${dead_count:-0}" -ge 3 ]]; then
      echo "[record-meet] tap permanently dead (restart 10/10 exhausted + ${dead_count} subsequent dead-audio events) — SIGINT ffmpeg" >&2
      printf 'tap-exhausted\n' > "$marker_file" 2>/dev/null || true
      kill -INT "$ffmpeg_pid" 2>/dev/null || true
      exit 0
    fi
  done
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

  # Decide the mic capture path. VPIO (Apple Voice Processing) routes the
  # mic through a helper that echo-cancels speaker bleed; raw avfoundation
  # opens the hardware device directly. We resolve the raw device index up
  # front only when we'll actually use it.
  local use_vpio=0
  if [[ "${YCAL_MIC_VPIO:-}" == "1" && -x "$VPIO_BIN" ]]; then
    use_vpio=1
  fi
  local mic=""
  if [[ $use_vpio -eq 0 ]]; then
    if [[ -n "${YCAL_MIC_NAME:-}" ]]; then
      mic="$(device_index "$YCAL_MIC_NAME")"
    else
      mic="$(first_mic_index)"
    fi
    if [[ -z "$mic" ]]; then
      echo "[record-meet] no microphone device found" >&2
      return 2
    fi
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

  # Mic leg. VPIO path: a second FIFO fed by voiceproc-mic (48 kHz mono
  # float32, already echo-cancelled). Raw path: avfoundation opens the
  # hardware device directly. mic_input holds the ffmpeg args for input #1.
  local mic_fifo="" vpio_pid="" mic_input=()
  if [[ $use_vpio -eq 1 ]]; then
    mic_fifo="${STATE_DIR}/${event_id}.mic.fifo"
    rm -f "$mic_fifo"; mkfifo "$mic_fifo"
    # YCAL_MIC_NAME (if set) is read by the helper to pin the device.
    nohup "$VPIO_BIN" > "$mic_fifo" 2> "${STATE_DIR}/${event_id}.vpio.log" &
    vpio_pid=$!
    mic_input=(-f f32le -ar 48000 -ac 1 -i "$mic_fifo")
  else
    mic_input=(-f avfoundation -i ":${mic}")
  fi

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
  # 48 kHz stereo). We keep the two sources on SEPARATE channels of a
  # stereo output (L=mic, R=system) — post-meet.sh exploits this for
  # speaker-aware transcription (you on the mic, everyone else on the
  # system feed). Older recordings recorded as mono via amix still
  # transcribe fine; post-meet.sh detects channel count.
  #
  # Resample both inputs to 48 kHz mono first, then `join` into stereo
  # so the AAC encoder gets a clean stereo signal. dropout_transition
  # isn't relevant to `join` (no auto-ducking).
  nohup ffmpeg -hide_banner -y \
    -f f32le -ar 16000 -ac 1 -i "$fifo" \
    "${mic_input[@]}" \
    -filter_complex "[0:a]aresample=48000,aformat=channel_layouts=mono[sys];[1:a]aresample=48000,aformat=channel_layouts=mono[mic];[mic][sys]join=inputs=2:channel_layout=stereo[a]" \
    -map "[a]" -ar 48000 -ac 2 -c:a aac -b:a 192k -movflags +faststart \
    "${ts_arg[@]}" \
    "$file" \
    > "${STATE_DIR}/${event_id}.ffmpeg.log" 2>&1 &
  local pid=$!

  # ffmpeg fails fast if mic permission isn't granted, or if the FIFO
  # producer never opens. Give the group a short grace period; if any
  # dies during boot, surface it now instead of producing an empty m4a.
  sleep 0.8
  if ! kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$tap_pid"  2>/dev/null || true
    kill -TERM "$keep_pid" 2>/dev/null || true
    [[ -n "$vpio_pid" ]] && kill -TERM "$vpio_pid" 2>/dev/null || true
    rm -f "$fifo" "$stdin_fifo" "$mic_fifo"
    echo "[record-meet] ffmpeg died on startup — see ${STATE_DIR}/${event_id}.ffmpeg.log" >&2
    return 3
  fi
  if ! kill -0 "$tap_pid" 2>/dev/null; then
    kill -INT  "$pid"      2>/dev/null || true
    kill -TERM "$keep_pid" 2>/dev/null || true
    [[ -n "$vpio_pid" ]] && kill -TERM "$vpio_pid" 2>/dev/null || true
    rm -f "$fifo" "$stdin_fifo" "$mic_fifo"
    echo "[record-meet] coreaudio-tap died on startup — see ${STATE_DIR}/${event_id}.tap.log" >&2
    echo "                Likely: Screen Recording permission not granted." >&2
    return 3
  fi
  if [[ $use_vpio -eq 1 ]] && ! kill -0 "$vpio_pid" 2>/dev/null; then
    kill -INT  "$pid"      2>/dev/null || true
    kill -TERM "$tap_pid"  2>/dev/null || true
    kill -TERM "$keep_pid" 2>/dev/null || true
    rm -f "$fifo" "$stdin_fifo" "$mic_fifo"
    echo "[record-meet] voiceproc-mic died on startup — see ${STATE_DIR}/${event_id}.vpio.log" >&2
    echo "                Likely: Microphone permission not granted, or no input device." >&2
    return 3
  fi

  echo "$pid"      > "$pid_file"
  echo "$tap_pid"  > "$tap_pid_file"
  echo "$keep_pid" > "${STATE_DIR}/${event_id}.keep.pid"
  [[ -n "$vpio_pid" ]] && echo "$vpio_pid" > "${STATE_DIR}/${event_id}.vpio.pid"
  echo "$file"     > "$audio_marker"

  # Spawn the tap-health watcher AFTER the trio is confirmed alive — it
  # SIGINTs ffmpeg if it sees the tap exhaust its 10-retry budget AND
  # keep dying. The marker file lets meetRecorder distinguish "tap
  # permanently died" failures from generic silent-recording failures
  # when it surfaces the error in the popover.
  local tap_marker="${STATE_DIR}/${event_id}.tap-exhausted"
  rm -f "$tap_marker"
  nohup bash -c "$(declare -f watch_tap_health); watch_tap_health '${STATE_DIR}/${event_id}.tap.log' '$pid' '$tap_marker'" \
    > /dev/null 2>&1 &
  local watch_pid=$!
  echo "$watch_pid" > "${STATE_DIR}/${event_id}.watch.pid"

  echo "[record-meet] started ffmpeg=$pid tap=$tap_pid keep=$keep_pid watch=$watch_pid${vpio_pid:+ vpio=$vpio_pid} → $file" >&2
  printf '%s\n' "$file"
}

stop() {
  local event_id="${1:?event_id required}"
  local pid_file="${STATE_DIR}/${event_id}.pid"
  local tap_pid_file="${STATE_DIR}/${event_id}.tap.pid"
  local keep_pid_file="${STATE_DIR}/${event_id}.keep.pid"
  local watch_pid_file="${STATE_DIR}/${event_id}.watch.pid"
  local vpio_pid_file="${STATE_DIR}/${event_id}.vpio.pid"
  local audio_marker="${STATE_DIR}/${event_id}.file"
  local fifo="${STATE_DIR}/${event_id}.fifo"
  local stdin_fifo="${STATE_DIR}/${event_id}.stdin"
  local mic_fifo="${STATE_DIR}/${event_id}.mic.fifo"
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
  # Then the VPIO mic helper (when this recording used it). It also exits
  # on its own once ffmpeg closes the mic FIFO (broken pipe), but SIGTERM
  # makes teardown deterministic. Its signal handler stops the engine
  # cleanly.
  if [[ -f "$vpio_pid_file" ]]; then
    local vpio_pid; vpio_pid="$(cat "$vpio_pid_file")"
    if kill -0 "$vpio_pid" 2>/dev/null; then
      kill -TERM "$vpio_pid" 2>/dev/null || true
      for _ in $(seq 1 20); do
        sleep 0.1; kill -0 "$vpio_pid" 2>/dev/null || break
      done
      kill -KILL "$vpio_pid" 2>/dev/null || true
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
  # And the tap-health watcher — exits on its own when ffmpeg dies, but
  # SIGTERM ensures it doesn't outlive an unusual shutdown path.
  if [[ -f "$watch_pid_file" ]]; then
    local watch_pid; watch_pid="$(cat "$watch_pid_file")"
    kill -TERM "$watch_pid" 2>/dev/null || true
  fi
  rm -f "$pid_file" "$tap_pid_file" "$keep_pid_file" "$watch_pid_file" "$vpio_pid_file" "$audio_marker" "$fifo" "$stdin_fifo" "$mic_fifo"
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
