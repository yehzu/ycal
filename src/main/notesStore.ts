// yCal — meeting notes store (the Notes view's backend).
//
// Turns the recording archive into the structured `MeetingNote` the
// editorial Notes view renders. Sources, in priority order:
//
//   • note.json   — the structured note emitted by post-meet.sh's claude
//                   step (summary / decisions / actions / speaker map /
//                   flagged terms). Preferred when present.
//   • summary.md  — the human markdown note. Parsed deterministically into
//                   the same shape when note.json is absent (every
//                   recording made before this feature shipped).
//   • transcript.txt — `[MM:SS] Label: text` lines → timed speaker
//                   segments. Always the spine; speakers come from the
//                   diarization labels (Me / Other / SPK1…).
//   • glossary    — supplies canonical spellings for flagged terms and,
//                   in the markdown-fallback path, derives the flagged
//                   terms themselves (any alias still present in the
//                   transcript is a thing worth confirming).
//   • meta.json   — title + timing (cached locally; no Drive round-trip).
//
// The base note is read-only. User corrections (status, inline edits,
// speaker renames, resolved terms, highlights) live in a cloudStore
// overlay — `meeting-notes.json`, keyed by eventId — and are merged over
// the base in the renderer (mirroring the design's localStorage model).
// That split is deliberate: reprocessing a recording regenerates the base
// note without ever clobbering the user's corrections.

import fs from 'node:fs';

import type {
  GlossaryEntry,
  MeetingNote,
  MeetingNoteSummary,
  NoteAction,
  NoteOverlay,
  NoteSegment,
  NoteSpeaker,
  NoteStatus,
  NoteTerm,
  NotesOverlayFile,
} from '@shared/types';
import { readJson, writeJson } from './cloudStore';
import { getEffectiveEntries, getGlossary } from './glossary';
import {
  listAllMeetingArchives,
  fetchMeetingArtifact,
  fetchMeetingNoteSidecar,
  findAccountForArchive,
  readCachedMeta,
  deleteMeetingArchive,
} from './meetingArchive';
import { deleteLocalRecording, listRecentRecordings } from './meetRecorder';

const OVERLAY_FILE = 'meeting-notes.json';

// Speaker accent hues — shared lightness/chroma in the CSS, only hue
// varies, so the roster reads as one editorial family (matches the
// design's NT_SPK_COLORS oklch palette).
const SPEAKER_HUES = [248, 150, 44, 312, 86, 200, 24, 170, 270, 110];

// ── small text helpers ─────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Turn a raw transcript label into a friendly default display name.
function prettyLabel(label: string, meName: string | null): string {
  const l = label.trim();
  if (/^me$/i.test(l)) return meName || 'Me';
  if (/^other$/i.test(l)) return 'Other speaker';
  const spk = l.match(/^spk\s*(\d+)$/i);
  if (spk) return `Speaker ${spk[1]}`;
  return l;
}

function labelId(label: string): string {
  return 'sp-' + label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

// ── filename / timing ───────────────────────────────────────────────────

// Recording filename shape: `<YYYY-MM-DD_HHMM>__<safe-title>__<eventId>`.
function parseBaseName(
  baseName: string,
): { startedAt: number | null; title: string | null } {
  const first = baseName.indexOf('__');
  const last = baseName.lastIndexOf('__');
  let title: string | null = null;
  if (first >= 0 && last > first) {
    title = baseName.slice(first + 2, last).replace(/-+/g, ' ').trim() || null;
  }
  let startedAt: number | null = null;
  const stamp = (first >= 0 ? baseName.slice(0, first) : baseName)
    .match(/^(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})$/);
  if (stamp) {
    const [, y, mo, d, h, mi] = stamp;
    const dt = new Date(+y, +mo - 1, +d, +h, +mi);
    if (!Number.isNaN(dt.getTime())) startedAt = dt.getTime();
  }
  return { startedAt, title };
}

