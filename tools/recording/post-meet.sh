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
#   YCAL_SUMMARY_ONLY      when "1", skip transcription entirely and re-run
#                          ONLY the claude summarization step against the
#                          existing <base>.transcript.txt. Fails if the
#                          transcript is missing.
#   YCAL_EXTRA_CONTEXT     path to a text file of user-supplied context
#                          (names, acronyms, what to emphasise). Appended to
#                          the __CONTEXT__ block in the summary prompt.
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

# Initialize every temp-file slot up front so the EXIT trap can safely
# `rm -f` all of them without worrying about which branch ran.
work=""
mic_wav=""
sys_wav=""
mic_json_base=""
sys_json_base=""
context_block_file=""
trap '[[ -n "$work" ]]               && rm -f "$work"; \
      [[ -n "$mic_wav" ]]            && rm -f "$mic_wav"; \
      [[ -n "$sys_wav" ]]            && rm -f "$sys_wav"; \
      [[ -n "$mic_json_base" ]]      && rm -f "${mic_json_base}.json"; \
      [[ -n "$sys_json_base" ]]      && rm -f "${sys_json_base}.json"; \
      [[ -n "$context_block_file" ]] && rm -f "$context_block_file"; \
      true' EXIT

# YCAL_SUMMARY_ONLY=1 skips transcription entirely and re-runs only the
# summarization step against the existing transcript.txt. Used by the
# popover "Re-summarize" button when the transcript is fine but the
# summary needs to be regenerated against a different prompt / glossary.
if [[ "${YCAL_SUMMARY_ONLY:-}" == "1" ]]; then
  if [[ ! -s "$transcript" ]]; then
    echo "[post-meet] YCAL_SUMMARY_ONLY=1 but no transcript at $transcript — bailing" >&2
    exit 6
  fi
  echo "[post-meet] summary-only mode — reusing existing transcript ($(wc -c <"$transcript") bytes)" >&2
else

# Detect channel layout. Recordings made by record-meet.sh (post-stereo
# update) are 2-channel (L=mic, R=system) so we can run whisper on each
# channel separately and label the merged transcript with [Me]/[Other].
# Pre-stereo files (mono) still work via the legacy single-pass path.
channels="$(ffprobe -v error -select_streams a:0 -show_entries stream=channels -of default=nw=1:nk=1 "$audio" 2>/dev/null || echo 1)"
[[ "$channels" =~ ^[0-9]+$ ]] || channels=1

# Shared whisper invocation builder — pulls in the glossary prompt when
# one is configured. Used by both the mono and stereo branches.
build_whisper_args() {
  local out_base="$1"
  local out_flag="$2"  # -otxt | -oj
  whisper_args=(-m "$MODEL" -l auto -t 8 "$out_flag" -of "$out_base")
  if [[ -n "${YCAL_WHISPER_PROMPT:-}" && -s "${YCAL_WHISPER_PROMPT:-/dev/null}" ]]; then
    whisper_prompt_body="$(cat "$YCAL_WHISPER_PROMPT")"
    if [[ -n "$whisper_prompt_body" ]]; then
      whisper_args+=(--prompt "$whisper_prompt_body")
    fi
  fi
}

