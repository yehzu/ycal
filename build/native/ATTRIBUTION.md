# Third-party bundled binaries

## coreaudio-tap

Universal macOS binary (arm64 + x86_64) that captures system audio output
via Apple's `ScreenCaptureKit` and writes raw float32 mono PCM at 16 kHz
to stdout. yCal pipes it into ffmpeg alongside the microphone input so we
can record both sides of a video meeting without installing a virtual
audio driver (BlackHole) or wiring up a Multi-Output Device.

Replacing it requires Screen Recording permission on the host Mac — see
`tools/recording/README.md`.

**Source:** [`CJHwong/lazy-take-notes`](https://github.com/CJHwong/lazy-take-notes)
**Vendored from:** commit `25b8931` (`src/lazy_take_notes/_native/bin/coreaudio-tap`)
**Vendored at:** 2026-05-19
**Vendored binary SHA-256:** `5ef437ff3dbb1643bcf7654b9246ed0e8d99f4eaa31f37bb775167f90ffbd1a5`
**License:** MIT (per `pyproject.toml` and README in the upstream repo)
**Author:** Hoss Chen (CJHwong@gmail.com)

### Why we vendor pre-built rather than build from source

The Swift source (~336 lines, `native/coreaudio_tap/Sources/main.swift`
upstream) does one focused thing and rarely changes. Vendoring the
already-universal binary saves us a `swift build` step in the release
pipeline, and keeps the yCal release flow independent of which Xcode
version the maintainer's Mac happens to have installed. To refresh, pull
a newer prebuilt from upstream + update the SHA above.

### License notice (MIT)

> MIT License
>
> Permission is hereby granted, free of charge, to any person obtaining a
> copy of this software and associated documentation files (the "Software"),
> to deal in the Software without restriction, including without limitation
> the rights to use, copy, modify, merge, publish, distribute, sublicense,
> and/or sell copies of the Software, and to permit persons to whom the
> Software is furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in
> all copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND…
