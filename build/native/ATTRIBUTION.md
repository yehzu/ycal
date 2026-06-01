# Bundled native binaries

Both binaries here are **first-party** (built from `native/<name>/main.swift`
via that dir's `build.sh`). They're committed pre-built — universal
arm64+x86_64 — so the release pipeline doesn't need a `swift build` step and
stays independent of the maintainer's Xcode version. Re-run the matching
`build.sh` after editing the source.

## coreaudio-tap

Captures system audio via Apple's `ScreenCaptureKit` (no BlackHole, no
Multi-Output Device) and writes raw float32 mono PCM @16 kHz to stdout; yCal
pipes it into ffmpeg alongside the mic to record both sides of a meeting.

Built to be **resilient**: when macOS stops the SCStream "by the system"
(e.g. when a participant starts screen-sharing), it recreates the stream and
keeps emitting a steady, silence-filled 16 kHz stream so the recording never
freezes or desyncs — one continuous file across screen-shares.

Requires Screen Recording permission on the host Mac (see
`tools/recording/README.md`). macOS 13+.

> **History:** earlier yCal releases vendored a pre-built `coreaudio-tap`
> from [`CJHwong/lazy-take-notes`](https://github.com/CJHwong/lazy-take-notes)
> (MIT, © Hoss Chen) — credited here as the original inspiration for the
> ScreenCaptureKit approach. It was replaced by this first-party rewrite on
> 2026-06-01 to add the screen-share resilience the vendored binary lacked.

## voiceproc-mic

Captures the microphone through Apple's Voice-Processing I/O (the AEC /
noise-suppression / AGC stack FaceTime & Meet use) and writes raw float32
mono PCM @48 kHz to stdout; yCal uses it as the optional echo-cancelled mic
leg so an open mic next to speakers doesn't leak the meeting onto the "you"
channel. macOS 12+.