if [[ "$channels" -ge 2 ]]; then
  # === Stereo path: per-channel diarization ================================
  # The recording is L=mic (you), R=system (everyone else). Pull each
  # channel out as its own 16-kHz mono WAV, transcribe with JSON output
  # so we have segment timestamps, then merge into a single labeled
  # transcript ordered by start time.
  mic_wav="$(mktemp -t ycal-whisper-mic).wav"
  sys_wav="$(mktemp -t ycal-whisper-sys).wav"
  mic_json_base="${base}.mic"
  sys_json_base="${base}.sys"

  echo "[post-meet] decoding stereo → mic.wav + sys.wav…" >&2
  # ffmpeg removed `-map_channel` in 7.x. Use the `channelsplit` filter
  # instead — it splits the stereo input into two independent mono streams
  # in a single decode pass. [l] is the left (mic) channel; [r] is the
  # right (system) channel. -ac 1 on each output is belt-and-suspenders;
  # channelsplit already yields mono.
  ffmpeg -hide_banner -loglevel error -y -i "$audio" \
    -filter_complex "[0:a]channelsplit=channel_layout=stereo[l][r]" \
    -map "[l]" -ar 16000 -ac 1 "$mic_wav" \
    -map "[r]" -ar 16000 -ac 1 "$sys_wav"

  if [[ -n "${YCAL_WHISPER_PROMPT:-}" && -s "${YCAL_WHISPER_PROMPT:-/dev/null}" ]]; then
    echo "[post-meet] using whisper prompt ($(wc -c <"$YCAL_WHISPER_PROMPT") bytes)" >&2
  fi

  echo "[post-meet] transcribing mic channel (you)…" >&2
  build_whisper_args "$mic_json_base" "-oj"
  "$WHISPER_BIN" "${whisper_args[@]}" "$mic_wav" >&2
  echo "[post-meet] transcribing system channel (others)…" >&2
  build_whisper_args "$sys_json_base" "-oj"
  "$WHISPER_BIN" "${whisper_args[@]}" "$sys_wav" >&2

  if [[ ! -s "${mic_json_base}.json" && ! -s "${sys_json_base}.json" ]]; then
    echo "[post-meet] both whisper passes produced no JSON — bailing" >&2; exit 3
  fi

  # Merge by timestamp. We collapse consecutive same-speaker segments
  # (whisper splits aggressively at natural pauses) so the labeled output
  # stays readable. We also do bleed suppression — when the user records
  # without headphones, the mic picks up speaker bleed of the others,
  # which whisper transcribes into [Me] segments that are near-duplicates
  # of nearby [Other] segments. We drop those duplicate [Me] entries so
  # the transcript reflects who actually spoke. System channel wins;
  # mic-only content (user speaking when others aren't) is preserved.
  if ! python3 - "${mic_json_base}.json" "${sys_json_base}.json" "$transcript" <<'PY' 2>&2; then
import json, sys, unicodedata, statistics
from difflib import SequenceMatcher

mic_path, sys_path, out_path = sys.argv[1], sys.argv[2], sys.argv[3]

DEDUP_THRESHOLD = 0.5

def normalize(s):
    s = unicodedata.normalize('NFKC', s)
    return ''.join(c for c in s.lower() if c.isalnum())

def load_segments(path, label):
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        return []
    segs = []
    for s in data.get("transcription", []):
        off_from = (s.get("offsets") or {}).get("from", 0)
        text = (s.get("text") or "").strip()
        if not text:
            continue
        segs.append({'off': off_from, 'label': label, 'text': text, 'norm': normalize(text)})
    return segs

mic = load_segments(mic_path, "Me")
sys_segs = load_segments(sys_path, "Other")

# === Channel-offset alignment ============================================
# The coreaudio-tap helper writes the system channel ~1–1.5s LATE relative to
# the mic (a tap-startup artifact: ~1s of FIFO-buffered silence is read by
# ffmpeg before the real audio + SCStream warm-up). Left uncorrected this
# misorders turn-taking and throws the bleed-suppression window off-center.
#
# We recover the offset from the data we already have: when the user isn't on
# headphones the SAME far-end words land in BOTH channels (mic via acoustic
# bleed), so a matched [Me]/[Other] pair has sys_off - mic_off ≈ the offset.
# The median over strong matches is a robust estimate (no audio reprocessing,
# no numpy). We only trust it with enough matches and within a plausible range;
# otherwise we leave timing untouched (headphone recordings have no bleed to
# measure, but also no cross-channel content to misorder).
SEARCH_MS = 6000
deltas = []
sys_sorted = sorted(sys_segs, key=lambda x: x['off'])
for m in mic:
    if len(m['norm']) < 4:
        continue
    best_dt, best_r = None, 0.0
    for o in sys_sorted:
        dt = o['off'] - m['off']
        if dt < -SEARCH_MS:
            continue
        if dt > SEARCH_MS:
            break
        if len(o['norm']) < 4:
            continue
        r = SequenceMatcher(None, m['norm'], o['norm']).ratio()
        if r > best_r:
            best_r, best_dt = r, dt
    if best_dt is not None and best_r >= 0.7:
        deltas.append(best_dt)