function localDateStr(ms: number | null): string {
  const d = ms ? new Date(ms) : new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Stable hue (0–360) fingerprinted from the eventId — meetings rarely
// carry a usable calendar color this far from the loaded window, so we
// derive a consistent accent from the id instead.
function stableHue(eventId: string): number {
  let h = 0;
  for (let i = 0; i < eventId.length; i++) {
    h = (h * 31 + eventId.charCodeAt(i)) >>> 0;
  }
  return h % 360;
}

// ── transcript parsing ──────────────────────────────────────────────────

interface RawLine { t: number; label: string; text: string; }

function parseTranscript(text: string): { lines: RawLine[]; labels: string[] } {
  const lines: RawLine[] = [];
  const labels: string[] = [];
  const re = /^\[(\d+):(\d+)(?::(\d+))?\]\s*([^:]+?):\s*(.*)$/;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line) continue;
    const m = line.match(re);
    if (!m) {
      // Continuation of the previous speaker's turn (wrapped line).
      if (lines.length) lines[lines.length - 1].text += ' ' + line.trim();
      continue;
    }
    const h = m[3] ? +m[1] : 0;
    const mm = m[3] ? +m[2] : +m[1];
    const ss = m[3] ? +m[3] : +m[2];
    const t = h * 3600 + mm * 60 + ss;
    const label = m[4].trim();
    const body = m[5].trim();
    if (!labels.includes(label)) labels.push(label);
    lines.push({ t, label, text: body });
  }
  return { lines, labels };
}

function buildSpeakers(
  labels: string[],
  speakerMap: Record<string, string>,
  meName: string | null,
): NoteSpeaker[] {
  return labels.map((label, i) => {
    const mapped = speakerMap[label] || speakerMap[label.toUpperCase()] || null;
    const name = mapped || prettyLabel(label, meName);
    const isUnmapped = !mapped && /^(spk\s*\d+|other)$/i.test(label.trim());
    return {
      id: labelId(label),
      label,
      name,
      initials: initialsOf(name),
      role: isUnmapped ? 'Unidentified' : null,
      hue: SPEAKER_HUES[i % SPEAKER_HUES.length],
    };
  });
}

// ── flagged-term wrapping ───────────────────────────────────────────────

function glossaryLookup(entries: GlossaryEntry[], heard: string): string | null {
  const h = heard.trim().toLowerCase();
  for (const e of entries) {
    if (e.canonical.toLowerCase() === h) return e.canonical;
    if (e.aliases.some((a) => a.toLowerCase() === h)) return e.canonical;
  }
  return null;
}

// Markdown-fallback path: a flagged term is any glossary alias still
// present verbatim in the transcript (a known mis-hearing that the
// substitution pass didn't catch, or that predates the glossary entry).
function deriveTermsFromGlossary(
  transcript: string, entries: GlossaryEntry[],
): NoteTerm[] {
  const lc = transcript.toLowerCase();
  const out: NoteTerm[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    for (const alias of e.aliases) {
      const a = alias.trim();
      if (!a || seen.has(a.toLowerCase())) continue;
      const ascii = /^[\x00-\x7F]+$/.test(a);
      const re = new RegExp(ascii ? `\\b${escapeRegex(a.toLowerCase())}\\b` : escapeRegex(a.toLowerCase()));
      if (!re.test(lc)) continue;
      seen.add(a.toLowerCase());
      out.push({
        id: 't-' + out.length,
        heard: a,
        suggestion: e.canonical,
        type: e.category === 'person' ? 'name' : e.category === 'company' ? 'org' : e.category,
      });
    }
  }
  return out;
}

// Wrap every flagged `heard` occurrence in a low-confidence span so the
// transcript surfaces it for fixing. Operates on already-escaped text and
// only injects our own markup.
function wrapTerms(escaped: string, terms: NoteTerm[]): string {
  const usable = terms.filter((t) => t.heard.trim());
  if (!usable.length) return escaped;
  const sorted = [...usable].sort((a, b) => b.heard.length - a.heard.length);
  const parts = sorted.map((t) => {
    const e = escapeRegex(escapeHtml(t.heard));
    return /^[\x00-\x7F]+$/.test(t.heard) ? `\\b${e}\\b` : e;
  });
  let re: RegExp;
  try {
    re = new RegExp(`(${parts.join('|')})`, 'gi');
  } catch {
    return escaped;
  }
  return escaped.replace(re, (m) => {
    const t = sorted.find((x) => escapeHtml(x.heard).toLowerCase() === m.toLowerCase());
    if (!t) return m;
    return `<span class="nt-lc" data-term="${t.id}" title="low confidence — heard ‘${m}’">${m}</span>`;
  });
}

