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
#   YCAL_WHISPER_MODEL     path to ggml model (default ~/.ycal/models/ggml-large-v3-turbo.bin)
#   YCAL_WHISPER_BIN       whisper-cli binary (default: whisper-cli on PATH)
#   YCAL_CLAUDE_BIN        claude binary (default: claude on PATH)
#   YCAL_SUMMARY_PROMPT    override the prompt template; reads from this file
#   YCAL_WHISPER_PROMPT    file whose contents become whisper-cli --prompt.
#                          Used by yCal's glossary feature to bias the decoder
#                          toward known names + terms. Optional.
#   YCAL_TRANSCRIPT_FILTER JSONL file of substitution rules applied to the
#                          raw transcript before it's written to disk. Each
#                          line: {"from": "...", "to": "...", "caseSensitive": bool}
#                          Optional.

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
#
# When yCal has a glossary, $YCAL_WHISPER_PROMPT points at a small text
# file whose contents we feed to whisper-cli's --prompt as an initial-
# decoder hint. Whisper.cpp has a ~224-token soft cap; the dispatcher
# trims to that before writing the file. We DO NOT pass --prompt when
# the variable is unset or the file is empty/missing — older whisper-cli
# builds choke on a literal empty string.
whisper_args=(-m "$MODEL" -l auto -t 8 -otxt -of "${base}.transcript")
if [[ -n "${YCAL_WHISPER_PROMPT:-}" && -s "${YCAL_WHISPER_PROMPT:-/dev/null}" ]]; then
  whisper_prompt_body="$(cat "$YCAL_WHISPER_PROMPT")"
  if [[ -n "$whisper_prompt_body" ]]; then
    whisper_args+=(--prompt "$whisper_prompt_body")
    echo "[post-meet] using whisper prompt ($(wc -c <"$YCAL_WHISPER_PROMPT") bytes)" >&2
  fi
fi
"$WHISPER_BIN" "${whisper_args[@]}" "$work" >&2

if [[ ! -s "$transcript" ]]; then
  echo "[post-meet] transcript empty — bailing" >&2; exit 3
fi

# === Substitution pass ======================================================
# When the dispatcher supplied a substitution file, run each rule against
# the raw transcript in order. ASCII patterns get word-boundary matching
# so "Sean → Shawn" doesn't catch "Seanette"; non-ASCII (Chinese, etc.)
# uses literal substring matching since \b is meaningless there. Uses
# Python 3 (ships with macOS); failure here is non-fatal — we keep the
# unfiltered transcript.
if [[ -n "${YCAL_TRANSCRIPT_FILTER:-}" && -s "${YCAL_TRANSCRIPT_FILTER:-/dev/null}" ]]; then
  if command -v python3 >/dev/null 2>&1; then
    filtered="${transcript}.filtered"
    if python3 - "$YCAL_TRANSCRIPT_FILTER" "$transcript" "$filtered" <<'PY' 2>&2; then
import json, re, sys
filter_path, src_path, dst_path = sys.argv[1], sys.argv[2], sys.argv[3]
with open(src_path, "r", encoding="utf-8") as f:
    text = f.read()
applied = 0
with open(filter_path, "r", encoding="utf-8") as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            rule = json.loads(line)
        except Exception as e:
            sys.stderr.write(f"[post-meet] skip malformed filter rule: {e}\n")
            continue
        pat = rule.get("from") or ""
        repl = rule.get("to") or ""
        if not pat:
            continue
        flags = 0 if rule.get("caseSensitive") else re.IGNORECASE
        if all(ord(c) < 128 for c in pat):
            regex = r"\b" + re.escape(pat) + r"\b"
        else:
            regex = re.escape(pat)
        new_text, n = re.subn(regex, repl, text, flags=flags)
        if n > 0:
            applied += n
        text = new_text
with open(dst_path, "w", encoding="utf-8") as f:
    f.write(text)
sys.stderr.write(f"[post-meet] applied {applied} glossary substitution(s)\n")
PY
      mv "$filtered" "$transcript"
    else
      echo "[post-meet] glossary substitution failed — keeping raw transcript" >&2
      rm -f "$filtered"
    fi
  else
    echo "[post-meet] python3 not available — skipping substitution pass" >&2
  fi
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
