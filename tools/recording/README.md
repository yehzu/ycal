# yCal meeting recording — DIY pipeline

Auto-records video meetings on macOS 13+, transcribes via whisper.cpp,
and summarises via the `claude` CLI. Audio stays on the Mac; only the
finished transcript is sent to the Claude API for the meeting note.

## How it fits together

```
yCal main process
  │  (event start, has meetUrl, not declined, "auto-record" setting on)
  ▼
~/.ycal/record-meet.sh start <event_id> "<title>" <max_seconds>
  ├─ ~/.ycal/bin/coreaudio-tap     (ScreenCaptureKit → 16 kHz mono PCM → FIFO)
  └─ ffmpeg                        (FIFO + default mic → amix → m4a)
     → ~/Recordings/yCal/2026-05-19_1400__sync__<id>.m4a

  (event.end reached, or you stop manually)
  ▼
~/.ycal/record-meet.sh stop <event_id>
  ├─ SIGINT ffmpeg  (flush moov atom — without this the m4a is unseekable)
  └─ SIGTERM coreaudio-tap

~/.ycal/post-meet.sh <audio>      (kicked off automatically by yCal)
  ├─ ffmpeg → 16 kHz mono wav
  ├─ whisper-cli  → <audio>.transcript.txt
  └─ claude -p    → <audio>.summary.md
```

`coreaudio-tap` is a small Mach-O helper from
[`CJHwong/lazy-take-notes`](https://github.com/CJHwong/lazy-take-notes)
(MIT-licensed; see `build/native/ATTRIBUTION.md`) that exposes Apple's
ScreenCaptureKit audio-only mode as a stdout pipe. That's what lets us
skip BlackHole and the Multi-Output Device dance — macOS 13+ ships
everything we need.

## One-time setup

1. **Install transcription deps** (audio is built-in via ScreenCaptureKit):
   ```sh
   brew install whisper-cpp ffmpeg
   ```

2. **Download a whisper model** (~1.5 GB; multilingual)
   ```sh
   mkdir -p ~/.ycal/models
   curl -L --fail \
     -o ~/.ycal/models/ggml-large-v3-turbo.bin \
     https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin
   ```
   Swap models with `YCAL_WHISPER_MODEL` if you prefer `medium` or
   `large-v3` over the smaller turbo variant. Turbo handles 中英混雜 well.

3. **Install scripts + helper**
   ```sh
   tools/recording/install.sh
   ```
   Copies `record-meet.sh`, `post-meet.sh`, and the `coreaudio-tap`
   binary into `~/.ycal/` and verifies everything else is in place.

4. **First-run permissions** — when yCal (or you, from Terminal) starts
   the first recording, macOS prompts twice:
   - **Screen Recording** — needed to access ScreenCaptureKit's audio
     mode. Grant it to *yCal* (or to Terminal if you're testing the
     scripts directly).
   - **Microphone** — for your voice via ffmpeg.
   Both are one-time; toggle later in **System Settings → Privacy & Security**.

That's it. No BlackHole, no Audio MIDI Setup, no switching system output
before every meeting.

## Manual smoke test

```sh
~/.ycal/record-meet.sh start test "smoke" 60
# Play some audio in another app + talk into your mic for ~10 seconds.
~/.ycal/record-meet.sh stop test
# → prints the m4a path. Play it back; you should hear both sources.

~/.ycal/post-meet.sh ~/Recordings/yCal/<file>.m4a "Smoke test"
# Produces .transcript.txt and .summary.md alongside the .m4a.
```

## Env knobs

| Var                  | Default                                  | Purpose                                      |
| -------------------- | ---------------------------------------- | -------------------------------------------- |
| `YCAL_RECORDING_DIR` | `~/Recordings/yCal`                      | Where m4a + transcript + summary land        |
| `YCAL_MIC_NAME`      | first device in ffmpeg's audio list      | Mic selection (substring match)              |
| `YCAL_COREAUDIO_TAP` | `~/.ycal/bin/coreaudio-tap`              | Path to the ScreenCaptureKit helper          |
| `YCAL_WHISPER_MODEL` | `~/.ycal/models/ggml-large-v3-turbo.bin` | Whisper ggml model path                      |
| `YCAL_WHISPER_BIN`   | `whisper-cli` (on PATH)                  | Alternative whisper binary                   |
| `YCAL_CLAUDE_BIN`    | `claude` (on PATH)                       | Alternative claude binary (cmux fork OK)     |
| `YCAL_SUMMARY_PROMPT`| (built-in generic meeting-notes prompt)                  | Override prompt file                         |

## Troubleshooting

- **"coreaudio-tap died on startup"** — almost always means Screen
  Recording permission is missing or revoked. Check **System Settings
  → Privacy & Security → Screen Recording** and re-enable yCal (or
  Terminal). After granting, fully quit + relaunch yCal — macOS doesn't
  surface fresh permission to a running process.
- **"ffmpeg died on startup"** — check `~/.ycal/recordings/<id>.ffmpeg.log`.
  Usually mic permission wasn't granted, or the device index shifted
  because of a USB unplug.
- **Silent recording** — confirm the m4a has audio at all. If both sides
  are silent, screen-recording permission is granted but the meeting app
  may be using a route that ScreenCaptureKit can't see (rare, mostly old
  conferencing apps using non-CoreAudio paths).
- **Empty transcript** — re-listen to the .m4a; if you can hear it, the
  whisper model may not be loaded. Verify with `whisper-cli -m
  ~/.ycal/models/ggml-large-v3-turbo.bin --help` (should not error).
- **Claude summary fails** — `~/.ycal/recordings/<id>.summary.log`
  has the stderr from the CLI. If you're rate-limited, drop to a faster
  model via a `YCAL_CLAUDE_BIN` wrapper script.