// ── summary.md markdown parsing (note.json fallback) ────────────────────

interface ParsedSummary {
  summary: string[];
  decisions: string[];
  actions: Array<{ text: string; owner: string | null }>;
  openQuestions: string[];
  followups: string[];
  speakerMap: Record<string, string>;
}

function splitBullets(body: string): string[] {
  const out: string[] = [];
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(?:[-*•]|\d+[.)])\s+(.*)$/);
    if (m) out.push(m[1].trim());
    else if (out.length === 0 || /[.!?。！？]$/.test(line)) {
      // Prose paragraph (e.g. TL;DR): keep whole lines as points.
      out.push(line);
    } else {
      out[out.length - 1] += ' ' + line;
    }
  }
  return out.filter(Boolean);
}

// TL;DR is prose; split into sentence-ish bullets for the editorial list.
function splitProse(body: string): string[] {
  const joined = body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join(' ');
  if (!joined) return [];
  const sentences = joined.match(/[^.!?。！？]+[.!?。！？]+|\S.+$/g);
  return (sentences || [joined]).map((s) => s.trim()).filter(Boolean);
}

// Parse a decisions section that may be bullet-list OR markdown table.
// Table rows → "decision — explanation" or just "decision".
function parseDecisionsBody(body: string): string[] {
  const lines = body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.some((l) => /^\|[\s:|-]+\|/.test(l))) return splitBullets(body);
  const rows: string[] = [];
  for (const line of lines) {
    if (!line.startsWith('|')) {
      const m = line.match(/^(?:[-*•]|\d+[.)])\s+(.*)$/);
      if (m) rows.push(m[1].trim());
      continue;
    }
    const cells = line.split('|').map((c) => c.trim()).filter((_, i, a) => i > 0 && i < a.length - 1);
    if (!cells.length) continue;
    if (cells.every((c) => /^:?-+:?$/.test(c) || !c)) continue; // separator row
    if (/^(決策|decision|decisions)$/i.test(cells[0])) continue; // header row
    const decision = cells[0];
    const explanation = cells[1] && cells[1] !== '—' && cells[1] !== '-' ? cells[1] : '';
    if (!decision) continue;
    rows.push(explanation ? `${decision} — ${explanation}` : decision);
  }
  return rows.length > 0 ? rows : splitBullets(body);
}

function parseActionsTable(body: string): Array<{ text: string; owner: string | null }> {
  const rows: Array<{ text: string; owner: string | null }> = [];
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('|')) {
      // Some models emit "- Owner: do X" instead of a table.
      const dash = line.match(/^[-*]\s+(.*)$/);
      if (dash) rows.push({ text: dash[1].trim(), owner: null });
      continue;
    }
    const cells = line.split('|').map((c) => c.trim());
    // Strip the leading/trailing empties from the pipe split.
    const cols = cells.filter((_, i) => i > 0 && i < cells.length - 1);
    if (cols.length === 0) continue;
    if (/^(owner|what|action|item|task)$/i.test(cols[0])) continue;   // header
    if (cols.every((c) => /^:?-+:?$/.test(c) || c === '')) continue;  // separator
    const owner = cols[0] && cols[0] !== '—' && cols[0] !== '-' ? cols[0] : null;
    const what = cols[1] || cols[0] || '';
    const due = cols[2] && cols[2] !== '—' && cols[2] !== '-' ? cols[2] : '';
    if (!what) continue;
    rows.push({ text: due ? `${what} (due ${due})` : what, owner });
  }
  return rows;
}