offset_ms = 0
if len(deltas) >= 4:
    cand = statistics.median(deltas)
    if 200 <= cand <= 4000:
        offset_ms = int(cand)
if offset_ms:
    for o in sys_segs:
        o['off'] = max(0, o['off'] - offset_ms)
    sys_sorted = sorted(sys_segs, key=lambda x: x['off'])
    sys.stderr.write(f"[post-meet] aligned system channel −{offset_ms}ms ({len(deltas)} bleed matches)\n")

# === Bleed suppression ===================================================
# For each [Me] segment, drop it if a nearby [Other] segment is text-similar
# (>= DEDUP_THRESHOLD): that's the mic picking up speaker bleed of the others.
# Window: tight once we've aligned the channels (matched content now sits at
# ~0 lag); wider as a safety net when we couldn't measure/apply an offset.
DEDUP_WINDOW_MS = 2000 if offset_ms else 4000
suppressed = 0
kept_mic = []
sys_by_time = sys_sorted
for m in mic:
    if len(m['norm']) < 2:
        kept_mic.append(m)  # too short to compare; keep it
        continue
    bled = False
    for o in sys_by_time:
        dt = o['off'] - m['off']
        if dt < -DEDUP_WINDOW_MS:
            continue
        if dt > DEDUP_WINDOW_MS:
            break
        if len(o['norm']) < 2:
            continue
        if SequenceMatcher(None, m['norm'], o['norm']).ratio() >= DEDUP_THRESHOLD:
            bled = True
            break
    if bled:
        suppressed += 1
    else:
        kept_mic.append(m)

if suppressed > 0:
    sys.stderr.write(f"[post-meet] bleed suppression dropped {suppressed} mic segments (of {len(mic)}; user is likely not on headphones)\n")

all_segs = kept_mic + sys_segs
all_segs.sort(key=lambda x: x['off'])

merged = []
for s in all_segs:
    if merged and merged[-1]['label'] == s['label']:
        merged[-1]['text'] += ' ' + s['text']
    else:
        merged.append({'off': s['off'], 'label': s['label'], 'text': s['text']})

with open(out_path, "w", encoding="utf-8") as f:
    for s in merged:
        mm = s['off'] // 60000
        ss = (s['off'] % 60000) // 1000
        f.write(f"[{mm:02d}:{ss:02d}] {s['label']}: {s['text']}\n")
PY
    echo "[post-meet] merge failed — bailing" >&2; exit 3
  fi

  # === Speaker diarization (optional, stereo-only) =========================
  # When the GUI's recorderDiarize.enabled toggle is on AND an HF token is
  # set, replace [Other] labels in the merged transcript with [SPK1]/[SPK2]
  # /… based on pyannote.audio's speaker separation of the system-audio
  # (right) channel. The summary prompt knows what to do with these
  # labels — map them to attendees from the calendar invite.
  #
  # We only run on the stereo path because the system-audio WAV ($sys_wav)
  # is what holds the multi-speaker mix; the mono path has no separable
  # signal to diarize. Failure is non-fatal: we fall back to [Other].
  if [[ "${YCAL_DIARIZE_ENABLED:-}" == "1" \
        && -n "${YCAL_DIARIZE_PY:-}" && -f "${YCAL_DIARIZE_PY:-}" \
        && -n "${YCAL_DIARIZE_VENV_PY:-}" && -x "${YCAL_DIARIZE_VENV_PY:-}" \
        && -n "${YCAL_HF_TOKEN:-}" \
        && -s "$sys_wav" ]]; then
    echo "[post-meet] running speaker diarization (this can take 2-5 min on long recordings)…" >&2
    diarized="${transcript}.diarized"
    if "$YCAL_DIARIZE_VENV_PY" "$YCAL_DIARIZE_PY" \
         --audio "$sys_wav" \
         --transcript "$transcript" \
         --out "$diarized" \
         --hf-token "$YCAL_HF_TOKEN" >&2; then
      mv "$diarized" "$transcript"
      echo "[post-meet] transcript upgraded with speaker labels" >&2
    else
      echo "[post-meet] diarization exited non-zero — keeping stereo labels" >&2
      rm -f "$diarized"
    fi
  fi
