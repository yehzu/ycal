// yCal — transcription correction glossary.
//
// Global glossary lives in cloudStore (`glossary.json`) so it follows the
// user across Macs. Per-event override sidecars live in
// `<userData>/glossary-events/<eventIdSafe>.json` — they're small,
// per-event, and travel with the meeting archive in Drive appdata
// (handled in meetingArchive.ts).
//
// Three consumption paths from `meetRecorder.postProcess`:
//   * writeWhisperPromptFile  — emits canonical entries for whisper-cli
//                               --prompt (text file, ≤ ~224-token cap).
//   * writeTranscriptFilterFile — emits JSONL of {from, to, caseSensitive}
//                                 for post-meet.sh's substitution pass.
//   * applyGlossaryToSummaryPrompt — appends a "Glossary:" block to the
//                                    Claude summary template so the note
//                                    uses canonical names.
//
// The grammar of these three consumption files is documented at the
// top of post-meet.sh.

import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import type {
  AttendeeSuggestion, EventGlossary, GlossaryEntry, GlossaryFile,
} from '@shared/types';
import { readJsonStrict, writeJson } from './cloudStore';
import { listAccountSummaries, listAllCalendars, listEvents } from './calendar';
import { getUiSettings } from './settings';

const FILE = 'glossary.json';

function emptyGlossary(): GlossaryFile {
  return { version: 1, entries: [], updatedAt: 0 };
}

function readGlossary(): { data: GlossaryFile; corrupt: boolean } {
  const result = readJsonStrict<Partial<GlossaryFile>>(FILE);
  if (result.status === 'missing' || !result.data) {
    return { data: emptyGlossary(), corrupt: result.status === 'corrupt' };
  }
  const raw = result.data;
  const entries = Array.isArray(raw.entries) ? raw.entries : [];
  return {
    data: {
      version: 1,
      entries: entries.filter((e): e is GlossaryEntry =>
        !!e && typeof e.id === 'string' && typeof e.canonical === 'string',
      ),
      updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
    },
    corrupt: false,
  };
}

function abortIfCorrupt(corrupt: boolean, op: string): boolean {
  if (!corrupt) return false;
  console.warn(
    `[yCal] ${op} aborted — glossary.json unreadable right now ` +
    '(iCloud may be syncing). Keeping current on-disk state.',
  );
  return true;
}

export function getGlossary(): GlossaryFile {
  return readGlossary().data;
}

export function setGlossary(entries: GlossaryEntry[]): GlossaryFile {
  const { corrupt } = readGlossary();
  if (abortIfCorrupt(corrupt, 'setGlossary')) return getGlossary();
  const cleaned: GlossaryEntry[] = entries
    .filter((e) => e && typeof e.canonical === 'string' && e.canonical.trim())
    .map((e) => ({
      id: typeof e.id === 'string' && e.id ? e.id : randomUUID(),
      canonical: e.canonical.trim(),
      aliases: Array.isArray(e.aliases)
        ? e.aliases
          .map((a) => (typeof a === 'string' ? a.trim() : ''))
          .filter((a) => a.length > 0)
        : [],
      category: ['person', 'company', 'product', 'term', 'other'].includes(e.category)
        ? e.category
        : 'other',
      caseSensitive: !!e.caseSensitive,
      addedAt: typeof e.addedAt === 'number' ? e.addedAt : Date.now(),
      source: ['manual', 'inline', 'import', 'attendee-seed'].includes(e.source)
        ? e.source
        : 'manual',
    }));
  const next: GlossaryFile = {
    version: 1,
    entries: cleaned,
    updatedAt: Date.now(),
  };
  writeJson(FILE, next);
  return next;
}

