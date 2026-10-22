// Per-key merge for the Notes correction overlay (meeting-notes.json).
//
// The overlay rides TWO whole-file last-writer-wins channels (iCloud Drive
// and Drive appdata), and the renderer used to ship each note's entire
// overlay object on every edit. Either way a stale copy — a peer that
// hadn't seen the other Mac's edit, a renderer that hadn't been told —
// silently reverted it. Same failure, same cure as the task overlay
// (CLAUDE.md invariant #11):
//
//   - Every tracked key carries a logical clock (ms). A key is one scalar
//     field of one note (`title`, `summary`, `status`, …) or ONE ENTRY of a
//     map field (`segHtml.<segId>`, `speakerNames.<spkId>`,
//     `segSpeakers.<segId>`), so two Macs editing different transcript
//     segments of the same meeting both survive.
//   - A key whose clock is set but whose value is absent is a deletion of
//     that key; deleting a whole note leaves a file-level tombstone.
//   - Combining two versions is a per-key LWW union: higher clock wins; on a
//     tie the note with the later `updatedAt` wins (that is how a clockless
//     edit from an older build still lands — it bumps updatedAt), then `a`.
//   - Legacy keys with no clock are clock 0: they survive against a side
//     that simply lacks them, and lose to any stamped change.
//
// Pure — no I/O, no clock. Main stamps (notesOverlayStore.ts); the renderer
// only diffs (`diffNoteOverlay`) to send the keys it actually changed.

import type { NoteOverlay, NoteOverlayOp, NotesOverlayFile } from './types';

/** Overlay fields whose entries merge one key at a time. */
export const NOTE_OVERLAY_MAP_FIELDS = ['speakerNames', 'segSpeakers', 'segHtml'] as const;
type MapField = (typeof NOTE_OVERLAY_MAP_FIELDS)[number];

/** Bookkeeping fields: never merged as content, never diffed. */
const META_FIELDS = new Set(['clocks', 'updatedAt']);

/** Tombstones older than this are dropped (well past any offline peer). */
export const NOTE_TOMBSTONE_RETAIN_MS = 60 * 24 * 60 * 60 * 1000;

const isMapField = (f: string): f is MapField =>
  (NOTE_OVERLAY_MAP_FIELDS as readonly string[]).includes(f);

/** Clock key for a field, or for one entry of a map field. */
export function clockKey(field: string, key?: string): string {
  return key === undefined ? field : `${field}.${key}`;
}

function splitClockKey(k: string): { field: string; key?: string } {
  const dot = k.indexOf('.');
  if (dot < 0) return { field: k };
  const field = k.slice(0, dot);
  return isMapField(field) ? { field, key: k.slice(dot + 1) } : { field: k };
}

type Entry = { present: boolean; value: unknown; clock: number };

// Flatten one note into clock-key → entry. Present values without a clock
// are legacy (clock 0); a clock with no value is a deletion.
function flatten(note: NoteOverlay | undefined): Map<string, Entry> {
  const out = new Map<string, Entry>();
  if (!note || typeof note !== 'object') return out;
  const clocks = (note.clocks && typeof note.clocks === 'object') ? note.clocks : {};
  const rec = note as Record<string, unknown>;
  for (const [field, value] of Object.entries(rec)) {
    if (META_FIELDS.has(field) || value === undefined) continue;
    if (isMapField(field)) {
      if (!value || typeof value !== 'object') continue;
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (v === undefined) continue;
        const ck = clockKey(field, k);
        out.set(ck, { present: true, value: v, clock: clocks[ck] ?? 0 });
      }
    } else {
      out.set(field, { present: true, value, clock: clocks[field] ?? 0 });
    }
  }
  for (const [ck, clock] of Object.entries(clocks)) {
    if (!out.has(ck) && Number.isFinite(clock)) out.set(ck, { present: false, value: undefined, clock });
  }
  return out;
}

// Rebuild a note from clock-key entries. Returns null when nothing is left.
function unflatten(entries: Map<string, Entry>, updatedAt: number): NoteOverlay | null {
  const note: Record<string, unknown> = {};
  const clocks: Record<string, number> = {};
  let content = false;
  for (const [ck, e] of entries) {
    if (e.clock > 0) clocks[ck] = e.clock;
    if (!e.present) continue;
    content = true;
    const { field, key } = splitClockKey(ck);
    if (key === undefined) {
      note[field] = e.value;
    } else {
      const map = (note[field] ??= {}) as Record<string, unknown>;
      map[key] = e.value;
    }
  }
  if (!content && Object.keys(clocks).length === 0) return null;
  if (Object.keys(clocks).length > 0) note.clocks = clocks;
  if (updatedAt) note.updatedAt = updatedAt;
  return note as NoteOverlay;
}