else
  # === Mono path: legacy single-pass (pre-stereo recordings) ==============
  work="$(mktemp -t ycal-whisper).wav"
  echo "[post-meet] decoding to wav…" >&2
  ffmpeg -hide_banner -loglevel error -y -i "$audio" -ar 16000 -ac 1 "$work"

  echo "[post-meet] transcribing → $transcript" >&2
  build_whisper_args "${base}.transcript" "-otxt"
  if [[ -n "${YCAL_WHISPER_PROMPT:-}" && -s "${YCAL_WHISPER_PROMPT:-/dev/null}" ]]; then
    echo "[post-meet] using whisper prompt ($(wc -c <"$YCAL_WHISPER_PROMPT") bytes)" >&2
  fi
  "$WHISPER_BIN" "${whisper_args[@]}" "$work" >&2
fi

fi  # YCAL_SUMMARY_ONLY else-branch

if [[ ! -s "$transcript" ]]; then
  echo "[post-meet] transcript empty — bailing" >&2; exit 3
fi

# Substitution pass + summarization run in both modes (summary-only still
# wants the latest glossary applied before claude sees the transcript).

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
__CONTEXT__
Transcript:
```
__TRANSCRIPT__
```

Write meeting notes in markdown. Match the language used in the transcript (mixed Chinese/English → favour Chinese). Include only sections that have something to say — omit the heading otherwise.

## TL;DR
2–3 sentences. What was the meeting about, what was decided.

## Decisions
What was decided, by whom (if clear), and rationale.

## Speaker mapping (omit this section entirely when the transcript only uses [Me]/[Other])
When the transcript contains [SPK1]/[SPK2]/… labels (from speaker diarization), each [SPKn] consistently refers to the same person throughout. Map each [SPKn] to an attendee from the meeting context above using topic ownership + name drops where one attendee addresses another. Output a bullet list: "[SPKn] — Name (one-line evidence)". For any [SPKn] you cannot confidently map, write "[SPKn] — unmapped" — never guess.

## Action items
Markdown table: | Owner | What | Due |. Only items explicitly or strongly implied. Don't invent dates.

Owner discipline — pick exactly one of four forms, in this order of preference:
1. **Mapped attendee** — when the transcript had [SPKn] labels and you confidently mapped one to an attendee. Write the real name.
2. **Attendee** — a name from the "Attendees" list (no speaker label needed, e.g. when delegating to "Me"). Write the name plain.
3. **Known-but-absent** — a name from "Known people (NOT at this meeting)" that the meeting explicitly delegated work to. Write "Name (absent)". When there's an in-meeting follow-up owner ("Alice will brief Bob"), prefer Alice as owner with "brief Bob on …" in the What column.
4. **Unverified or unmapped** — a name in the transcript that matches NEITHER list, or an unmapped [SPKn]. Write the name with trailing "?" (e.g. "Gomei?") OR write "[SPKn]" verbatim. Do NOT silently promote unknown names to owners.

## Open questions
Things raised but unresolved.

## Follow-ups for me
What the participant should do or think about next. Be concrete.

Constraints: be concise, don't editorialise, don't fabricate. If the transcript is too short or noisy to summarise, say so in a single line and stop.

---

After the markdown note above, output a line containing EXACTLY this sentinel and nothing else:
===YCAL-NOTE-JSON===
Then output a SINGLE JSON object (no markdown fence, no prose before or after it) capturing the same note in structured form for the app to render:
{
  "summary": ["short point", "…"],
  "decisions": ["…"],
  "actions": [{"text": "…", "owner": "Name or null"}],
  "openQuestions": ["…"],
  "followups": ["…"],
  "speakerMap": {"SPK1": "Full Name"},
  "terms": [{"heard": "…", "suggestion": "… or null", "type": "name|term|org|region|project"}]
}
Rules for the JSON: match the language of the note; keep arrays empty rather than inventing content; include "speakerMap" only when the transcript used [SPKn] labels and omit any you couldn't map; the "terms" array is the proper nouns a human should double-check — names, companies, products, acronyms that sound uncertain or were likely mis-transcribed — with "suggestion" being the correct spelling when you're fairly sure (else null). Do NOT put common words in "terms".
TMPL
fi