function parseSummaryMarkdown(md: string): ParsedSummary {
  const out: ParsedSummary = {
    summary: [], decisions: [], actions: [],
    openQuestions: [], followups: [], speakerMap: {},
  };
  // Split into (heading, body) sections on `#`/`##`/`###` lines.
  const sections: Array<{ head: string; body: string }> = [];
  let cur: { head: string; body: string } | null = null;
  for (const raw of md.split(/\r?\n/)) {
    const hm = raw.match(/^#{1,6}\s+(.*)$/);
    if (hm) {
      cur = { head: hm[1].trim(), body: '' };
      sections.push(cur);
    } else if (cur) {
      cur.body += raw + '\n';
    } else {
      // Preamble before any heading → treat as summary prose.
      cur = { head: 'TL;DR', body: raw + '\n' };
      sections.push(cur);
    }
  }
  for (const s of sections) {
    const h = s.head.toLowerCase();
    if (/tl;?dr|summary|摘要|重點/.test(h)) {
      out.summary.push(...splitProse(s.body));
    } else if (/decision|決議|決定/.test(h)) {
      out.decisions.push(...parseDecisionsBody(s.body));
    } else if (/action|action items|待辦|行動/.test(h)) {
      out.actions.push(...parseActionsTable(s.body));
    } else if (/open question|未解|懸而|open issue/.test(h)) {
      out.openQuestions.push(...splitBullets(s.body));
    } else if (/follow|後續|下一步/.test(h)) {
      out.followups.push(...splitBullets(s.body));
    } else if (/speaker mapping|speaker map|講者/.test(h)) {
      for (const b of splitBullets(s.body)) {
        const m = b.match(/\[?(SPK\s*\d+|Me|Other)\]?\s*[—:-]\s*(.+)$/i);
        if (!m) continue;
        const name = m[2].replace(/\(.*?\)\s*$/, '').trim();
        if (name && !/unmapped|unknown/i.test(name)) out.speakerMap[m[1].trim()] = name;
      }
    }
  }
  return out;
}

// ── note.json (LLM-emitted structured note) ─────────────────────────────

interface NoteJson {
  summary?: string[];
  decisions?: string[];
  actions?: Array<{ text?: string; owner?: string | null }>;
  openQuestions?: string[];
  followups?: string[];
  speakerMap?: Record<string, string>;
  terms?: Array<{ heard?: string; suggestion?: string | null; type?: string }>;
  modelVer?: string;
}

function parseNoteJson(body: string): NoteJson | null {
  try {
    const j = JSON.parse(body);
    if (j && typeof j === 'object') return j as NoteJson;
  } catch { /* not valid JSON */ }
  return null;
}

// ── pseudo-waveform ─────────────────────────────────────────────────────

// Derive a stable waveform from speech density across the timeline — gives
// the scrubber a shape that loosely tracks the real meeting. Falls back to
// a deterministic envelope when there's no timing to work with.
function peaksFromSegments(lines: RawLine[], durationSec: number, seed: number): number[] {
  const N = 132;
  const out: number[] = [];
  if (durationSec > 0 && lines.length > 0) {
    const buckets = new Array(N).fill(0);
    for (const ln of lines) {
      const idx = Math.min(N - 1, Math.max(0, Math.floor((ln.t / durationSec) * N)));
      buckets[idx] += Math.min(40, ln.text.length) / 40;
    }
    const max = Math.max(0.0001, ...buckets);
    for (let i = 0; i < N; i++) {
      const env = 0.55 + 0.4 * Math.sin(i / 6 + seed) * Math.cos(i / 17);
      out.push(Math.max(0.12, Math.min(1, 0.3 + 0.7 * (buckets[i] / max) * Math.abs(env))));
    }
    return out;
  }
  let s = seed * 9301 + 49297;
  for (let i = 0; i < N; i++) {
    s = (s * 9301 + 49297) % 233280;
    const r = s / 233280;
    const env = 0.55 + 0.4 * Math.sin(i / 6 + seed) * Math.cos(i / 17);
    out.push(Math.max(0.12, Math.min(1, Math.abs(env) * (0.5 + r * 0.7))));
  }
  return out;
}

// ── meeting-cache context.json (me name) ─────────────────────────────────

function readContextMeName(audioFile: string | null): string | null {
  if (!audioFile) return null;
  try {
    const p = audioFile.replace(/\.m4a$/, '.context.json');
    if (!fs.existsSync(p)) return null;
    const ctx = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return ctx?.me?.name || null;
  } catch {
    return null;
  }
}

// ── source resolution ───────────────────────────────────────────────────

interface NoteSources {
  eventId: string;
  accountId: string | null;
  audioFile: string | null;
  transcriptFile: string | null;
  noteFile: string | null;
  summaryFile: string | null;
  startedAt: number | null;
  titleFromName: string | null;
  hasAudio: boolean;
  hasTranscript: boolean;
  hasSummary: boolean;
}

function localSourcesFor(eventId: string): NoteSources | null {
  const recents = listRecentRecordings(500);
  // Pick the LARGEST recording for this event, not the most-recently-
  // modified one. When a meeting was recorded twice under the same event id
  // — e.g. a long capture whose post-process timed out, followed by a short
  // throwaway re-record — the short clip must NOT shadow the real one.
  // Largest audio == the actual meeting (2026-06-05 "Troika cum Yeh": a
  // 4-min, 4 MB re-record was hiding a ~3h, 222 MB capture, so opening the
  // note showed an almost-empty document).
  const rec = recents
    .filter((r) => r.eventId === eventId)
    .sort((a, b) => b.sizeBytes - a.sizeBytes)[0];
  if (!rec) return null;
  const noteFile = rec.audioFile.replace(/\.m4a$/, '.note.json');
  const { startedAt, title } = parseBaseName(rec.baseName);
  return {
    eventId,
    accountId: null,
    audioFile: rec.audioFile,
    transcriptFile: rec.transcriptFile,
    noteFile: fs.existsSync(noteFile) ? noteFile : null,
    summaryFile: rec.summaryFile,
    startedAt,
    titleFromName: title,
    hasAudio: true,
    hasTranscript: rec.hasTranscript,
    hasSummary: rec.hasSummary,
  };
}

function readFileSafe(p: string | null): string | null {
  if (!p) return null;
  try { return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : null; }
  catch { return null; }
}

// ── public API ───────────────────────────────────────────────────────────

export function getNotesOverlayFile(): NotesOverlayFile {
  return readJson<NotesOverlayFile>(OVERLAY_FILE, { version: 1, notes: {}, updatedAt: 0 });
}

export function setNoteOverlay(eventId: string, overlay: NoteOverlay): NotesOverlayFile {
  const file = getNotesOverlayFile();
  const next: NotesOverlayFile = {
    version: 1,
    notes: { ...file.notes, [eventId]: { ...overlay, updatedAt: Date.now() } },
    updatedAt: Date.now(),
  };
  writeJson(OVERLAY_FILE, next);
  return next;
}

// Permanently delete one meeting note across every layer that feeds the
// Notes list, so a deleted (or garbage) recording actually disappears and
// stays gone:
//   1. local recording files in ~/Recordings/yCal + its in-memory status
//   2. the Drive appdata archive + the local meeting-cache
//   3. the correction overlay entry in meeting-notes.json
// Step 1 refuses while the recording is still in flight (returns an
// error). Steps 2-3 are best-effort — if Drive is offline the local copy
// is still removed and the row won't come back from the cache.
export async function deleteNote(
  eventId: string, accountId?: string | null,
): Promise<{ ok: boolean; removed: number; driveDeleted: number; error?: string }> {
  const local = deleteLocalRecording(eventId);
  if (!local.ok) {
    return { ok: false, removed: 0, driveDeleted: 0, error: local.error };
  }

  let driveDeleted = 0;
  let error: string | undefined;
  try {
    const res = await deleteMeetingArchive(eventId, accountId ?? null);
    driveDeleted = res.driveDeleted;
    error = res.error;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  // Drop the correction overlay so a re-record of the same event id starts
  // clean (and the deleted note doesn't linger as a phantom overlay).
  try {
    const file = getNotesOverlayFile();
    if (file.notes[eventId]) {
      const notes = { ...file.notes };
      delete notes[eventId];
      writeJson(OVERLAY_FILE, { version: 1, notes, updatedAt: Date.now() });
    }
  } catch (e) {
    if (!error) error = e instanceof Error ? e.message : String(e);
  }

  return { ok: true, removed: local.removed, driveDeleted, error };
}

// Build a full structured note for one event. Reads local files first,
// then falls back to the Drive archive. Throws only on truly nothing-found.
export async function getNote(
  eventId: string, accountIdHint?: string | null,
): Promise<MeetingNote> {
  let src = localSourcesFor(eventId);
  let accountId = accountIdHint ?? src?.accountId ?? null;

  // Resolve the owning account for Drive fetches when we have no local copy.
  if (!accountId) {
    try { accountId = await findAccountForArchive(eventId); } catch { /* offline */ }
  }

  // Gather raw bodies. Local wins; Drive fills the gaps.
  let transcript = readFileSafe(src?.transcriptFile ?? null);
  let noteBody = readFileSafe(src?.noteFile ?? null);
  let summaryMd = readFileSafe(src?.summaryFile ?? null);

  if (!transcript && accountId) {
    try { transcript = readFileSafe(await fetchMeetingArtifact(eventId, accountId, 'transcript')); }
    catch { /* none on Drive */ }
  }
  if (!noteBody && accountId) {
    noteBody = await fetchMeetingNoteSidecar(eventId, accountId);
  }
  if (!noteBody && !summaryMd && accountId) {
    try { summaryMd = readFileSafe(await fetchMeetingArtifact(eventId, accountId, 'summary')); }
    catch { /* none on Drive */ }
  }

  const meta = readCachedMeta(eventId);
  const meName = readContextMeName(src?.audioFile ?? null);
  const entries = getEffectiveEntries(eventId);

  const { lines, labels } = parseTranscript(transcript || '');

  const noteJson = noteBody ? parseNoteJson(noteBody) : null;

  // Structured fields — note.json wins, else parse the markdown summary.
  let summary: string[] = [];
  let decisions: string[] = [];
  let actionsRaw: Array<{ text: string; owner: string | null }> = [];
  let openQuestions: string[] = [];
  let followups: string[] = [];
  let speakerMap: Record<string, string> = {};
  let terms: NoteTerm[] = [];
  let source: MeetingNote['source'];

  if (noteJson) {
    summary = (noteJson.summary || []).filter(Boolean);
    decisions = (noteJson.decisions || []).filter(Boolean).flatMap((s) => parseDecisionsBody(s));
    actionsRaw = (noteJson.actions || [])
      .map((a) => ({ text: (a.text || '').trim(), owner: a.owner || null }))
      .filter((a) => a.text);
    openQuestions = (noteJson.openQuestions || []).filter(Boolean);
    followups = (noteJson.followups || []).filter(Boolean);
    speakerMap = noteJson.speakerMap || {};
    terms = (noteJson.terms || [])
      .map((t, i) => ({
        id: 't-' + i,
        heard: (t.heard || '').trim(),
        suggestion: (t.suggestion && t.suggestion.trim())
          || glossaryLookup(entries, t.heard || ''),
        type: t.type || 'term',
      }))
      .filter((t) => t.heard);
    source = 'note-json';
  } else if (summaryMd) {
    const parsed = parseSummaryMarkdown(summaryMd);
    summary = parsed.summary;
    decisions = parsed.decisions;
    actionsRaw = parsed.actions;
    openQuestions = parsed.openQuestions;
    followups = parsed.followups;
    speakerMap = parsed.speakerMap;
    terms = deriveTermsFromGlossary(transcript || '', entries);
    source = 'parsed-markdown';
  } else {
    terms = deriveTermsFromGlossary(transcript || '', entries);
    source = 'transcript-only';
  }

  const speakers = buildSpeakers(labels, speakerMap, meName);
  const actions: NoteAction[] = actionsRaw.map((a, i) => ({
    id: 'a-' + i, text: a.text, owner: a.owner, done: false,
  }));

  const segments: NoteSegment[] = lines.map((ln, i) => ({
    id: 'g' + (i + 1),
    speakerId: labelId(ln.label),
    t: ln.t,
    html: wrapTerms(escapeHtml(ln.text), terms),
  }));

  // Prefer the filename stamp — it's written once at record time and never
  // rewritten, whereas meta.json's startedAt can be clobbered by a reprocess.
  // Fall back to meta (the only source for Drive-only notes), then null.
  const startedAt = src?.startedAt ?? meta?.startedAt ?? null;
  const endsAt = meta?.endsAt ?? null;
  const lastSeg = lines.length ? lines[lines.length - 1].t : 0;
  const durationSec = Math.max(
    lastSeg + 20,
    endsAt && startedAt ? Math.round((endsAt - startedAt) / 1000) : 0,
  );
  const title = (meta?.title || src?.titleFromName || 'Untitled meeting').trim();
  const pendingTermCount = terms.length;
  const hasTranscript = !!(src?.hasTranscript || transcript);
  const hasSummary = !!(src?.hasSummary || summaryMd || noteJson);

  return {
    id: eventId,
    eventId,
    accountId,
    title,
    date: localDateStr(startedAt),
    startedAt,
    durationSec,
    status: pendingTermCount > 0 ? 'raw' : 'review',
    speakerInitials: speakers.slice(0, 4).map((s) => s.initials),
    pendingTermCount,
    stale: false,
    hasAudio: !!src?.hasAudio,
    hasTranscript,
    hasSummary,
    hue: stableHue(eventId),
    audioFile: src?.audioFile ?? null,
    summary,
    decisions,
    actions,
    openQuestions,
    followups,
    speakers,
    segments,
    terms,
    transcribedAt: meta?.startedAt ?? startedAt,
    noteAt: startedAt,
    modelVer: noteJson?.modelVer || (source === 'note-json' ? 'note-json' : 'asr · note'),
    correctedBy: null,
    source,
    peaks: peaksFromSegments(lines, durationSec, stableHue(eventId) / 90 + 1),
  };
}

// Lightweight rows for the master list. Merges local recordings (fast,
// on-disk) with the Drive archive (cross-Mac), deduped by eventId. Term
// counts come from a cheap local note.json read when present.
const sortByStart = (a: MeetingNoteSummary, b: MeetingNoteSummary): number =>
  (b.startedAt ?? 0) - (a.startedAt ?? 0);

// Local recordings on this Mac → summary map. Pure disk reads, no network.
function buildLocalNotes(): Map<string, MeetingNoteSummary> {
  const byEvent = new Map<string, MeetingNoteSummary>();
  // Track the winning audio size per event so the list row mirrors the
  // largest-wins rule in localSourcesFor — otherwise a short throwaway
  // re-record could supply the row while the opened note shows the full
  // capture (or vice-versa), an inconsistency that read as "no recording".
  const winnerSize = new Map<string, number>();
  const entries = getGlossary().entries;
  let recents: ReturnType<typeof listRecentRecordings> = [];
  try { recents = listRecentRecordings(500); } catch { /* none */ }
  for (const r of recents) {
    if (!r.eventId) continue;
    const prev = winnerSize.get(r.eventId);
    if (prev !== undefined && prev >= r.sizeBytes) continue;
    winnerSize.set(r.eventId, r.sizeBytes);
    const { startedAt, title } = parseBaseName(r.baseName);
    const meta = readCachedMeta(r.eventId);
    // Filename stamp first (immutable); meta can be clobbered by reprocess.
    const at = startedAt ?? meta?.startedAt ?? r.modifiedAt;
    byEvent.set(r.eventId, buildLocalSummary(r, meta?.title || title, at, entries));
  }
  return byEvent;
}

// Fast path: local recordings only, NO network. The Notes view renders this
// immediately so the page paints instantly, then calls listNotes() to merge
// in the cross-Mac Drive archives. Splitting this out is what fixes the
// "Notes page hangs for seconds before anything shows" — the Drive list was
// blocking the whole list behind a multi-account network round-trip.
export function listNotesLocal(): MeetingNoteSummary[] {
  return [...buildLocalNotes().values()].sort(sortByStart);
}

// Full list: local ∪ Drive archives, deduped by eventId. Awaits the network.
export async function listNotes(): Promise<MeetingNoteSummary[]> {
  const byEvent = buildLocalNotes();

  // Drive archives (cross-Mac). Fill gaps + enrich titles. Network —
  // tolerate failure so the list still shows local notes when offline.
  let archives: Awaited<ReturnType<typeof listAllMeetingArchives>> = [];
  try { archives = await listAllMeetingArchives(); } catch { /* offline */ }
  for (const a of archives) {
    const existing = byEvent.get(a.eventId);
    const at = a.meta?.startedAt ?? existing?.startedAt ?? (a.modifiedAt ? Date.parse(a.modifiedAt) : null);
    if (existing) {
      // Prefer the Drive meta title when the local filename de-slug was poor.
      if (a.meta?.title) existing.title = a.meta.title;
      existing.accountId = existing.accountId ?? a.accountId;
      existing.hasAudio = existing.hasAudio || a.has.audio;
      existing.hasTranscript = existing.hasTranscript || a.has.transcript;
      existing.hasSummary = existing.hasSummary || a.has.summary;
      continue;
    }
    byEvent.set(a.eventId, {
      id: a.eventId,
      eventId: a.eventId,
      accountId: a.accountId,
      title: (a.meta?.title || 'Untitled meeting').trim(),
      date: localDateStr(at),
      startedAt: at,
      durationSec: a.meta?.endsAt && a.meta?.startedAt
        ? Math.round((a.meta.endsAt - a.meta.startedAt) / 1000) : 0,
      status: 'review',
      speakerInitials: [],
      pendingTermCount: 0,
      stale: false,
      hasAudio: a.has.audio,
      hasTranscript: a.has.transcript,
      hasSummary: a.has.summary,
      hue: stableHue(a.eventId),
    });
  }

  return [...byEvent.values()].sort((x, y) => (y.startedAt ?? 0) - (x.startedAt ?? 0));
}

function buildLocalSummary(
  r: ReturnType<typeof listRecentRecordings>[number],
  title: string | null,
  at: number | null,
  entries: GlossaryEntry[],
): MeetingNoteSummary {
  // Speaker initials + term count from cheap local reads.
  let speakerInitials: string[] = [];
  let pendingTermCount = 0;
  const transcript = readFileSafe(r.transcriptFile);
  if (transcript) {
    const { labels } = parseTranscript(transcript);
    const meName = readContextMeName(r.audioFile);
    speakerInitials = buildSpeakers(labels, {}, meName).slice(0, 4).map((s) => s.initials);
  }
  const noteFile = r.audioFile.replace(/\.m4a$/, '.note.json');
  const noteBody = readFileSafe(fs.existsSync(noteFile) ? noteFile : null);
  if (noteBody) {
    const nj = parseNoteJson(noteBody);
    pendingTermCount = (nj?.terms || []).filter((t) => (t.heard || '').trim()).length;
  } else if (transcript) {
    pendingTermCount = deriveTermsFromGlossary(transcript, entries).length;
  }
  return {
    id: r.eventId!,
    eventId: r.eventId!,
    accountId: null,
    title: (title || 'Untitled meeting').trim(),
    date: localDateStr(at),
    startedAt: at,
    durationSec: 0,
    status: pendingTermCount > 0 ? 'raw' : 'review',
    speakerInitials,
    pendingTermCount,
    stale: false,
    hasAudio: true,
    hasTranscript: r.hasTranscript,
    hasSummary: r.hasSummary,
    hue: stableHue(r.eventId!),
  };
}