// Merge incoming entries into the existing glossary. For each incoming
// entry we look for an existing entry with the same canonical (case-
// insensitive) — if found we union the aliases; otherwise we add.
// Returns the merged file. Conflict (different category or
// caseSensitive flag) defers to the existing entry.
export function mergeEntries(
  incoming: GlossaryEntry[],
): { merged: GlossaryFile; added: number; updated: number } {
  const current = getGlossary();
  const byCanonical = new Map<string, GlossaryEntry>();
  for (const e of current.entries) {
    byCanonical.set(e.canonical.toLowerCase(), e);
  }
  let added = 0;
  let updated = 0;
  for (const inc of incoming) {
    if (!inc.canonical?.trim()) continue;
    const key = inc.canonical.trim().toLowerCase();
    const existing = byCanonical.get(key);
    if (existing) {
      const before = existing.aliases.length;
      const aliasSet = new Set(existing.aliases.map((a) => a.toLowerCase()));
      for (const a of inc.aliases ?? []) {
        if (!aliasSet.has(a.toLowerCase()) && a.trim()) {
          existing.aliases.push(a.trim());
          aliasSet.add(a.toLowerCase());
        }
      }
      if (existing.aliases.length > before) updated += 1;
    } else {
      const fresh: GlossaryEntry = {
        id: inc.id || randomUUID(),
        canonical: inc.canonical.trim(),
        aliases: (inc.aliases ?? []).map((a) => a.trim()).filter(Boolean),
        category: inc.category ?? 'other',
        caseSensitive: !!inc.caseSensitive,
        addedAt: inc.addedAt ?? Date.now(),
        source: inc.source ?? 'import',
      };
      current.entries.push(fresh);
      byCanonical.set(key, fresh);
      added += 1;
    }
  }
  current.updatedAt = Date.now();
  writeJson(FILE, current);
  return { merged: current, added, updated };
}

// ── Per-event override ─────────────────────────────────────────────────

function eventGlossaryDir(): string {
  return path.join(app.getPath('userData'), 'glossary-events');
}

function safeEventId(eventId: string): string {
  return eventId.replace(/[^A-Za-z0-9._@-]+/g, '-').slice(0, 200) || 'unknown';
}

function eventGlossaryPath(eventId: string): string {
  return path.join(eventGlossaryDir(), `${safeEventId(eventId)}.json`);
}

export function getEventGlossary(eventId: string): EventGlossary {
  const p = eventGlossaryPath(eventId);
  if (!fs.existsSync(p)) return { eventId, entries: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8')) as Partial<EventGlossary>;
    return {
      eventId,
      entries: Array.isArray(raw.entries) ? raw.entries.filter(
        (e): e is GlossaryEntry =>
          !!e && typeof e.id === 'string' && typeof e.canonical === 'string',
      ) : [],
    };
  } catch {
    return { eventId, entries: [] };
  }
}

export function setEventGlossary(
  eventId: string, entries: GlossaryEntry[],
): EventGlossary {
  fs.mkdirSync(eventGlossaryDir(), { recursive: true });
  const cleaned: GlossaryEntry[] = entries.map((e) => ({
    id: typeof e.id === 'string' && e.id ? e.id : randomUUID(),
    canonical: (e.canonical ?? '').trim(),
    aliases: Array.isArray(e.aliases)
      ? e.aliases.map((a) => (a ?? '').trim()).filter(Boolean) : [],
    category: e.category ?? 'other',
    caseSensitive: !!e.caseSensitive,
    addedAt: typeof e.addedAt === 'number' ? e.addedAt : Date.now(),
    source: e.source ?? 'inline',
  })).filter((e) => e.canonical.length > 0);
  const data: EventGlossary = { eventId, entries: cleaned };
  fs.writeFileSync(eventGlossaryPath(eventId), JSON.stringify(data, null, 2));
  return data;
}

// Local file used by meetingArchive to mirror to Drive appdata.
export function eventGlossaryLocalPath(eventId: string): string {
  return eventGlossaryPath(eventId);
}

// ── Effective glossary (global ∪ per-event) ────────────────────────────
// Per-event entries win when the same canonical exists in both, but the
// global aliases are union'd in so we get both sets of misrecognitions.

