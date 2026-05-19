# yCal meeting recording — DIY pipeline

Auto-records Google Meet sessions (system audio + your mic), transcribes
via whisper.cpp, and summarises via the `claude` CLI. Everything runs
locally — no third-party SaaS, no bot joining the room.

## How it fits together

```
yCal main process
  │
  │  (event start, has meetUrl, not declined, setting "auto-record" on)
  ▼
~/.ycal/record-meet.sh start <event_id> "<title>"
  └─ ffmpeg captures BlackHole 2ch + your mic
     → ~/Recordings/yCal/2026-05-19_1400__weekly-sync__<id>.m4a
     state: ~/.ycal/recordings/<event_id>.pid + .file

  (event.end reached, or you stop manually)
  ▼
~/.ycal/record-meet.sh stop <event_id>   # SIGINT ffmpeg, flushes m4a
  ▼
~/.ycal/post-meet.sh <audio>             # background
  ├─ ffmpeg → 16kHz mono wav
  ├─ whisper-cli  → <audio>.transcript.txt
  └─ claude -p    → <audio>.summary.md
```

Scripts live in `tools/recording/` (source of truth) and are copied to
`~/.ycal/` by `install.sh` so yCal can spawn them without bundling them
inside the Electron app.

## One-time setup

1. **Install deps**
   ```sh
   brew install whisper-cpp ffmpeg
   brew install --cask blackhole-2ch
   ```
   BlackHole's installer asks for sudo (Touch ID is fine). It's a modern,
   user-space audio driver — no kext, no system-extension permission grant.

2. **Download a whisper model** (~1.5 GB; only needed once)
   ```sh
   curl -L --fail \
     -o ~/.ycal/models/ggml-large-v3-turbo.bin \
     https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin
   ```
   `large-v3-turbo` is the best multilingual model for the size — handles
   中英混雜 cleanly. Swap with `YCAL_WHISPER_MODEL` env if you prefer
   `medium` or `large-v3`.

3. **Configure a Multi-Output Device** so you can both hear AND record
   the meeting audio:
   - Open **Audio MIDI Setup** (Spotlight → "Audio MIDI").
   - Click `+` (bottom-left) → **Create Multi-Output Device**.
   - Tick *MacBook Pro Speakers* (or your headphones) AND *BlackHole 2ch*.
     Master device = your speakers/headphones; drift-correct = on for
     BlackHole.
   - Rename it `yCal Multi-Output` for clarity.
   - When you join a Meet: in **System Settings → Sound → Output** (or
     right-click the menubar volume icon) select `yCal Multi-Output`.
     Audio plays through your speakers AND lands in BlackHole, which is
     what ffmpeg records.

4. **Install the scripts**
   ```sh
   tools/recording/install.sh
   ```
   Confirms all deps and copies the scripts into `~/.ycal/`.

5. **Grant mic permission** — first time yCal runs `record-meet.sh`,
   macOS asks for mic access on behalf of yCal. Accept.

## Manual smoke test (before trusting it on a real meeting)

```sh
# Start a 10s test, with the Multi-Output device selected and some music
# playing in another app:
~/.ycal/record-meet.sh start test "smoke"
sleep 10
~/.ycal/record-meet.sh stop test
# → echoes the audio file path. Play it back; you should hear both
#   the music (from BlackHole) and your voice (from the mic).
```

Then transcribe + summarise:
```sh
~/.ycal/post-meet.sh ~/Recordings/yCal/<file>.m4a "Smoke test"
# Produces .transcript.txt and .summary.md alongside.
```

## Env knobs

| Var                  | Default                              | Purpose                                    |
| -------------------- | ------------------------------------ | ------------------------------------------ |
| `YCAL_RECORDING_DIR` | `~/Recordings/yCal`                  | Where m4a/transcript/summary land          |
| `YCAL_MIC_NAME`      | first non-BlackHole audio device     | Microphone selection (substring match)     |
| `YCAL_BH_NAME`       | `BlackHole`                          | Virtual device name fragment               |
| `YCAL_WHISPER_MODEL` | `~/.ycal/models/ggml-large-v3-turbo.bin` | Whisper ggml model path                    |
| `YCAL_WHISPER_BIN`   | `whisper-cli` (on PATH)              | Alternative whisper binary                 |
| `YCAL_CLAUDE_BIN`    | `claude` (on PATH)                   | Alternative claude binary (cmux fork OK)   |
| `YCAL_SUMMARY_PROMPT`| (built-in generic meeting-notes prompt)              | Override prompt file                       |

## Troubleshooting

- **"BlackHole audio device not found"** — re-run `brew install --cask
  blackhole-2ch`, then sign out + back in (macOS sometimes needs a
  session restart to pick up new audio drivers).
- **`ffmpeg died on startup`** — check `~/.ycal/recordings/<id>.ffmpeg.log`.
  Usually means mic permission wasn't granted (first run only) or the
  device index changed because you plugged/unplugged a USB mic.
- **Transcript is empty** — confirm the recording isn't silent. Re-listen
  to the .m4a; if you can't hear the meeting in it, your Multi-Output
  Device probably isn't routing system audio to BlackHole.
- **Claude summary fails** — `~/.ycal/recordings/<id>.summary.log` has the
  stderr from the CLI. If you're on a metered plan, drop to `claude -p`
  with `--model haiku` via `YCAL_CLAUDE_BIN` wrapper.