# === Meeting context block (Phase 3) ========================================
# yCal writes <base>.context.json next to the audio when recording starts.
# It carries the meeting title, the user's own identity (so "Me" in the
# stereo transcript maps to a real name), the attendee list with titles,
# and the event location/description. We format it as a human-readable
# block here and feed it into the summary prompt as __CONTEXT__. If the
# file is missing or python3 isn't available, the block stays empty
# (placeholder gets stripped) and the legacy prompt shape is preserved.
context_file="${base}.context.json"
context_block_file="$(mktemp -t ycal-ctx-block)"
: > "$context_block_file"
if [[ -s "$context_file" ]] && command -v python3 >/dev/null 2>&1; then
  python3 - "$context_file" "$context_block_file" <<'PY' 2>/dev/null || true
import json, sys
ctx_path, out_path = sys.argv[1], sys.argv[2]
try:
    with open(ctx_path, "r", encoding="utf-8") as f:
        ctx = json.load(f)
except Exception:
    sys.exit(0)

lines = ["", "Meeting context:"]
me = ctx.get("me") or {}
if me.get("name") or me.get("email"):
    lines.append("- You: " + (me.get("name") or me.get("email") or "") + " <" + (me.get("email") or "") + ">")
loc = ctx.get("location")
if loc:
    lines.append("- Location: " + loc)
attendees = ctx.get("attendees") or []
if attendees:
    lines.append("- Attendees:")
    for a in attendees:
        name = a.get("name") or a.get("email") or ""
        email = a.get("email") or ""
        title = a.get("title") or ""
        flags = []
        if a.get("organizer"):
            flags.append("organizer")
        if a.get("optional"):
            flags.append("optional")
        rsvp = a.get("rsvp")
        if rsvp and rsvp not in ("accepted", "needsAction"):
            flags.append(rsvp)
        suffix = (" (" + ", ".join(flags) + ")") if flags else ""
        title_part = (" — " + title) if title else ""
        lines.append("    - " + name + title_part + " <" + email + ">" + suffix)
desc = (ctx.get("description") or "").strip()
if desc:
    # Trim — sometimes the description is a wall of HTML from a
    # forwarded invite; the first ~600 chars cover the agenda line.
    if len(desc) > 600:
        desc = desc[:600] + "..."
    lines.append("- Description:")
    for ln in desc.splitlines():
        lines.append("  " + ln)

# Broader directory of people the user knows (from people.md) who are NOT
# at this meeting. Lets the prompt distinguish a legitimate delegation to
# an absent colleague from a Whisper-hallucinated name. Truncated for
# token budget — if the directory is huge, the most useful entries
# (those mentioned in the transcript) tend to be common enough to fit.
known = ctx.get("knownPeople") or []
if known:
    capped = known[:80]
    lines.append("- Known people (NOT at this meeting — only use if explicitly delegated to):")
    for p in capped:
        name = p.get("name") or ""
        title = p.get("title") or ""
        if not name:
            continue
        title_part = (" — " + title) if title else ""
        lines.append("    - " + name + title_part)
    if len(known) > len(capped):
        lines.append("    - (… " + str(len(known) - len(capped)) + " more not shown)")

lines.append("")
lines.append("Note: stereo recordings label speakers as Me/Other. Map Me to the user above. For Other, prefer 'an attendee' over guessing — but where the discussion context (role, expertise, named references) strongly implies a specific attendee, use their name.")
lines.append("")
with open(out_path, "w", encoding="utf-8") as f:
    f.write("\n".join(lines))
PY
fi

# Append the user's free-text context (Notes view → "Reprocess with
# context"). It's authoritative for the names / acronyms / priorities the
# audio and the calendar invite couldn't convey, so it goes into the same
# __CONTEXT__ block. Independent of whether a context.json existed.
if [[ -n "${YCAL_EXTRA_CONTEXT:-}" && -s "${YCAL_EXTRA_CONTEXT}" ]]; then
  {
    echo ""
    echo "Additional context from the user (authoritative — prefer it for names, acronyms, decisions, and what to emphasise):"
    cat "$YCAL_EXTRA_CONTEXT"
    echo ""
  } >> "$context_block_file"
  echo "[post-meet] folded user extra-context ($(wc -c <"$YCAL_EXTRA_CONTEXT") bytes)" >&2
