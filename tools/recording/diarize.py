#!/usr/bin/env python3
"""
yCal — speaker diarization splicer.

Reads the system-audio (right) channel WAV from a stereo recording, runs
pyannote.audio speaker diarization, then rewrites a yCal stereo transcript
by replacing [Other] labels with [SPK1]/[SPK2]/… based on the speaker
active at each segment's timestamp.

Why a separate Python process: pyannote.audio needs Python + PyTorch +
~500 MB of model weights. Keeping it out-of-process means the main Electron
app stays Node-only and the venv is purely opt-in. post-meet.sh shells out
to this script when YCAL_DIARIZE_ENABLED=1.

Pinning notes: pyannote 4.x switched to a gated model that requires extra
HF license clicks; PyTorch 2.6+ changed `torch.load` defaults that break
the 3.x checkpoint loader. The yCal venv pins:
  pyannote.audio >=3.1,<4.0
  torch <2.6, torchaudio <2.6
  huggingface_hub <0.30   (newer drops use_auth_token kwarg)
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from pathlib import Path


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
    ap.add_argument("--min-speakers", type=int, default=2)
    ap.add_argument("--max-speakers", type=int, default=12)
    ap.add_argument("--hf-token", default=os.environ.get("HF_TOKEN") or os.environ.get("YCAL_HF_TOKEN"))
    args = ap.parse_args()

    if not args.hf_token:
        print("[diarize] HF token missing (--hf-token / HF_TOKEN / YCAL_HF_TOKEN)", file=sys.stderr)
        return 2

    try:
        from pyannote.audio import Pipeline
        import torch
    except ImportError as e:
        print(f"[diarize] missing dependency: {e}. Run Setup Diarization in yCal.", file=sys.stderr)
        return 3

    print("[diarize] loading pipeline (first run downloads ~500 MB)…", file=sys.stderr, flush=True)
    try:
        pipe = Pipeline.from_pretrained(
            "pyannote/speaker-diarization-3.1",
            use_auth_token=args.hf_token,
        )
    except Exception as e:
        msg = str(e)
        if "gated" in msg.lower() or "403" in msg:
            print(
                "[diarize] HuggingFace returned 403. Accept the model license at:\n"
                "  https://huggingface.co/pyannote/speaker-diarization-3.1\n"
                "  https://huggingface.co/pyannote/segmentation-3.0",
                file=sys.stderr,
            )
        else:
            print(f"[diarize] pipeline load failed: {e}", file=sys.stderr)
        return 4

    if pipe is None:
        print("[diarize] pipeline is None — token likely invalid or missing scope", file=sys.stderr)
        return 4

    device = "mps" if torch.backends.mps.is_available() else "cpu"
    print(f"[diarize] device: {device}", file=sys.stderr, flush=True)
    pipe.to(torch.device(device))

    print(f"[diarize] running on {args.audio}…", file=sys.stderr, flush=True)
    annotation = pipe(
        args.audio,
        min_speakers=args.min_speakers,
        max_speakers=args.max_speakers,
    )

    intervals = [
        (turn.start, turn.end, label)
        for turn, _, label in annotation.itertracks(yield_label=True)
    ]
    intervals.sort(key=lambda r: r[0])
    n_spk = len({i[2] for i in intervals})
    print(f"[diarize] {len(intervals)} turns, {n_spk} speakers detected", file=sys.stderr, flush=True)

    # Compact labels by first-appearance order (SPK1, SPK2, …).
    seen: dict[str, str] = {}
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