/** Deterministic serialization (sorted keys) for change detection. */
export function stableStringify(v: unknown): string {
  if (v === undefined) return 'undefined';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/** Coerce anything parsed off disk / the network into a file shape. */
export function normalizeNotesOverlayFile(raw: unknown): NotesOverlayFile {
  const r = (raw && typeof raw === 'object') ? raw as Partial<NotesOverlayFile> : {};
  const notes = (r.notes && typeof r.notes === 'object') ? r.notes : {};
  const tombstones = (r.tombstones && typeof r.tombstones === 'object') ? r.tombstones : undefined;
  return {
    version: 1,
    notes: notes as Record<string, NoteOverlay>,
    updatedAt: Number.isFinite(r.updatedAt) ? r.updatedAt as number : 0,
    ...(tombstones && Object.keys(tombstones).length > 0 ? { tombstones } : {}),
  };
}

/**
 * Union two overlay files key by key. `now` (optional) prunes tombstones
 * older than NOTE_TOMBSTONE_RETAIN_MS.
 */
export function mergeNotesOverlay(
  aRaw: NotesOverlayFile, bRaw: NotesOverlayFile, now?: number,
): NotesOverlayFile {
  const a = normalizeNotesOverlayFile(aRaw);
  const b = normalizeNotesOverlayFile(bRaw);
  const tombstones: Record<string, number> = {};
  for (const src of [a.tombstones, b.tombstones]) {
    for (const [id, t] of Object.entries(src ?? {})) {
      if (!Number.isFinite(t)) continue;
      if (now !== undefined && now - t > NOTE_TOMBSTONE_RETAIN_MS) continue;
      tombstones[id] = Math.max(tombstones[id] ?? 0, t);
    }
  }
  const notes: Record<string, NoteOverlay> = {};
  const ids = new Set([...Object.keys(a.notes), ...Object.keys(b.notes)]);
  for (const id of ids) {
    const na = a.notes[id];
    const nb = b.notes[id];
    const ua = na?.updatedAt ?? 0;
    const ub = nb?.updatedAt ?? 0;
    const fa = flatten(na);
    const fb = flatten(nb);
    const merged = new Map<string, Entry>();
    for (const ck of new Set([...fa.keys(), ...fb.keys()])) {
      const ea = fa.get(ck);
      const eb = fb.get(ck);
      let win: Entry;
      if (!ea) win = eb!;
      else if (!eb) win = ea;
      else if (ea.clock !== eb.clock) win = ea.clock > eb.clock ? ea : eb;
      else win = ub > ua ? eb : ea;
      merged.set(ck, win);
    }
    // A note-level delete wipes every key stamped at or before it; a key
    // edited after the delete (a re-record reusing the event id) survives.
    const tomb = tombstones[id];
    if (tomb !== undefined) {
      for (const [ck, e] of merged) if (e.clock <= tomb) merged.delete(ck);
    }
    const note = unflatten(merged, Math.max(ua, ub));
    if (note) notes[id] = note;
  }
  const updatedAt = Math.max(a.updatedAt, b.updatedAt);
  return {
    version: 1,
    notes,
    updatedAt,
    ...(Object.keys(tombstones).length > 0 ? { tombstones } : {}),
  };
}

/** The highest clock any key of `note` carries (0 for none). */
function maxClockOf(note: NoteOverlay | undefined): number {
  let m = 0;
  for (const e of flatten(note).values()) m = Math.max(m, e.clock);
  return m;
}

/**
 * Apply ops to one note, stamping each touched key with a clock that is
 * at least `now` and strictly after any clock it already had (so a peer's
 * skewed-ahead clock can't make a fresh local edit lose). Main only.
 */
export function applyNoteOverlayOps(
  file: NotesOverlayFile, eventId: string, ops: readonly NoteOverlayOp[], now: number,
): NotesOverlayFile {
  const base = normalizeNotesOverlayFile(file);
  if (ops.length === 0) return base;
  const entries = flatten(base.notes[eventId]);
  // A note deleted earlier: keys stamped before the tombstone stay gone,
  // and new stamps must land after it to survive the next merge.
  const tomb = base.tombstones?.[eventId] ?? 0;
  if (tomb) for (const [ck, e] of entries) if (e.clock <= tomb) entries.delete(ck);
  let stampedAt = 0;
  for (const op of expandMapOps(ops, entries)) {
    if (op.key !== undefined && !isMapField(op.field)) continue;
    if (META_FIELDS.has(op.field)) continue;
    const ck = clockKey(op.field, op.key);
    const prev = entries.get(ck)?.clock ?? 0;
    const clock = Math.max(now, prev + 1, tomb + 1);
    stampedAt = Math.max(stampedAt, clock);
    entries.set(ck, op.remove
      ? { present: false, value: undefined, clock }
      : { present: true, value: op.value, clock });
  }
  const notes = { ...base.notes };
  const note = unflatten(entries, Math.max(stampedAt, base.notes[eventId]?.updatedAt ?? 0));
  if (note) notes[eventId] = note; else delete notes[eventId];
  return { ...base, notes, updatedAt: Math.max(base.updatedAt, stampedAt) };
}

// A whole-map op (no key) on a map field becomes one op per entry, so map
// fields are only ever clocked per key: set each key it carries, remove the
// keys it dropped (or all of them, for a remove).
function expandMapOps(ops: readonly NoteOverlayOp[], entries: Map<string, Entry>): NoteOverlayOp[] {
  const out: NoteOverlayOp[] = [];
  for (const op of ops) {
    if (op.key !== undefined || !isMapField(op.field)) { out.push(op); continue; }
    const next = (!op.remove && op.value && typeof op.value === 'object')
      ? op.value as Record<string, unknown> : {};
    const prefix = `${op.field}.`;
    for (const [ck, e] of entries) {
      const key = ck.startsWith(prefix) ? ck.slice(prefix.length) : null;
      if (key !== null && e.present && !(key in next)) out.push({ field: op.field, key, remove: true });
    }
    for (const [key, value] of Object.entries(next)) {
      if (value !== undefined) out.push({ field: op.field, key, value });
    }
  }
  return out;
}

/** Delete a whole note: drop it and leave a tombstone after its last edit. */
export function tombstoneNote(
  file: NotesOverlayFile, eventId: string, now: number,
): NotesOverlayFile {
  const base = normalizeNotesOverlayFile(file);
  const t = Math.max(now, maxClockOf(base.notes[eventId]) + 1);
  const notes = { ...base.notes };
  delete notes[eventId];
  return {
    ...base,
    notes,
    updatedAt: Math.max(base.updatedAt, t),
    tombstones: { ...(base.tombstones ?? {}), [eventId]: t },
  };
}

/**
 * The ops that turn `prev` into `next` — only keys whose value actually
 * changed. The renderer sends these instead of the whole note, so a key it
 * never touched can't revert a peer's newer edit to it.
 */
export function diffNoteOverlay(prev: NoteOverlay, next: NoteOverlay): NoteOverlayOp[] {
  const ops: NoteOverlayOp[] = [];
  const p = prev as Record<string, unknown>;
  const n = next as Record<string, unknown>;
  const fields = new Set([...Object.keys(p), ...Object.keys(n)]);
  for (const field of fields) {
    if (META_FIELDS.has(field)) continue;
    const pv = p[field];
    const nv = n[field];
    if (isMapField(field)) {
      const pm = (pv && typeof pv === 'object') ? pv as Record<string, unknown> : {};
      const nm = (nv && typeof nv === 'object') ? nv as Record<string, unknown> : {};
      for (const key of new Set([...Object.keys(pm), ...Object.keys(nm)])) {
        const a = pm[key];
        const b = nm[key];
        if (stableStringify(a) === stableStringify(b)) continue;
        ops.push(b === undefined
          ? { field: field as keyof NoteOverlay, key, remove: true }
          : { field: field as keyof NoteOverlay, key, value: b });
      }
      continue;
    }
    if (stableStringify(pv) === stableStringify(nv)) continue;
    ops.push(nv === undefined
      ? { field: field as keyof NoteOverlay, remove: true }
      : { field: field as keyof NoteOverlay, value: nv });
  }
  return ops;
}