fi

# Hand-fold the template — simpler than escaping shell-special chars in the
# transcript through printf/$(…). The transcript can contain back-ticks and $.
{
  printf '%s' "$prompt_template" \
    | awk -v t="$title" '{gsub(/__TITLE__/, t); print}' \
    | awk -v f="$context_block_file" '
        /__CONTEXT__/ {
          while ((getline line < f) > 0) print line
          close(f); next
        }
        { print }
      ' \
    | awk -v f="$transcript" '
        /__TRANSCRIPT__/ {
          while ((getline line < f) > 0) print line
          close(f); next
        }
        { print }
      '
} > "${base}.summary.prompt.tmp"

echo "[post-meet] summarising via $CLAUDE_BIN → $summary" >&2
summary_raw="${base}.summary.raw"
if ! "$CLAUDE_BIN" -p < "${base}.summary.prompt.tmp" > "$summary_raw" 2>"${base}.summary.log"; then
  echo "[post-meet] claude failed — see ${base}.summary.log" >&2
  rm -f "${base}.summary.prompt.tmp" "$summary_raw"
  exit 4
fi
rm -f "${base}.summary.prompt.tmp"

# === Split the structured note off the markdown =============================
# The prompt asks claude to append `===YCAL-NOTE-JSON===` + a JSON object
# after the human markdown note. We split the raw output into:
#   <base>.summary.md   — the markdown before the sentinel (human note)
#   <base>.note.json    — the structured note the Notes view renders
# Defensive: if there's no sentinel, no python3, or the JSON doesn't parse,
# summary.md = the full output (legacy behaviour) and note.json is absent
# (the app falls back to parsing the markdown). The human summary is never
# left empty.
note_json="${base}.note.json"
rm -f "$note_json"
SENTINEL='===YCAL-NOTE-JSON==='
split_done=0
if grep -qF "$SENTINEL" "$summary_raw" && command -v python3 >/dev/null 2>&1; then
  if python3 - "$summary_raw" "$summary" "$note_json" "$SENTINEL" <<'PY' 2>>"${base}.summary.log"; then
import json, re, sys
raw_path, summary_path, note_path, sentinel = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
with open(raw_path, "r", encoding="utf-8") as f:
    raw = f.read()
idx = raw.find(sentinel)
if idx < 0:
    sys.exit(1)
md = raw[:idx].rstrip() + "\n"
tail = raw[idx + len(sentinel):].strip()
# Tolerate the model wrapping the JSON in a ```json fence despite the ask.
m = re.search(r"\{.*\}", tail, re.DOTALL)
ok_json = False
if m:
    try:
        obj = json.loads(m.group(0))
        if isinstance(obj, dict):
            with open(note_path, "w", encoding="utf-8") as f:
                json.dump(obj, f, ensure_ascii=False, indent=2)
            ok_json = True
    except Exception as e:
        sys.stderr.write(f"[post-meet] note.json parse failed: {e}\n")
# Write the human summary (markdown before the sentinel). Never empty:
# fall back to the full raw output if the split produced nothing.
with open(summary_path, "w", encoding="utf-8") as f:
    f.write(md if md.strip() else raw)
sys.exit(0 if ok_json else 2)
PY
    split_done=1
    echo "[post-meet] structured note.json written" >&2
  else
    code=$?
    if [[ "$code" == "2" ]]; then
      # Summary was written but JSON didn't parse — that's fine, fall through.
      split_done=1
      echo "[post-meet] note.json skipped (unparseable) — summary.md ok" >&2
    fi
  fi
fi
if [[ "$split_done" != "1" ]]; then
  # No sentinel / no python3 / hard failure — keep the full output as the note.
  cp "$summary_raw" "$summary"
fi
rm -f "$summary_raw"

if [[ ! -s "$summary" ]]; then
  echo "[post-meet] summary empty — see ${base}.summary.log" >&2; exit 5
fi

echo "[post-meet] done." >&2
printf '%s\n' "$summary"
