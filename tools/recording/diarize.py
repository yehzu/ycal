#!/usr/bin/env python3
"""
yCal — speaker diarization splicer.

Reads the system-audio (right) channel WAV from a stereo recording, runs
NVIDIA Nemotron-3-Diarization through Hugging Face Transformers, then
rewrites a yCal stereo transcript by replacing [Other] labels with
[SPK1]/[SPK2]/… based on the speaker active at each segment's timestamp.

Why a separate Python process: the model needs Python + PyTorch + ~379 MB
of weights. Keeping it out-of-process means the main Electron app stays
Node-only and the venv is purely opt-in. post-meet.sh shells out to this
script when YCAL_DIARIZE_ENABLED=1.

Why Nemotron rather than pyannote speaker-diarization-community-1 (used
until this change): on a 15-minute recording on Apple Silicon it ran in
~7 s against pyannote's ~57 s, the two agreed on ~90% of speaker time,
and the model is not gated — no Hugging Face token or licence click.
Trade-offs: Transformers supports it only on an unreleased main-branch
commit (pinned in src/main/recorderSetup.ts), and the model has a fixed
8 speaker channels, so a meeting can have at most 8 separated speakers.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from collections import defaultdict
from pathlib import Path

MODEL_ID = "nvidia/Nemotron-3-Diarization"
# Pin the model snapshot as well as the code. The Transformers support is an
# unreleased commit whose config format may still move; an upstream edit to
# the model repo must not be able to break an already-installed venv.
MODEL_REVISION = "f667ed73aee57d40cc39428eb768b4fd87a0a29e"
# The model emits exactly 8 speaker channels, ordered by first arrival, so
# a ninth voice cannot get a channel of its own.
MODEL_MAX_SPEAKERS = 8
# A 10 ms frame counts as speech for a speaker when that speaker's
# probability exceeds this (the model card's default).
SPEECH_THRESHOLD = 0.5
# Phantom-speaker filter. In the trial recording one channel collected 18 s
# of "speech" made entirely of fragments under 2 s (median ~0.3 s): not a
# person, but noise and crosstalk the model parked on a spare channel. The
# quietest real participant had less in total (12 s) yet several turns of
# 2–3 s, so total time alone cannot tell them apart. A channel therefore
# counts as a speaker only when its turns of at least MIN_TURN_S add up to
# at least MIN_SPEAKER_S (the real quiet speaker: ~9 s; the phantom: 0 s).
MIN_TURN_S = 2.0
MIN_SPEAKER_S = 5.0


def parse_transcript(path: Path) -> list[tuple[float, str, str]]:
    out: list[tuple[float, str, str]] = []
    pat = re.compile(r"^\[(\d+):(\d+)\]\s+(Me|Other):\s+(.*)$")
    for line in path.read_text().splitlines():
        m = pat.match(line)
        if not m:
            continue
        mins, secs, spk, txt = m.groups()
        out.append((float(int(mins) * 60 + int(secs)), spk, txt))
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--audio", required=True, help="mono wav of system-audio channel")
    ap.add_argument("--transcript", required=True, help="original [Me]/[Other] transcript")
    ap.add_argument("--out", required=True, help="output diarized transcript path")
    ap.add_argument("--max-speakers", type=int, default=MODEL_MAX_SPEAKERS)
    args = ap.parse_args()

    max_speakers = max(1, min(args.max_speakers, MODEL_MAX_SPEAKERS))
    if max_speakers != args.max_speakers:
        print(f"[diarize] --max-speakers clamped to {max_speakers} (model limit {MODEL_MAX_SPEAKERS})",
              file=sys.stderr)

    # The model is public; nothing here needs to phone home beyond the
    # one-time weight download.
    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")

    try:
        import librosa
        import soundfile as sf
        import torch
        from transformers import AutoModelForAudioFrameClassification, AutoProcessor
    except ImportError as e:
        print(f"[diarize] missing dependency: {e}. Run Setup Diarization in yCal.", file=sys.stderr)
        return 3

    print("[diarize] loading Nemotron-3-Diarization (first run downloads ~379 MB)…",
          file=sys.stderr, flush=True)
    try:
        processor = AutoProcessor.from_pretrained(MODEL_ID, revision=MODEL_REVISION)
        model = AutoModelForAudioFrameClassification.from_pretrained(
            MODEL_ID, revision=MODEL_REVISION, dtype=torch.float32,
        ).eval()
    except Exception as e:
        print(f"[diarize] model load failed: {e}", file=sys.stderr)
        return 4

    # post-meet.sh hands us 16 kHz mono already; convert anyway so a
    # reprocess of an odd file can't feed the model the wrong rate.
    sr = processor.feature_extractor.sampling_rate
    audio, file_sr = sf.read(args.audio, dtype="float32")
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    if file_sr != sr:
        audio = librosa.resample(audio, orig_sr=file_sr, target_sr=sr)

    # MPS first, CPU as the fallback: an op the MPS backend doesn't cover
    # must cost speed, not the speaker labels.
    devices = ["mps", "cpu"] if torch.backends.mps.is_available() else ["cpu"]
    raw: list[dict] | None = None
    for device in devices:
        print(f"[diarize] running on {args.audio} (device: {device})…", file=sys.stderr, flush=True)
        try:
            model.to(device)
            inputs = processor(audio, sampling_rate=sr).to(device, dtype=model.dtype)
            with torch.inference_mode():
                logits = model(**inputs).logits  # (1, frames, 8), one frame per 10 ms
            mask = inputs.get("attention_mask")
            raw = processor.extract_speaker_dict(
                logits.cpu(),
                mask.cpu() if mask is not None else None,
                threshold=SPEECH_THRESHOLD,
            )[0]
            break
        except Exception as e:
            print(f"[diarize] inference on {device} failed: {e}", file=sys.stderr, flush=True)
    if raw is None:
        return 5

    segs = [(s["Start"], s["End"], s["Speaker"]) for s in raw if s["End"] > s["Start"]]
    sustained: dict[int, float] = defaultdict(float)
    for s, e, spk in segs:
        if e - s >= MIN_TURN_S:
            sustained[spk] += e - s
    keep = {spk for spk, t in sustained.items() if t >= MIN_SPEAKER_S}
    if len(keep) > max_speakers:
        keep = set(sorted(keep, key=lambda spk: -sustained[spk])[:max_speakers])
    dropped = sorted({spk for _, _, spk in segs} - keep)

    intervals = sorted((s, e, spk) for s, e, spk in segs if spk in keep)
    n_spk = len({i[2] for i in intervals})
    print(
        f"[diarize] {len(intervals)} turns, {n_spk} speakers detected"
        f" ({len(dropped)} fragment-only channel(s) dropped)",
        file=sys.stderr, flush=True,
    )

    # Compact labels by first-appearance order (SPK1, SPK2, …).
    seen: dict[int, str] = {}
    for _, _, lab in intervals:
        if lab not in seen:
            seen[lab] = f"SPK{len(seen) + 1}"

    def label_at(t: float) -> str | None:
        best: str | None = None
        best_dist = float("inf")
        for s, e, lab in intervals:
            if s <= t <= e:
                return seen[lab]
            d = min(abs(t - s), abs(t - e))
            if d < best_dist and d <= 2.0:
                best_dist = d
                best = seen[lab]
        return best

    lines = parse_transcript(Path(args.transcript))
    out_lines: list[str] = []
    upgraded = 0
    unmatched = 0
    for t, spk, txt in lines:
        if spk == "Me":
            out_lines.append(f"[{int(t // 60):02d}:{int(t % 60):02d}] Me: {txt}")
            continue
        lab = label_at(t)
        if lab:
            upgraded += 1
        else:
            unmatched += 1
            lab = "Other"
        out_lines.append(f"[{int(t // 60):02d}:{int(t % 60):02d}] {lab}: {txt}")

    Path(args.out).write_text("\n".join(out_lines) + "\n")
    print(
        f"[diarize] upgraded {upgraded} [Other] lines, "
        f"{unmatched} unmatched (kept as [Other])",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
