#!/usr/bin/env bash
# post-meet.sh — transcribe + summarize a recorded meeting.
#
# Reads an .m4a recording, runs whisper-cli to produce a transcript, then
# feeds the transcript to `claude -p` with a generic meeting-notes prompt
# a markdown meeting note. All artefacts land next to the audio file.
#
# Usage: post-meet.sh <audio-file> [title]
#
# Outputs:
#   <base>.transcript.txt
#   <base>.summary.md
#
# Env overrides:
#   YCAL_WHISPER_MODEL   path to ggml model (default ~/.ycal/models/ggml-large-v3-turbo.bin)
#   YCAL_WHISPER_BIN     whisper-cli binary (default: whisper-cli on PATH)
#   YCAL_CLAUDE_BIN      claude binary (default: claude on PATH)
#   YCAL_SUMMARY_PROMPT  override the prompt template; reads from this file

set -euo pipefail

audio="${1:?audio file required}"
title="${2:-$(basename "$audio" .m4a)}"

if [[ ! -f "$audio" ]]; then
  echo "[post-meet] missing $audio" >&2; exit 1
fi
base="${audio%.*}"
transcript="${base}.transcript.txt"
summary="${base}.summary.md"

MODEL="${YCAL_WHISPER_MODEL:-${HOME}/.ycal/models/ggml-large-v3-turbo.bin}"
WHISPER_BIN="${YCAL_WHISPER_BIN:-whisper-cli}"
CLAUDE_BIN="${YCAL_CLAUDE_BIN:-claude}"

command -v "$WHISPER_BIN" >/dev/null 2>&1 \
  || { echo "[post-meet] $WHISPER_BIN not on PATH (brew install whisper-cpp)" >&2; exit 2; }
command -v "$CLAUDE_BIN" >/dev/null 2>&1 \
  || { echo "[post-meet] $CLAUDE_BIN not on PATH (install Claude Code)" >&2; exit 2; }
[[ -f "$MODEL" ]] \
  || { echo "[post-meet] whisper model not found at $MODEL" >&2; exit 2; }

# Whisper needs WAV (16kHz mono is the canonical input). m4a → wav via ffmpeg
# temp file. -ar 16000 -ac 1 = whisper's expected shape.
work="$(mktemp -t ycal-whisper).wav"
trap 'rm -f "$work"' EXIT
echo "[post-meet] decoding to wav…" >&2
ffmpeg -hide_banner -loglevel error -y -i "$audio" -ar 16000 -ac 1 "$work"

echo "[post-meet] transcribing → $transcript" >&2
# -of <base> means whisper-cli writes <base>.txt (because -otxt). We feed
# it ${base}.transcript so the output lands at ${base}.transcript.txt.
# -l auto lets it pick the language per segment (handles 中英混雜).
"$WHISPER_BIN" -m "$MODEL" -l auto -t 8 -otxt -of "${base}.transcript" "$work" >&2

if [[ ! -s "$transcript" ]]; then
  echo "[post-meet] transcript empty — bailing" >&2; exit 3
fi

# === Summarization ==========================================================
# Note on the read -d '' pattern: macOS ships bash 3.2, whose parser
# chokes on $(cat <<'TMPL' …) when the heredoc body contains apostrophes
# (it loses track of quote nesting inside command-substitution). `read -d
# '' var <<'TMPL' … TMPL` avoids the nested substitution. The trailing
# `|| true` is required because `read` exits 1 when it hits EOF without
# finding the `\0` delimiter — which is always the case for a heredoc.
if [[ -n "${YCAL_SUMMARY_PROMPT:-}" && -f "$YCAL_SUMMARY_PROMPT" ]]; then
  prompt_template="$(cat "$YCAL_SUMMARY_PROMPT")"
else
  read -r -d '' prompt_template <<'TMPL' || true
You are an executive assistant turning a raw meeting transcript into a concise note for the participant who recorded it.

Title: __TITLE__

Transcript:
```
__TRANSCRIPT__
```

Write meeting notes in markdown. Match the language used in the transcript (mixed Chinese/English → favour Chinese). Include only sections that have something to say — omit the heading otherwise.

## TL;DR
2–3 sentences. What was the meeting about, what was decided.

## Decisions
What was decided, by whom (if clear), and rationale.

## Action items
Markdown table: | Owner | What | Due |. Only items that are explicit or strongly implied. Don't invent owners or dates.

## Open questions
Things raised but unresolved.

## Follow-ups for me
What the participant should do or think about next. Be concrete.

Constraints: be concise, don't editorialise, don't fabricate. If the transcript is too short or noisy to summarise, say so in a single line and stop.
TMPL
fi

# Hand-fold the template — simpler than escaping shell-special chars in the
# transcript through printf/$(…). The transcript can contain back-ticks and $.
{
  printf '%s' "$prompt_template" \
    | awk -v t="$title" '{gsub(/__TITLE__/, t); print}' \
    | awk -v f="$transcript" '
        /__TRANSCRIPT__/ {
          while ((getline line < f) > 0) print line
          close(f); next
        }
        { print }
      '
} > "${base}.summary.prompt.tmp"

echo "[post-meet] summarising via $CLAUDE_BIN → $summary" >&2
if ! "$CLAUDE_BIN" -p < "${base}.summary.prompt.tmp" > "$summary" 2>"${base}.summary.log"; then
  echo "[post-meet] claude failed — see ${base}.summary.log" >&2
  rm -f "${base}.summary.prompt.tmp"
  exit 4
fi
rm -f "${base}.summary.prompt.tmp"

if [[ ! -s "$summary" ]]; then
  echo "[post-meet] summary empty — see ${base}.summary.log" >&2; exit 5
fi

echo "[post-meet] done." >&2
printf '%s\n' "$summary"