export function getEffectiveEntries(eventId: string | null): GlossaryEntry[] {
  const global = getGlossary().entries;
  if (!eventId) return [...global];
  const eventEntries = getEventGlossary(eventId).entries;
  if (eventEntries.length === 0) return [...global];
  const byCanonical = new Map<string, GlossaryEntry>();
  for (const e of global) byCanonical.set(e.canonical.toLowerCase(), { ...e });
  for (const e of eventEntries) {
    const key = e.canonical.toLowerCase();
    const existing = byCanonical.get(key);
    if (existing) {
      const aliasSet = new Set(existing.aliases.map((a) => a.toLowerCase()));
      for (const a of e.aliases) {
        if (!aliasSet.has(a.toLowerCase())) existing.aliases.push(a);
      }
    } else {
      byCanonical.set(key, { ...e });
    }
  }
  return [...byCanonical.values()];
}

// ── post-meet.sh integration ──────────────────────────────────────────
//
// We write two sidecar files under <userData>/glossary-runtime/<runId>/
// before invoking post-meet.sh and clean them up after the script
// returns. Keeping them outside ~/Recordings/yCal/ avoids polluting the
// user-visible recordings dir.

function runtimeDir(): string {
  return path.join(app.getPath('userData'), 'glossary-runtime');
}

// Whisper.cpp's --prompt has a soft ceiling of ~224 tokens. Heuristic
// cap: roughly 800 characters or 30 canonical entries — whichever hits
// first. We feed canonicals (not aliases) because the prompt is used by
// the decoder to bias token probabilities; canonicals are the words we
// want it to PREDICT.
const WHISPER_PROMPT_MAX_CHARS = 800;
const WHISPER_PROMPT_MAX_ENTRIES = 30;

export interface GlossaryRuntime {
  whisperPromptFile: string | null;
  filterFile: string | null;
  cleanup: () => void;
}

export function buildRuntimeFiles(
  entries: GlossaryEntry[],
): GlossaryRuntime {
  if (entries.length === 0) {
    return { whisperPromptFile: null, filterFile: null, cleanup: () => {} };
  }
  const dir = path.join(runtimeDir(), `${process.pid}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });

  // ── Whisper prompt: canonicals only, joined by ", ", capped. ──────
  const canonicals: string[] = [];
  let charsSoFar = 0;
  for (const e of entries.slice(0, WHISPER_PROMPT_MAX_ENTRIES)) {
    const c = e.canonical.trim();
    if (!c) continue;
    if (charsSoFar + c.length + 2 > WHISPER_PROMPT_MAX_CHARS) break;
    canonicals.push(c);
    charsSoFar += c.length + 2;
  }
  let whisperFile: string | null = null;
  if (canonicals.length > 0) {
    whisperFile = path.join(dir, 'whisper-prompt.txt');
    // Whisper's prompt works better as a brief glossary-like sentence
    // than a comma-dump. Use a "context" framing so the decoder treats
    // them as expected vocabulary rather than a list to copy verbatim.
    const body =
      `Context: this recording uses the following names and terms — ${canonicals.join(', ')}.\n`;
    fs.writeFileSync(whisperFile, body);
  }

  // ── Substitution JSONL — one {from, to, caseSensitive} per line. ───
  const filterLines: string[] = [];
  for (const e of entries) {
    for (const alias of e.aliases) {
      const from = alias.trim();
      if (!from) continue;
      if (from.toLowerCase() === e.canonical.toLowerCase()) continue;
      filterLines.push(JSON.stringify({
        from,
        to: e.canonical,
        caseSensitive: !!e.caseSensitive,
      }));
    }
  }
  let filterFile: string | null = null;
  if (filterLines.length > 0) {
    filterFile = path.join(dir, 'transcript-filter.jsonl');
    fs.writeFileSync(filterFile, `${filterLines.join('\n')}\n`);
  }

  return {
    whisperPromptFile: whisperFile,
    filterFile,
    cleanup: () => {
      try {
        if (whisperFile && fs.existsSync(whisperFile)) fs.unlinkSync(whisperFile);
        if (filterFile && fs.existsSync(filterFile)) fs.unlinkSync(filterFile);
        try { fs.rmdirSync(dir); } catch { /* dir may have other files in race */ }
      } catch { /* best-effort cleanup */ }
    },
  };
}

// Append a Glossary section to the Claude summary prompt template.
// post-meet.sh reads the resulting template from YCAL_SUMMARY_PROMPT.
// We splice this in even when the user has a custom prompt — appending
// at the end so the user's own instructions still lead.
export function applyGlossaryToSummaryPrompt(
  baseTemplate: string, entries: GlossaryEntry[],
): string {
  if (entries.length === 0) return baseTemplate;
  const lines: string[] = [];
  lines.push('');
  lines.push('## Glossary (correct spelling for names + terms)');
  for (const e of entries.slice(0, 80)) {
    const aliases = e.aliases.length > 0
      ? ` (transcript may say: ${e.aliases.join(', ')})`
      : '';
    lines.push(`- **${e.canonical}**${aliases}`);
  }
  lines.push(
    'When you encounter any of the alias spellings above, use the canonical name in the summary.',
  );
  // Place the Glossary BEFORE the closing constraints line so it lands
  // inside the prompt body rather than after the trailing terminator.
  // We do a simple end-append; Claude reads top-to-bottom anyway.
  return `${baseTemplate}\n${lines.join('\n')}\n`;
}

// ── Attendee suggestions ──────────────────────────────────────────────
// Walk the last `lookBackDays` of calendar events, collect attendees,
// deduplicate by email, sort by frequency desc. Used by the Settings UI
// to seed the glossary with names the user actually meets with.

export async function suggestAttendeesFromCalendar(
  lookBackDays = 60,
): Promise<AttendeeSuggestion[]> {
  const accounts = listAccountSummaries();
  if (accounts.length === 0) return [];
  let allCals: Awaited<ReturnType<typeof listAllCalendars>>;
  try {
    allCals = await listAllCalendars();
  } catch (e) {
    console.error('[yCal glossary] listAllCalendars failed', e);
    return [];
  }
  const ui = getUiSettings();
  // Same visibility filter the recorder uses — only count attendees from
  // calendars the user actually looks at.
  const targets = allCals.filter((c) => {
    if (ui.accountsActive[c.accountId] === false) return false;
    const k = `${c.accountId}|${c.id}`;
    const visible = ui.calVisible[k] ?? c.selected;
    if (!visible) return false;
    const role = ui.calRoles[k] ?? 'normal';
    return role === 'normal';
  });
  if (targets.length === 0) return [];
  const now = Date.now();
  const timeMin = new Date(now - lookBackDays * 24 * 60 * 60 * 1000).toISOString();
  const timeMax = new Date(now + 24 * 60 * 60 * 1000).toISOString();
  let events: Awaited<ReturnType<typeof listEvents>>['events'];
  try {
    const result = await listEvents({
      timeMin, timeMax,
      calendarIds: Array.from(new Set(targets.map((c) => c.id))),
    });
    events = result.events;
  } catch (e) {
    console.error('[yCal glossary] listEvents failed', e);
    return [];
  }
  const counts = new Map<string, AttendeeSuggestion>();
  for (const ev of events) {
    if (!ev.attendees) continue;
    for (const a of ev.attendees) {
      if (!a.email) continue;
      if (a.self) continue;
      if (a.resource) continue;
      const email = a.email.toLowerCase();
      const name = a.name?.trim() || email.split('@')[0];
      const existing = counts.get(email);
      const eventDate = (ev.start ?? '').slice(0, 10);
      if (existing) {
        existing.count += 1;
        if (eventDate && eventDate > existing.lastSeen) existing.lastSeen = eventDate;
      } else {
        counts.set(email, {
          name,
          email,
          count: 1,
          lastSeen: eventDate,
        });
      }
    }
  }
  return [...counts.values()].sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return b.lastSeen.localeCompare(a.lastSeen);
  });
}

// Convert one attendee suggestion into a person-category entry. The UI
// adds these one-at-a-time so the user can edit aliases (initially
// empty — they fill in as they spot misrecognitions).
export function suggestionToEntry(s: AttendeeSuggestion): GlossaryEntry {
  return {
    id: randomUUID(),
    canonical: s.name,
    aliases: [],
    category: 'person',
    addedAt: Date.now(),
    source: 'attendee-seed',
  };
}
