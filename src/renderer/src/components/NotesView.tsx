// yCal — Meeting notes / transcript review view.
//
// Master list (left) + the note as a single editorial document (right).
// The note is the OUTPUT of the recording pipeline: audio → transcript
// (whisper) → fix transcript (glossary) → meeting note (claude). The
// document is summary-first: you live in the summary and only open the
// transcript when a noun got mis-heard. Flagged terms are surfaced at the
// summary level so they can be fixed (via the glossary or a manual pick)
// without reading the transcript; reprocessing regenerates the note.
//
// Base notes come from main (src/main/notesStore.ts); corrections live in
// a cloudStore overlay and are merged over the base here. Reprocess actions
// drive the REAL pipeline (recorderReprocess / recorderResummarize); "Apply
// dictionary" rewrites terms locally in the overlay (instant, no re-run).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  GlossaryCategory, MeetingNote, MeetingNoteSummary, NoteAction, NoteOverlay,
  NoteSegment, NoteSpeaker, NoteStatus, NoteTerm, RecordingStatus,
} from '@shared/types';
import {
  DOW_LONG, MONTH_NAMES, MONTH_SHORT, formatTime, ordinal,
} from '../dates';
import { useMeetingNotes } from '../notes';
import { useGlossary, type GlossaryStore } from '../glossary';

// ── status palette (mirrors the design's NT_STATUS) ─────────────────────
const NT_STATUS: Record<NoteStatus, { label: string; dot: string }> = {
  raw: { label: 'Needs review', dot: 'oklch(0.62 0.16 40)' },
  review: { label: 'In review', dot: 'oklch(0.66 0.13 86)' },
  corrected: { label: 'Corrected', dot: 'oklch(0.55 0.10 150)' },
};

// UI term-type ↔ glossary category. The flagged-term chips and dictionary
// use the design's vocabulary (name/term/org/region/project); the glossary
// stores GlossaryCategory.
const TYPE_TO_CAT: Record<string, GlossaryCategory> = {
  name: 'person', org: 'company', project: 'product', term: 'term',
  region: 'other', other: 'other',
};
const CAT_TO_TYPE: Record<GlossaryCategory, string> = {
  person: 'name', company: 'org', product: 'project', term: 'term', other: 'term',
};

interface Fix { heard: string; correct: string; termId?: string }

// ── helpers ─────────────────────────────────────────────────────────────
function ntTime(sec: number): string {
  const s0 = Math.max(0, Math.round(sec));
  const h = Math.floor(s0 / 3600);
  const m = Math.floor((s0 % 3600) / 60);
  const s = s0 % 60;
  const p = (x: number): string => String(x).padStart(2, '0');
  return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
}

function fmtStamp(ms: number | null): string {
  if (!ms) return '—';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '—';
  const time = formatTime(d);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return time;
  return MONTH_SHORT[d.getMonth()] + ' ' + d.getDate() + ' · ' + time;
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function spkColor(hue: number): string {
  return `oklch(0.53 0.10 ${hue})`;
}

function ntReplaceAll(str: string, list: Fix[]): string {
  let s = str;
  list.forEach(({ heard, correct }) => { s = s.split(heard).join(correct); });
  return s;
}

function stripHtml(html: string): string {
  const d = document.createElement('div'); d.innerHTML = html;
  return d.textContent || '';
}

// Render a lightweight subset of inline markdown (**bold**, __bold__,
// `code`) to safe HTML for the editorial note body (summary / decisions /
// actions). The LLM emits **bold** in these fields; without this they'd
// show the literal asterisks. Everything is HTML-escaped first — only our
// own <strong>/<code> markup is injected.
function mdInline(s: string): string {
  const esc = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return esc
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+?)__/g, '<strong>$1</strong>');
}

// Inverse of mdInline: turn a committed contentEditable fragment back into
// the markdown text we store, so bold survives an edit (and a later
// reprocess, which re-emits markdown). Bold/code round-trip; any other
// rich formatting the browser injected is flattened to plain text.
function htmlToInline(html: string): string {
  const s = html
    .replace(/<\/(strong|b)>/gi, '**').replace(/<(strong|b)(\s[^>]*)?>/gi, '**')
    .replace(/<\/code>/gi, '`').replace(/<code(\s[^>]*)?>/gi, '`')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '');
  const dec = document.createElement('textarea');
  dec.innerHTML = s;
  return dec.value.replace(/\*\*\s*\*\*/g, '').trim();
}

// Unwrap any <span class="nt-lc"> whose text matches a heard variant,
// dropping in the correction. Returns a {segId: html} patch of changed lines.
function ntApplyToSegments(segments: EffSegment[], list: Fix[]): Record<string, string> {
  const patch: Record<string, string> = {};
  segments.forEach((g) => {
    if (!g.html.includes('nt-lc')) return;
    const d = document.createElement('div'); d.innerHTML = g.html;
    let changed = false;
    d.querySelectorAll('span.nt-lc').forEach((sp) => {
      const text = (sp.textContent || '').toLowerCase();
      const m = list.find(({ heard }) => heard.toLowerCase() === text);
      if (m) { sp.replaceWith(document.createTextNode(m.correct)); changed = true; }
    });
    if (changed) patch[g.id] = d.innerHTML;
  });
  return patch;
}

// Replace a selected phrase with its correction inside transcript segments,
// touching TEXT NODES only (never tag names / attributes), so an arbitrary
// selection — not just a flagged span — gets fixed in place. Returns a
// {segId: html} patch of changed lines.
function ntReplaceTextInSegments(
  segments: EffSegment[], token: string, correct: string,
): Record<string, string> {
  const patch: Record<string, string> = {};
  const lc = token.toLowerCase();
  const re = new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  segments.forEach((g) => {
    if (!g.html.toLowerCase().includes(lc)) return;
    const d = document.createElement('div'); d.innerHTML = g.html;
    let changed = false;
    const walk = (node: Node): void => {
      node.childNodes.forEach((child) => {
        if (child.nodeType === 3) {
          const t = child.textContent || '';
          if (t.toLowerCase().includes(lc)) {
            const nt = t.replace(re, correct);
            if (nt !== t) { child.textContent = nt; changed = true; }
          }
        } else if (child.nodeType === 1) {
          walk(child);
        }
      });
    };
    walk(d);
    if (changed) patch[g.id] = d.innerHTML;
  });
  return patch;
}

// Cheap category guess for a freshly-corrected term (matches TranscriptSheet).
function guessCategory(canonical: string): GlossaryCategory {
  if (/^[A-Z][a-zA-Z]+(\s[A-Z][a-zA-Z]+)?$/.test(canonical)) return 'person';
  if (/^[A-Z][A-Z0-9]+$/.test(canonical)) return 'term';
  return 'other';
}

function newGlossaryId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// ── effective (base + overlay) merge ─────────────────────────────────────
interface EffSegment { id: string; speakerId: string; t: number; html: string }
interface EffNote extends Omit<MeetingNote, 'segments' | 'speakers'> {
  speakers: NoteSpeaker[];
  segments: EffSegment[];
  resolvedTermIds: string[];
  transcriptTouchedAt: number | null;
  reprocessContext: string;
}

// An empty overlay array must NOT override a populated base. The bug it
// guards against: a term-fix applied while the note was still processing
// (base summary/decisions/actions empty) used to persist `[]` into the
// overlay; once the summary landed in the base, `e.summary ?? base.summary`
// returned the stale `[]` and the whole note read as empty. Treating an
// empty override as "no edit" both repairs those notes and is the intuitive
// rule (the user can still edit individual points away). The write side
// (applyFixes / applyManualFix) also stops persisting empty arrays.
function pickArr<T>(over: T[] | undefined, base: T[]): T[] {
  return over && over.length ? over : base;
}

function effectiveNote(base: MeetingNote, ov: NoteOverlay | undefined): EffNote {
  const e = ov ?? {};
  const names = e.speakerNames ?? {};
  const speakers = base.speakers.map((s) => {
    const nm = names[s.id];
    return nm ? { ...s, name: nm, initials: initialsOf(nm) } : s;
  });
  const segSp = e.segSpeakers ?? {};
  const segHtml = e.segHtml ?? {};
  const segments: EffSegment[] = base.segments.map((g) => ({
    id: g.id,
    t: g.t,
    speakerId: segSp[g.id] ?? g.speakerId,
    html: (g.id in segHtml) ? segHtml[g.id] : g.html,
  }));
  return {
    ...base,
    title: e.title ?? base.title,
    status: e.status ?? base.status,
    summary: pickArr(e.summary, base.summary),
    decisions: pickArr(e.decisions, base.decisions),
    actions: pickArr(e.actions, base.actions),
    speakers,
    segments,
    terms: base.terms,
    resolvedTermIds: e.resolvedTermIds ?? [],
    noteAt: e.noteAt ?? base.noteAt,
    transcriptTouchedAt: e.transcriptTouchedAt ?? null,
    reprocessContext: e.reprocessContext ?? '',
    correctedBy: e.correctedBy ?? base.correctedBy,
  };
}

function effectiveStatus(s: MeetingNoteSummary, ov: NoteOverlay | undefined): NoteStatus {
  return ov?.status ?? s.status;
}
function effectivePending(s: MeetingNoteSummary, ov: NoteOverlay | undefined): number {
  const resolved = ov?.resolvedTermIds?.length ?? 0;
  return Math.max(0, s.pendingTermCount - resolved);
}

function pendingTermsOf(note: EffNote): NoteTerm[] {
  return note.terms.filter((t) => !note.resolvedTermIds.includes(t.id));
}
function pendingFlags(note: EffNote): number {
  return note.segments.reduce(
    (acc, g) => acc + (g.html.match(/class="nt-lc"/g) || []).length, 0);
}
function isStale(note: EffNote): boolean {
  if (!note.transcriptTouchedAt || !note.noteAt) return false;
  return note.transcriptTouchedAt > note.noteAt;
}

// ── reusable inline-editable surface (ported from the design) ────────────
function Editable({
  html, text, tag, className, placeholder, singleLine, onCommit, style, dataSegId,
}: {
  html?: string; text?: string; tag?: 'div' | 'h1'; className?: string;
  placeholder?: string; singleLine?: boolean;
  onCommit?: (v: string) => void; style?: React.CSSProperties; dataSegId?: string;
}) {
  const ref = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || document.activeElement === el) return;
    if (html != null) { if (el.innerHTML !== html) el.innerHTML = html; }
    else { const t = text || ''; if (el.innerText !== t) el.innerText = t; }
  });
  const commit = (): void => {
    const el = ref.current; if (!el) return;
    onCommit && onCommit(html != null ? el.innerHTML : el.innerText);
  };
  const Tag: 'div' | 'h1' = tag || 'div';
  return (
    <Tag
      ref={ref as never}
      className={className}
      style={style}
      contentEditable
      suppressContentEditableWarning
      data-nt-edit=""
      data-placeholder={placeholder}
      data-seg-id={dataSegId}
      spellCheck={false}
      onBlur={commit}
      onKeyDown={(ev) => {
        if (singleLine && ev.key === 'Enter') { ev.preventDefault(); (ev.currentTarget as HTMLElement).blur(); }
      }}
    />
  );
}

// ── top-level view ───────────────────────────────────────────────────────
export function NotesView({
  selectedId, onSelectId,
}: { selectedId: string | null; onSelectId: (id: string | null) => void }) {
  const store = useMeetingNotes();
  const glossary = useGlossary();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'open' | 'corrected'>('all');
  const [savedTick, setSavedTick] = useState(0);
  const flash = useCallback(() => setSavedTick(Date.now()), []);

  // Track live recorder status so the Notes view shows a "reprocessing"
  // indicator + progress — including reprocesses kicked off from the event
  // popover — and refreshes the note/list when the pipeline finishes.
  const [recById, setRecById] = useState<Record<string, RecordingStatus>>({});
  useEffect(() => {
    let cancelled = false;
    const apply = (list: RecordingStatus[]): void => {
      if (cancelled) return;
      const next: Record<string, RecordingStatus> = {};
      list.forEach((r) => { next[r.eventId] = r; });
      setRecById(next);
    };
    void window.ycal.recorderList().then(apply);
    const off = window.ycal.onRecorderStatusChanged(apply);
    return () => { cancelled = true; off(); };
  }, []);
  const prevRecState = useRef<Record<string, string>>({});
  useEffect(() => {
    Object.values(recById).forEach((r) => {
      const was = prevRecState.current[r.eventId];
      if (r.state === 'done' && was && was !== 'done') {
        // The pipeline regenerated this meeting's note — pull it fresh and
        // refresh the list (date/speakers/term count may all have changed).
        void store.reloadNote(r.eventId, r.accountId ?? null);
        void store.refreshList();
        // Clear the "out of date" hint only when the user actually had edits.
        if (store.overlay.notes[r.eventId]?.transcriptTouchedAt) {
          store.patchOverlay(r.eventId, (c) => ({ ...c, noteAt: Date.now(), transcriptTouchedAt: undefined }));
        }
      }
      prevRecState.current[r.eventId] = r.state;
    });
  }, [recById, store]);

  const overlayFor = useCallback(
    (id: string): NoteOverlay | undefined => store.overlay.notes[id],
    [store.overlay],
  );

  const counts = useMemo(() => {
    let open = 0, corrected = 0;
    store.summaries.forEach((s) => {
      if (effectiveStatus(s, overlayFor(s.id)) === 'corrected') corrected++; else open++;
    });
    return { all: store.summaries.length, open, corrected };
  }, [store.summaries, overlayFor]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return store.summaries.filter((s) => {
      const st = effectiveStatus(s, overlayFor(s.id));
      if (filter === 'open' && st === 'corrected') return false;
      if (filter === 'corrected' && st !== 'corrected') return false;
      if (!q) return true;
      const ov = overlayFor(s.id);
      const title = (ov?.title ?? s.title).toLowerCase();
      return title.includes(q);
    });
  }, [store.summaries, query, filter, overlayFor]);

  // Default-select the most recent note, and keep selection valid.
  useEffect(() => {
    if (!store.summaries.length) return;
    if (!selectedId || !store.summaries.some((s) => s.id === selectedId)) {
      onSelectId(store.summaries[0].id);
    }
  }, [store.summaries, selectedId, onSelectId]);

  // Lazily load the full base note for the selection.
  const selSummary = selectedId ? store.summaries.find((s) => s.id === selectedId) ?? null : null;
  useEffect(() => {
    if (selSummary) void store.ensureNote(selSummary.id, selSummary.accountId);
  }, [selSummary?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const base = selectedId ? store.bases[selectedId] : null;

  return (
    <div className="notes-view" data-screen-label="Meeting Notes">
      <NotesList
        summaries={filtered}
        overlay={store.overlay}
        recById={recById}
        counts={counts}
        query={query} setQuery={setQuery}
        filter={filter} setFilter={setFilter}
        selectedId={selectedId} onSelect={onSelectId}
        loading={store.loading}
      />
      {base ? (
        <NoteDoc
          key={base.id}
          base={base}
          overlay={overlayFor(base.id)}
          recStatus={recById[base.id] ?? null}
          patchOverlay={store.patchOverlay}
          glossary={glossary}
          savedTick={savedTick}
          flash={flash}
        />
      ) : selSummary ? (
        <div className="nt-doc"><div className="nt-doc-empty">
          <div className="gl">¶</div>
          <div className="t">Loading the minutes…</div>
        </div></div>
      ) : (
        <div className="nt-doc"><div className="nt-doc-empty">
          <div className="gl">¶</div>
          <div className="t">{store.summaries.length
            ? 'Select a meeting to read its minutes.'
            : 'No recorded meetings yet. Record one from an event’s popover.'}</div>
        </div></div>
      )}
    </div>
  );
}

// ── left list ─────────────────────────────────────────────────────────────
function NotesList({
  summaries, overlay, recById, counts, query, setQuery, filter, setFilter,
  selectedId, onSelect, loading,
}: {
  summaries: MeetingNoteSummary[];
  overlay: { notes: Record<string, NoteOverlay> };
  recById: Record<string, RecordingStatus>;
  counts: { all: number; open: number; corrected: number };
  query: string; setQuery: (v: string) => void;
  filter: 'all' | 'open' | 'corrected'; setFilter: (v: 'all' | 'open' | 'corrected') => void;
  selectedId: string | null; onSelect: (id: string) => void;
  loading: boolean;
}) {
  const busyOf = (id: string): boolean => {
    const s = recById[id]?.state;
    return s === 'processing' || s === 'uploading';
  };
  const groups = useMemo(() => {
    const sorted = [...summaries].sort((a, b) => b.date.localeCompare(a.date));
    const out: Array<{ date: string; items: MeetingNoteSummary[] }> = [];
    let cur: { date: string; items: MeetingNoteSummary[] } | null = null;
    sorted.forEach((n) => {
      if (!cur || cur.date !== n.date) { cur = { date: n.date, items: [] }; out.push(cur); }
      cur.items.push(n);
    });
    return out;
  }, [summaries]);
  const fmtGroup = (d: string): string => {
    const dt = new Date(d + 'T00:00:00');
    if (Number.isNaN(dt.getTime())) return d;
    return DOW_LONG[dt.getDay()] + ', ' + MONTH_NAMES[dt.getMonth()] + ' ' + ordinal(dt.getDate());
  };
  return (
    <aside className="nt-list">
      <div className="nt-list-head">
        <div className="nt-list-h">
          <span className="lbl">Minutes</span>
          <span className="ct">{counts.all} recorded</span>
        </div>
        <div className="nt-search">
          <svg className="ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
            <circle cx="7" cy="7" r="4.5" /><path d="M11 11l3 3" strokeLinecap="round" />
          </svg>
          <input value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder="Search meetings…" />
        </div>
        <div className="nt-filters">
          {([['all', 'All', counts.all], ['open', 'Needs review', counts.open], ['corrected', 'Corrected', counts.corrected]] as const).map(
            ([k, lbl, n]) => (
              <button key={k} aria-pressed={filter === k} onClick={() => setFilter(k)}>
                {lbl}<span className="n">{n}</span>
              </button>
            ))}
        </div>
      </div>
      <div className="nt-list-scroll">
        {loading && groups.length === 0 && <div className="nt-list-empty">Loading meetings…</div>}
        {!loading && groups.length === 0 && <div className="nt-list-empty">No minutes match.</div>}
        {groups.map((g) => (
          <div key={g.date}>
            <div className="nt-group-h">
              <span>{fmtGroup(g.date)}</span>
              <span className="wk">{g.items.length} {g.items.length === 1 ? 'note' : 'notes'}</span>
            </div>
            {g.items.map((n) => (
              <NoteCard
                key={n.id} note={n} ov={overlay.notes[n.id]} busy={busyOf(n.id)}
                active={n.id === selectedId} onClick={() => onSelect(n.id)}
              />
            ))}
          </div>
        ))}
      </div>
    </aside>
  );
}

function NoteCard({
  note, ov, busy, active, onClick,
}: { note: MeetingNoteSummary; ov: NoteOverlay | undefined; busy: boolean; active: boolean; onClick: () => void }) {
  const status = effectiveStatus(note, ov);
  const st = NT_STATUS[status];
  const pend = effectivePending(note, ov);
  const col = spkColor(note.hue);
  const start = note.startedAt ? formatTime(new Date(note.startedAt)) : null;
  const initials = note.speakerInitials;
  return (
    <button
      className={'nt-card' + (active ? ' active' : '')}
      onClick={onClick}
      style={{ ['--cal' as never]: col }}
    >
      <div className="nt-card-top">
        {start && <span className="nt-card-time">{start}</span>}
        <span className="nt-card-cal"><span className="sw" />{note.hasAudio ? 'Recording' : 'Drive'}</span>
      </div>
      <div className="nt-card-ttl">{ov?.title ?? note.title}</div>
      <div className="nt-card-meta">
        <span className="nt-card-status" style={{ ['--st' as never]: st.dot }}>
          <span className="d" />{st.label}
        </span>
        {initials.length > 0 && (
          <span className="nt-card-avatars">
            {initials.slice(0, 4).map((ini, i) => (
              <span key={i} className="a" style={{ background: spkColor((note.hue + i * 47) % 360) }}>{ini}</span>
            ))}
          </span>
        )}
        {busy ? (
          <span className="nt-card-flags nt-card-busy">↻ reprocessing</span>
        ) : pend > 0 && (
          <span className="nt-card-flags" style={{ ['--st' as never]: st.dot }}>
            {pend} term{pend === 1 ? '' : 's'}
          </span>
        )}
      </div>
    </button>
  );
}

// ── right document ──────────────────────────────────────────────────────
function NoteDoc({
  base, overlay, recStatus, patchOverlay, glossary, savedTick, flash,
}: {
  base: MeetingNote;
  overlay: NoteOverlay | undefined;
  recStatus: RecordingStatus | null;
  patchOverlay: (eventId: string, fn: (cur: NoteOverlay) => NoteOverlay) => void;
  glossary: GlossaryStore;
  savedTick: number;
  flash: () => void;
}) {
  const note = useMemo(() => effectiveNote(base, overlay), [base, overlay]);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const secRefs = useRef<Record<string, HTMLElement | null>>({});
  const reprocBtnRef = useRef<HTMLButtonElement | null>(null);
  const [activeSec, setActiveSec] = useState('summary');
  const [reprocOpen, setReprocOpen] = useState(false);
  const [dictOpen, setDictOpen] = useState(false);
  const [dictPrefill, setDictPrefill] = useState<{ heard: string } | null>(null);

  // ── overlay mutators (all flash "saved") ──
  const P = useCallback((fn: (c: NoteOverlay) => NoteOverlay) => {
    patchOverlay(base.id, fn); flash();
  }, [patchOverlay, base.id, flash]);
  const setField = <K extends keyof NoteOverlay>(k: K, v: NoteOverlay[K]): void =>
    P((c) => ({ ...c, [k]: v }));
  const setListItem = (k: 'summary' | 'decisions', i: number, v: string): void => {
    const a = [...note[k]]; a[i] = v; setField(k, a);
  };
  const addListItem = (k: 'summary' | 'decisions', v: string): void =>
    setField(k, [...note[k], v]);
  const removeListItem = (k: 'summary' | 'decisions', i: number): void =>
    setField(k, note[k].filter((_, j) => j !== i));
  const setActions = (arr: NoteAction[]): void => setField('actions', arr);

  const setSegHtml = (segId: string, html: string): void =>
    P((c) => ({
      ...c,
      segHtml: { ...(c.segHtml || {}), [segId]: html },
      transcriptTouchedAt: Date.now(),
    }));
  const setSegSpeaker = (segId: string, spId: string): void =>
    P((c) => ({ ...c, segSpeakers: { ...(c.segSpeakers || {}), [segId]: spId } }));
  const renameSpeaker = (spId: string, name: string): void =>
    P((c) => ({ ...c, speakerNames: { ...(c.speakerNames || {}), [spId]: name } }));

  const resolveAllFlags = (): void => {
    const map: Record<string, string> = {};
    note.segments.forEach((g) => {
      if (!g.html.includes('nt-lc')) return;
      const d = document.createElement('div'); d.innerHTML = g.html;
      d.querySelectorAll('.nt-lc').forEach((s) =>
        s.parentNode?.replaceChild(document.createTextNode(s.textContent || ''), s));
      map[g.id] = d.innerHTML;
    });
    P((c) => ({
      ...c, segHtml: { ...(c.segHtml || {}), ...map }, transcriptTouchedAt: Date.now(),
    }));
  };

  // ── audio scrubber (real playback via the ycal-media stream) ──
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [cur, setCur] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [dur, setDur] = useState(base.durationSec);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  useEffect(() => { setCur(0); setPlaying(false); setDur(base.durationSec); }, [base.id, base.durationSec]);
  // Resolve a playable URL: a local m4a streams directly; a Drive-only note
  // (recorded on another Mac) is fetched into the local cache first, then
  // streamed from there. The path is validated in main before serving.
  useEffect(() => {
    let cancelled = false;
    setAudioUrl(null);
    const toUrl = (p: string): string => 'ycal-media://audio/?p=' + encodeURIComponent(p);
    if (base.audioFile) {
      setAudioUrl(toUrl(base.audioFile));
    } else if (base.accountId) {
      void window.ycal.meetingArchiveFetch({ eventId: base.id, accountId: base.accountId, kind: 'audio' })
        .then((r) => { if (!cancelled && r.ok) setAudioUrl(toUrl(r.path)); });
    }
    return () => { cancelled = true; };
  }, [base.id, base.audioFile, base.accountId]);
  const activeSegId = useMemo(() => {
    let id: string | null = null;
    note.segments.forEach((g) => { if (g.t <= cur) id = g.id; });
    return id;
  }, [cur, note.segments]);
  const togglePlay = (): void => {
    const a = audioRef.current; if (!a || !audioUrl) return;
    if (a.paused) void a.play().catch(() => undefined); else a.pause();
  };
  const seekTo = (sec: number): void => {
    const a = audioRef.current;
    if (a && Number.isFinite(a.duration)) a.currentTime = Math.max(0, Math.min(a.duration, sec));
    setCur(Math.max(0, Math.min(dur || base.durationSec, sec)));
  };

  // ── transcript open/closed (persisted in overlay-free local state) ──
  const [transcriptOpen, setTranscriptOpen] = useState(false);

  // ── derived pipeline state ──
  const pendTerms = pendingTermsOf(note);
  const flags = pendingFlags(note);
  const stale = isStale(note);
  const dictFixFor = useCallback((heard: string): string | null => {
    const h = heard.trim().toLowerCase();
    for (const e of glossary.file.entries) {
      if (e.canonical.toLowerCase() === h) return e.canonical;
      if (e.aliases.some((a) => a.toLowerCase() === h)) return e.canonical;
    }
    return null;
  }, [glossary.file.entries]);
  const suggestionFor = (t: NoteTerm): string | null => t.suggestion || dictFixFor(t.heard);

  // ── term fixes (instant, local — rewrites the overlay) ──
  const applyFixes = (list: Fix[]): void => {
    if (!list.length) return;
    const segPatch = ntApplyToSegments(note.segments, list);
    P((c) => ({
      ...c,
      // Only persist note-body arrays when they have content — writing an
      // empty array while the note is still processing would clobber the
      // base summary once it lands (see pickArr / effectiveNote).
      ...(note.summary.length ? { summary: note.summary.map((s) => ntReplaceAll(s, list)) } : {}),
      ...(note.decisions.length ? { decisions: note.decisions.map((s) => ntReplaceAll(s, list)) } : {}),
      ...(note.actions.length ? { actions: note.actions.map((a) => ({ ...a, text: ntReplaceAll(a.text, list) })) } : {}),
      segHtml: { ...(c.segHtml || {}), ...segPatch },
      resolvedTermIds: Array.from(new Set([
        ...(c.resolvedTermIds || []),
        ...list.map((x) => x.termId).filter((x): x is string => !!x),
      ])),
      transcriptTouchedAt: Date.now(),
    }));
  };
  const dictResolvableFixes = (): Fix[] => pendTerms
    .map((t): Fix | null => {
      const c = suggestionFor(t);
      return c ? { heard: t.heard, correct: c, termId: t.id } : null;
    })
    .filter((x): x is Fix => x !== null);
  const fixOneTerm = (term: NoteTerm): void => {
    const c = suggestionFor(term);
    if (c) {
      applyFixes([{ heard: term.heard, correct: c, termId: term.id }]);
      // Make the fix stick across reprocesses: teach the glossary.
      if (!dictFixFor(term.heard)) {
        void glossary.addEntry({
          canonical: c, aliases: [term.heard],
          category: TYPE_TO_CAT[term.type] ?? 'other', source: 'inline',
        });
      }
    } else {
      setDictPrefill({ heard: term.heard });
      setDictOpen(true);
    }
  };

  // ── reprocess (REAL pipeline) ──
  // recStatus is supplied by NotesView (one shared subscription), so a
  // reprocess kicked off from the event popover still shows progress here.
  // `reproc` is just the local "I just clicked" flag — it shows the overlay
  // instantly (before the recorder's first push) and picks stage labels.
  const [reproc, setReproc] = useState<{ kind: 'note' | 'transcript' | 'all' } | null>(null);
  const busy = recStatus?.state === 'processing' || recStatus?.state === 'uploading';
  // NotesView reloads the regenerated note + clears staleness centrally; here
  // we just drop the local flag once the pipeline reaches a terminal state.
  useEffect(() => {
    if (recStatus?.state === 'done' || recStatus?.state === 'failed') setReproc(null);
  }, [recStatus?.state]);
  // Safety net: never let the spinner hang if the recorder goes quiet
  // (crash, app restart mid-run).
  useEffect(() => {
    if (!reproc) return undefined;
    const id = window.setTimeout(() => setReproc(null), 20 * 60_000);
    return () => window.clearTimeout(id);
  }, [reproc]);

  const reprocBlocked = !base.audioFile;
  const kickReprocess = async (
    kind: 'note' | 'transcript' | 'all', contextOverride?: string,
  ): Promise<void> => {
    if (!base.audioFile) {
      window.alert('No local audio on this Mac — open this meeting on the Mac that recorded it to reprocess.');
      return;
    }
    setReproc({ kind });
    // The user's extra context (overlay) is fed to the summary prompt on
    // every reprocess path. Pass an explicit override to dodge the
    // setState race when "Reprocess with this context" saves + runs in one
    // click.
    const extraContext = (contextOverride ?? note.reprocessContext).trim() || undefined;
    const payload = {
      eventId: base.id, audioFile: base.audioFile, title: note.title,
      accountId: base.accountId ?? undefined, extraContext,
    };
    const res = kind === 'note'
      ? await window.ycal.recorderResummarize(payload)
      : await window.ycal.recorderReprocess(payload);
    if (!res.ok) { setReproc(null); window.alert('Reprocess failed: ' + res.error); }
  };
  const doApplyDictionary = (): void => applyFixes(dictResolvableFixes());

  // ── highlight selection toolbar ──
  const [hlBar, setHlBar] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const onUp = (e: MouseEvent): void => {
      const tgt = e.target as HTMLElement | null;
      if (tgt?.closest && tgt.closest('.nt-hl-bar')) return;
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) { setHlBar(null); return; }
      const range = sel.getRangeAt(0);
      const node = range.commonAncestorContainer;
      const seg = (node.nodeType === 1 ? node : node.parentElement) as HTMLElement | null;
      if (!seg || !seg.closest('[data-seg-id]')) { setHlBar(null); return; }
      const r = range.getBoundingClientRect();
      setHlBar({ x: r.left + r.width / 2, y: r.top - 8 });
    };
    document.addEventListener('mouseup', onUp);
    return () => document.removeEventListener('mouseup', onUp);
  }, []);
  const segElFromSelection = (): HTMLElement | null => {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    const node = sel.getRangeAt(0).commonAncestorContainer;
    return ((node.nodeType === 1 ? node : node.parentElement) as HTMLElement | null)
      ?.closest('[data-seg-id]') as HTMLElement | null;
  };
  const applyHighlight = (): void => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    const segEl = segElFromSelection(); if (!segEl) return;
    try {
      const frag = range.extractContents();
      const mark = document.createElement('mark'); mark.className = 'nt-hl';
      mark.appendChild(frag); range.insertNode(mark); segEl.normalize();
    } catch { /* selection spanned multiple segments — ignore */ }
    sel.removeAllRanges(); setHlBar(null);
    setSegHtml(segEl.getAttribute('data-seg-id') || '', segEl.innerHTML);
  };
  const clearHighlight = (): void => {
    const sel = window.getSelection(); if (!sel || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    const segEl = segElFromSelection(); if (!segEl) return;
    segEl.querySelectorAll('mark.nt-hl').forEach((m) => {
      if (range.intersectsNode(m)) {
        const p = m.parentNode; if (!p) return;
        while (m.firstChild) p.insertBefore(m.firstChild, m);
        p.removeChild(m);
      }
    });
    segEl.normalize(); sel.removeAllRanges(); setHlBar(null);
    setSegHtml(segEl.getAttribute('data-seg-id') || '', segEl.innerHTML);
  };

  // ── transcript → dictionary correction (select text → fix) ──
  const [fixPop, setFixPop] = useState<{ token: string; x: number; y: number } | null>(null);
  const openFixFromSelection = (): void => {
    const sel = window.getSelection();
    const token = sel ? sel.toString().trim() : '';
    if (!token || !hlBar) { setHlBar(null); return; }
    setFixPop({ token, x: hlBar.x, y: hlBar.y });
    setHlBar(null);
  };
  // Apply a manual correction to this note immediately (prose + transcript
  // text nodes), independent of the flagged-term list.
  const applyManualFix = (token: string, correct: string): void => {
    const list: Fix[] = [{ heard: token, correct }];
    const segPatch = ntReplaceTextInSegments(note.segments, token, correct);
    P((c) => ({
      ...c,
      ...(note.summary.length ? { summary: note.summary.map((s) => ntReplaceAll(s, list)) } : {}),
      ...(note.decisions.length ? { decisions: note.decisions.map((s) => ntReplaceAll(s, list)) } : {}),
      ...(note.actions.length ? { actions: note.actions.map((a) => ({ ...a, text: ntReplaceAll(a.text, list) })) } : {}),
      segHtml: { ...(c.segHtml || {}), ...segPatch },
      transcriptTouchedAt: Date.now(),
    }));
  };
  // Save a correction to the glossary (global or per-event), then fix it in
  // this note. Mirrors the popover's TranscriptSheet correction flow.
  const saveCorrection = async (token: string, correct: string, scopeGlobal: boolean): Promise<void> => {
    const replacement = correct.trim();
    if (!replacement) { setFixPop(null); return; }
    if (scopeGlobal) {
      const existing = glossary.file.entries.find(
        (e) => e.canonical.toLowerCase() === replacement.toLowerCase());
      if (existing) {
        if (!existing.aliases.some((a) => a.toLowerCase() === token.toLowerCase())) {
          await glossary.updateEntry(existing.id, { aliases: [...existing.aliases, token] });
        }
      } else {
        await glossary.addEntry({
          canonical: replacement, aliases: [token],
          category: guessCategory(replacement), source: 'inline',
        });
      }
    } else {
      const cur = await glossary.getEventGlossary(base.id);
      const existing = cur.entries.find((e) => e.canonical.toLowerCase() === replacement.toLowerCase());
      const entries = existing
        ? cur.entries.map((e) => (e.id !== existing.id || e.aliases.some((a) => a.toLowerCase() === token.toLowerCase())
            ? e : { ...e, aliases: [...e.aliases, token] }))
        : [...cur.entries, {
            id: newGlossaryId(), canonical: replacement, aliases: [token],
            category: guessCategory(replacement), addedAt: Date.now(), source: 'inline' as const,
          }];
      await glossary.setEventGlossary(base.id, base.accountId, entries);
    }
    applyManualFix(token, replacement);
    setFixPop(null);
  };

  // ── speaker relabel popover ──
  const [spkPop, setSpkPop] = useState<{ segId: string; spId: string; x: number; y: number } | null>(null);

  // ── section scroll-spy ──
  useEffect(() => {
    const el = scrollRef.current; if (!el) return undefined;
    const onScroll = (): void => {
      const top = el.getBoundingClientRect().top + 70;
      let active = 'summary';
      ['summary', 'decisions', 'actions', 'transcript'].forEach((k) => {
        const s = secRefs.current[k];
        if (s && s.getBoundingClientRect().top <= top) active = k;
      });
      setActiveSec(active);
    };
    el.addEventListener('scroll', onScroll);
    return () => el.removeEventListener('scroll', onScroll);
  }, [base.id, transcriptOpen]);

  const jump = (k: string): void => {
    if (k === 'transcript' && !transcriptOpen) setTranscriptOpen(true);
    setTimeout(() => {
      const el = scrollRef.current; const s = secRefs.current[k];
      if (!el || !s) return;
      el.scrollTop += s.getBoundingClientRect().top - el.getBoundingClientRect().top - 56;
    }, k === 'transcript' && !transcriptOpen ? 30 : 0);
  };

  const col = spkColor(base.hue);
  const st = NT_STATUS[note.status];
  const dt = new Date(note.date + 'T00:00:00');
  const dateLabel = Number.isNaN(dt.getTime())
    ? note.date
    : DOW_LONG[dt.getDay()] + ', ' + MONTH_NAMES[dt.getMonth()] + ' ' + ordinal(dt.getDate()) + ', ' + dt.getFullYear();
  const timeLabel = note.startedAt ? formatTime(new Date(note.startedAt)) : 'Recorded';
  const showSaved = !!savedTick && (Date.now() - savedTick < 1600);
  const speakerById: Record<string, NoteSpeaker> = Object.fromEntries(note.speakers.map((s) => [s.id, s]));
  const counts = {
    summary: note.summary.length, decisions: note.decisions.length,
    actions: note.actions.length, transcript: note.segments.length,
  };

  // Locate the recording on disk (Finder). For a Drive-only note we fetch
  // it into the local cache first, then reveal that copy.
  const revealAudio = (): void => {
    if (base.audioFile) void window.ycal.recorderRevealFile(base.audioFile);
    else if (base.accountId) {
      void window.ycal.meetingArchiveFetch({ eventId: base.id, accountId: base.accountId, kind: 'audio' })
        .then((r) => { if (r.ok) void window.ycal.recorderRevealFile(r.path); });
    }
  };

  return (
    <div className="nt-doc" ref={scrollRef} style={{ ['--cal' as never]: col }}>
      <div className="nt-doc-inner">
        {/* masthead */}
        <div className="nt-mast-eyebrow">
          <span className="sw" />{base.hasAudio ? 'Recorded minutes' : 'Drive minutes'}
        </div>
        <Editable tag="h1" className="nt-title" singleLine text={note.title}
          placeholder="Untitled meeting"
          onCommit={(v) => { const t = v.trim(); if (t && t !== note.title) setField('title', t); }} />
        <div className="nt-mast-meta">
          <span>{dateLabel}</span><span className="dot">·</span>
          <span className="mono">{timeLabel}</span><span className="dot">·</span>
          <span className="mono">{ntTime(base.durationSec)}</span>
          {note.speakers.length > 0 && <>
            <span className="dot">·</span>
            <span className="nt-mast-attendees">
              {note.speakers.map((s) => (
                <span key={s.id} className="av" style={{ background: spkColor(s.hue) }} title={s.name}>{s.initials}</span>
              ))}
              <span style={{ marginLeft: 4, fontStyle: 'italic', color: 'var(--ink-mute)' }}>
                {note.speakers.length} speaker{note.speakers.length === 1 ? '' : 's'}
              </span>
            </span>
          </>}
        </div>

        {/* status bar */}
        <div className="nt-statusbar">
          <span className="nt-status-badge" style={{ ['--st' as never]: st.dot }}>
            <span className="d" />{st.label}
          </span>
          {note.status === 'corrected' && note.correctedBy
            ? <span className="nt-status-sub">Reviewed by {note.correctedBy}</span>
            : <span className="nt-status-sub">{pendTerms.length > 0
              ? pendTerms.length + ' term' + (pendTerms.length === 1 ? '' : 's') + ' to confirm'
              : 'Auto-transcribed'}</span>}
          <span className={'nt-saved' + (showSaved ? ' show' : '')}><span className="pulse" />Saved</span>
          <div className="nt-status-actions">
            {note.status !== 'corrected'
              ? <button className="nt-btn primary" onClick={() => setField('status', 'corrected')}>Mark corrected</button>
              : <button className="nt-btn is-done" onClick={() => setField('status', 'review')}>✓ Corrected — reopen</button>}
          </div>
        </div>

        {/* pipeline strip */}
        <PipelineStrip
          note={note} base={base} pendTerms={pendTerms} stale={stale}
          reprocBtnRef={reprocBtnRef}
          onReproc={() => setReprocOpen((o) => !o)}
          openDict={() => { setDictPrefill(null); setDictOpen(true); }}
        />

        {/* context the model couldn't get from the audio → reprocess */}
        <ContextBlock
          value={note.reprocessContext}
          blocked={reprocBlocked}
          busy={!!(busy || reproc)}
          onSave={(v) => setField('reprocessContext', v)}
          onReprocess={(ctx) => void kickReprocess('note', ctx)}
        />

        {/* scrubber + the actual audio element (hidden; styled by Scrubber) */}
        <audio
          ref={audioRef}
          src={audioUrl ?? undefined}
          preload="metadata"
          style={{ display: 'none' }}
          onTimeUpdate={() => setCur(audioRef.current?.currentTime ?? 0)}
          onLoadedMetadata={() => { const d = audioRef.current?.duration; if (d && Number.isFinite(d)) setDur(d); }}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
        />
        <Scrubber peaks={base.peaks} cur={cur} dur={dur || base.durationSec}
          playing={playing} ready={!!audioUrl} onToggle={togglePlay} onSeek={seekTo}
          canOpenAudio={base.hasAudio || !!base.accountId} onOpenAudio={revealAudio} />

        {/* jump nav */}
        <div className="nt-nav">
          {([['summary', 'Summary'], ['decisions', 'Decisions'], ['actions', 'Actions'], ['transcript', 'Transcript']] as const).map(
            ([k, lbl]) => (
              <button key={k} className={activeSec === k ? 'active' : ''} onClick={() => jump(k)}>
                {lbl}<span className="n">{counts[k]}</span>
              </button>
            ))}
        </div>

        {/* flagged terms — surfaced at summary level */}
        {pendTerms.length > 0 && (
          <FlaggedTerms terms={pendTerms} suggestionFor={suggestionFor}
            onFixOne={fixOneTerm}
            onFixAll={() => applyFixes(dictResolvableFixes())}
            canFixAll={dictResolvableFixes().length}
            onOpenDict={() => { setDictPrefill(null); setDictOpen(true); }} />
        )}
        {/* stale strip */}
        {pendTerms.length === 0 && stale && (
          <div className="nt-stale">
            <span className="ic">↻</span>
            <div className="tx"><strong>Summary may be out of date.</strong> The transcript changed after this note was generated.</div>
            <button className="nt-btn primary" disabled={reprocBlocked} onClick={() => void kickReprocess('note')}>
              Reprocess meeting note
            </button>
          </div>
        )}

        {/* SUMMARY */}
        <section className="nt-section" ref={(el) => { secRefs.current.summary = el; }}>
          <div className="nt-section-h">
            <span>Summary</span>
            <button className="add" onClick={() => addListItem('summary', 'New point…')}>+ point</button>
          </div>
          <ul className="nt-bullets">
            {note.summary.map((s, i) => (
              <li key={i} className="nt-bullet">
                <span className="mk">—</span>
                <Editable className="tx" html={mdInline(s)} placeholder="Summary point…"
                  onCommit={(v) => { const t = htmlToInline(v); t ? setListItem('summary', i, t) : removeListItem('summary', i); }} />
                <button className="del" title="Remove" onClick={() => removeListItem('summary', i)}>×</button>
              </li>
            ))}
            {note.summary.length === 0 && (
              <li className="nt-bullet"><span className="mk" /><span className="tx" style={{ fontStyle: 'italic', color: 'var(--ink-faint)' }}>No summary yet.</span><span /></li>
            )}
          </ul>
        </section>

        {/* DECISIONS */}
        <section className="nt-section nt-decisions" ref={(el) => { secRefs.current.decisions = el; }}>
          <div className="nt-section-h">
            <span>Decisions</span>
            <button className="add" onClick={() => addListItem('decisions', 'New decision…')}>+ decision</button>
          </div>
          <ul className="nt-bullets">
            {note.decisions.map((s, i) => (
              <li key={i} className="nt-bullet">
                <span className="mk">{String(i + 1).padStart(2, '0')}</span>
                <Editable className="tx" html={mdInline(s)} placeholder="Decision…"
                  onCommit={(v) => { const t = htmlToInline(v); t ? setListItem('decisions', i, t) : removeListItem('decisions', i); }} />
                <button className="del" title="Remove" onClick={() => removeListItem('decisions', i)}>×</button>
              </li>
            ))}
            {note.decisions.length === 0 && (
              <li className="nt-bullet"><span className="mk" /><span className="tx" style={{ fontStyle: 'italic', color: 'var(--ink-faint)' }}>No decisions recorded.</span><span /></li>
            )}
          </ul>
        </section>

        {/* ACTIONS */}
        <section className="nt-section" ref={(el) => { secRefs.current.actions = el; }}>
          <div className="nt-section-h">
            <span>Action items</span>
            <button className="add" onClick={() => setActions([...note.actions, { id: 'a' + Date.now(), text: 'New action…', owner: '', done: false }])}>+ action</button>
          </div>
          <ul className="nt-actions">
            {note.actions.map((a) => (
              <li key={a.id} className={'nt-action' + (a.done ? ' done' : '')}>
                <button className={'nt-checkbox' + (a.done ? ' on' : '')} aria-label="Toggle done"
                  onClick={() => setActions(note.actions.map((x) => x.id === a.id ? { ...x, done: !x.done } : x))} />
                <Editable className="tx" html={mdInline(a.text)} placeholder="Action…"
                  onCommit={(v) => { const t = htmlToInline(v); setActions(t ? note.actions.map((x) => x.id === a.id ? { ...x, text: t } : x) : note.actions.filter((x) => x.id !== a.id)); }} />
                <button className="nt-owner" title="Reassign"
                  onClick={() => {
                    const opts = ['', ...note.speakers.map((s) => s.name.split(' ')[0])];
                    const idx = opts.indexOf(a.owner || '');
                    setActions(note.actions.map((x) => x.id === a.id ? { ...x, owner: opts[(idx + 1) % opts.length] } : x));
                  }}>{a.owner || 'unassigned'}</button>
                <button className="del" title="Remove" onClick={() => setActions(note.actions.filter((x) => x.id !== a.id))}>×</button>
              </li>
            ))}
            {note.actions.length === 0 && (
              <li className="nt-action"><span /><span className="tx" style={{ fontStyle: 'italic', color: 'var(--ink-faint)' }}>No action items.</span><span /><span /></li>
            )}
          </ul>
        </section>

        {/* TRANSCRIPT — collapsed by default */}
        <section className="nt-section" ref={(el) => { secRefs.current.transcript = el; }}>
          <button className="nt-trans-disclosure" onClick={() => setTranscriptOpen(!transcriptOpen)} aria-expanded={transcriptOpen}>
            <span className={'chev' + (transcriptOpen ? ' open' : '')}>▸</span>
            <span className="lbl">Transcript</span>
            <span className="meta">{note.segments.length} lines{flags > 0 ? ' · ' + flags + ' to check' : ''}</span>
            <span className="hint">{transcriptOpen ? 'Hide' : 'Open the transcript only if a noun needs checking'}</span>
          </button>

          {transcriptOpen && <>
            <div className="nt-trans-toolbar">
              <span className="lc-key"><span className="lc-swatch" /> low-confidence — click the word to fix</span>
              <button className="resolve" disabled={flags === 0} onClick={resolveAllFlags}>
                Clear {flags} flag{flags === 1 ? '' : 's'}
              </button>
            </div>
            {note.segments.map((g) => {
              const sp = speakerById[g.speakerId] || { name: 'Unknown', hue: 0 } as NoteSpeaker;
              return (
                <div key={g.id} className={'nt-seg' + (g.id === activeSegId ? ' active' : '')}>
                  <div className="nt-seg-side">
                    <button className="nt-speaker" style={{ ['--sp' as never]: spkColor(sp.hue) }}
                      onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setSpkPop({ segId: g.id, spId: g.speakerId, x: r.left, y: r.bottom + 4 }); }}>
                      <span className="sp-dot" />{sp.name}<span className="caret">▾</span>
                    </button>
                    <button className="nt-seg-time" title="Jump to this moment" onClick={() => seekTo(g.t)}>{ntTime(g.t)}</button>
                  </div>
                  <Editable className="nt-seg-text" html={g.html} placeholder="…"
                    dataSegId={g.id}
                    onCommit={(v) => { if (v !== g.html) setSegHtml(g.id, v); }} />
                </div>
              );
            })}
          </>}
        </section>
      </div>

      {/* reprocess menu */}
      {reprocOpen && (
        <ReprocessMenu
          anchorRef={reprocBtnRef} onClose={() => setReprocOpen(false)}
          pendTerms={pendTerms} stale={stale} blocked={reprocBlocked}
          onNote={() => { setReprocOpen(false); void kickReprocess('note'); }}
          onDict={() => { setReprocOpen(false); doApplyDictionary(); }}
          onTranscript={() => { setReprocOpen(false); void kickReprocess('transcript'); }}
          onAll={() => { setReprocOpen(false); void kickReprocess('all'); }}
        />
      )}

      {/* processing overlay — shows for any in-flight reprocess on this note,
          including ones started from the event popover */}
      {(busy || reproc) && (
        <ProcessingOverlay
          state={recStatus?.state ?? 'processing'}
          title={note.title}
          kind={reproc?.kind ?? 'all'}
        />
      )}

      {/* dictionary panel (the real glossary) */}
      {dictOpen && (
        <DictionaryPanel
          glossary={glossary}
          prefill={dictPrefill} onClose={() => { setDictOpen(false); setDictPrefill(null); }}
          onAddAndFix={(canonical, heard, type) => {
            void glossary.addEntry({ canonical, aliases: [heard], category: TYPE_TO_CAT[type] ?? 'other', source: 'inline' });
            const term = pendTerms.find((t) => t.heard === heard);
            applyFixes([{ heard, correct: canonical, termId: term?.id }]);
          }}
          onApplyToNote={() => applyFixes(dictResolvableFixes())}
        />
      )}

      {spkPop && (
        <SpeakerPopover note={note} pop={spkPop} onClose={() => setSpkPop(null)}
          onReassign={(spId) => { setSegSpeaker(spkPop.segId, spId); setSpkPop(null); }}
          onRename={(spId, name) => { renameSpeaker(spId, name); }} />
      )}

      {hlBar && (
        <div className="nt-hl-bar" style={{ left: hlBar.x, top: hlBar.y }} onMouseDown={(e) => e.preventDefault()}>
          <button onClick={applyHighlight}><span className="swatch" />Highlight</button>
          <button onClick={openFixFromSelection}>Fix…</button>
          <button onClick={clearHighlight}>Clear</button>
        </div>
      )}

      {fixPop && (
        <FixPopover token={fixPop.token} x={fixPop.x} y={fixPop.y}
          onClose={() => setFixPop(null)}
          onSave={(correct, scopeGlobal) => void saveCorrection(fixPop.token, correct, scopeGlobal)} />
      )}
    </div>
  );
}

// ── transcript correction popover (select → fix into dictionary) ────────────
function FixPopover({
  token, x, y, onClose, onSave,
}: {
  token: string; x: number; y: number;
  onClose: () => void; onSave: (correct: string, scopeGlobal: boolean) => void;
}) {
  const [draft, setDraft] = useState('');
  const [scopeGlobal, setScopeGlobal] = useState(true);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent): void => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDown); document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [onClose]);
  const left = Math.min(x, window.innerWidth - 296);
  const top = Math.min(y + 10, window.innerHeight - 210);
  return (
    <div className="nt-fix-pop" ref={ref} style={{ left, top }} onMouseDown={(e) => e.stopPropagation()}>
      <div className="nt-fix-h">Correct “<strong>{token}</strong>” to…</div>
      <input
        className="nt-fix-input" autoFocus value={draft}
        onChange={(e) => setDraft(e.target.value)} placeholder="Correct spelling"
        onKeyDown={(e) => { if (e.key === 'Enter' && draft.trim()) onSave(draft.trim(), scopeGlobal); }}
      />
      <div className="nt-fix-scope">
        <label><input type="radio" checked={scopeGlobal} onChange={() => setScopeGlobal(true)} /> Global dictionary</label>
        <label><input type="radio" checked={!scopeGlobal} onChange={() => setScopeGlobal(false)} /> This meeting only</label>
      </div>
      <div className="nt-fix-actions">
        <button className="nt-btn sm" onClick={onClose}>Cancel</button>
        <button className="nt-btn primary sm" disabled={!draft.trim()} onClick={() => onSave(draft.trim(), scopeGlobal)}>Save &amp; fix</button>
      </div>
    </div>
  );
}

// ── AI context for reprocessing ─────────────────────────────────────────────
// A place to give the model the context it couldn't get from the audio —
// who was in the room, what acronyms mean, what to focus on — then
// regenerate the note. Persisted in the note overlay (so it survives and is
// reused by every later reprocess) and fed into the summary prompt.
function ContextBlock({
  value, blocked, busy, onSave, onReprocess,
}: {
  value: string; blocked: boolean; busy: boolean;
  onSave: (v: string) => void; onReprocess: (ctx: string) => void;
}) {
  const [open, setOpen] = useState(!!value.trim());
  const [draft, setDraft] = useState(value);
  useEffect(() => { setDraft(value); }, [value]);
  const dirty = draft.trim() !== value.trim();
  return (
    <div className="nt-context">
      <button className="nt-context-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className={'chev' + (open ? ' open' : '')}>▸</span>
        <span className="lbl">Context for the AI</span>
        <span className="hint">{value.trim()
          ? 'Saved — included every time you reprocess'
          : 'Add who was there, acronyms, what to focus on — then reprocess the note'}</span>
      </button>
      {open && (
        <div className="nt-context-body">
          <textarea
            className="nt-context-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => { if (dirty) onSave(draft); }}
            rows={4}
            placeholder={'e.g. This was the TW all-hands. “Rhapsody” = our AI dev pipeline; “Builders” = the four-tier program. Focus the summary on EPD decisions and any action items for my team.'}
          />
          <div className="nt-context-actions">
            <span className="nt-context-note">Regenerates the summary, decisions &amp; actions from the transcript with this context. Your manual edits are preserved.</span>
            <button
              className="nt-btn primary"
              disabled={blocked || busy}
              title={blocked ? 'No local audio on this Mac.' : ''}
              onClick={() => { onSave(draft); onReprocess(draft); }}
            >{busy ? 'Reprocessing…' : 'Reprocess note with context'}</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── pipeline strip ─────────────────────────────────────────────────────────
function PipelineStrip({
  note, base, pendTerms, stale, reprocBtnRef, onReproc, openDict,
}: {
  note: EffNote; base: MeetingNote; pendTerms: NoteTerm[]; stale: boolean;
  reprocBtnRef: React.RefObject<HTMLButtonElement>;
  onReproc: () => void; openDict: () => void;
}) {
  const dictState = pendTerms.length > 0 ? 'warn' : 'done';
  const noteState = stale ? 'warn' : 'done';
  return (
    <div className="nt-pipe">
      <div className="nt-pipe-stage done">
        <span className="ic">✓</span>
        <div className="bd"><div className="k">Transcript</div><div className="v">{fmtStamp(note.transcribedAt)} · whisper</div></div>
      </div>
      <span className="nt-pipe-arrow">→</span>
      <button className={'nt-pipe-stage btn ' + dictState} onClick={openDict} title="Open terminology dictionary">
        <span className="ic">{dictState === 'warn' ? '!' : '✓'}</span>
        <div className="bd"><div className="k">Dictionary</div>
          <div className="v">{pendTerms.length > 0 ? pendTerms.length + ' term' + (pendTerms.length === 1 ? '' : 's') + ' unresolved' : 'all terms applied'}</div></div>
      </button>
      <span className="nt-pipe-arrow">→</span>
      <div className={'nt-pipe-stage ' + noteState}>
        <span className="ic">{noteState === 'warn' ? '↻' : '✓'}</span>
        <div className="bd"><div className="k">Meeting note</div>
          <div className="v">{stale ? 'out of date' : fmtStamp(note.noteAt) + ' · ' + (base.modelVer || 'note')}</div></div>
      </div>
      <button className="nt-reproc" ref={reprocBtnRef} onClick={onReproc}>Reprocess <span className="cv">▾</span></button>
    </div>
  );
}

// ── reprocess menu ─────────────────────────────────────────────────────────
function ReprocessMenu({
  anchorRef, onClose, pendTerms, stale, blocked, onNote, onDict, onTranscript, onAll,
}: {
  anchorRef: React.RefObject<HTMLButtonElement>; onClose: () => void;
  pendTerms: NoteTerm[]; stale: boolean; blocked: boolean;
  onNote: () => void; onDict: () => void; onTranscript: () => void; onAll: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  useEffect(() => {
    if (anchorRef.current) {
      const r = anchorRef.current.getBoundingClientRect();
      setPos({ top: r.bottom + 5, left: Math.min(r.left, window.innerWidth - 332) });
    }
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node;
      if (ref.current && !ref.current.contains(t) && !(anchorRef.current && anchorRef.current.contains(t))) onClose();
    };
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDown); document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [anchorRef, onClose]);
  const Item = ({ onClick, k, sub, rec, adv, disabled }: {
    onClick: () => void; k: string; sub: string; rec?: boolean; adv?: boolean; disabled?: boolean;
  }) => (
    <button className={'nt-reproc-item' + (adv ? ' adv' : '')} onClick={onClick} disabled={disabled}>
      <div className="t">{k}{rec && <span className="rec">recommended</span>}</div>
      <div className="s">{sub}</div>
    </button>
  );
  return (
    <div className="nt-reproc-menu" ref={ref} style={{ top: pos.top, left: pos.left }}>
      <div className="nt-reproc-h">Reprocess</div>
      <Item k="Reprocess meeting note" rec={stale || pendTerms.length === 0} disabled={blocked}
        sub={blocked ? 'No local audio on this Mac.' : 'Regenerate the summary, decisions & actions from the current transcript.'} onClick={onNote} />
      <Item k="Apply dictionary & fix transcript" rec={pendTerms.length > 0}
        sub="Rewrite known mis-heard terms in this note. Fast, local, no re-run." onClick={onDict} />
      <Item k="Reprocess transcript" adv disabled={blocked}
        sub={blocked ? 'No local audio on this Mac.' : 'Re-run speech-to-text on the audio. Discards manual transcript edits.'} onClick={onTranscript} />
      <div className="nt-reproc-div" />
      <Item k="Reprocess everything" adv disabled={blocked}
        sub={blocked ? 'No local audio on this Mac.' : 'Re-transcribe → apply dictionary → regenerate the note, end to end.'} onClick={onAll} />
    </div>
  );
}

// ── flagged terms (summary level) ───────────────────────────────────────────
function FlaggedTerms({
  terms, suggestionFor, onFixOne, onFixAll, canFixAll, onOpenDict,
}: {
  terms: NoteTerm[]; suggestionFor: (t: NoteTerm) => string | null;
  onFixOne: (t: NoteTerm) => void; onFixAll: () => void; canFixAll: number; onOpenDict: () => void;
}) {
  return (
    <div className="nt-flagged">
      <div className="nt-flagged-h">
        <span className="ttl">Terms to confirm <span className="n">{terms.length}</span></span>
        <span className="sub">These nouns were uncertain in the audio. Fix them here — no need to read the transcript.</span>
        <div className="acts">
          {canFixAll > 0 && <button className="nt-btn primary sm" onClick={onFixAll}>Fix {canFixAll} with dictionary</button>}
          <button className="nt-btn sm" onClick={onOpenDict}>Dictionary</button>
        </div>
      </div>
      <div className="nt-chips">
        {terms.map((t) => {
          const sug = suggestionFor(t);
          return (
            <div key={t.id} className={'nt-chip' + (sug ? ' has' : ' manual')}>
              <span className="type">{t.type}</span>
              <span className="heard">“{t.heard}”</span>
              {sug
                ? <><span className="arr">→</span><span className="sug">{sug}</span>
                  <button className="fix" onClick={() => onFixOne(t)}>Fix</button></>
                : <button className="fix manual" onClick={() => onFixOne(t)}>Add to dictionary…</button>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── processing overlay (driven by recorder state) ──────────────────────────
function ProcessingOverlay({
  state, title, kind,
}: { state: RecordingStatus['state']; title: string; kind: 'note' | 'transcript' | 'all' }) {
  const stages = kind === 'note'
    ? [{ key: 'note', label: 'Regenerating meeting note from transcript' }]
    : [
        { key: 'audio', label: 'Re-transcribing audio (whisper)' },
        { key: 'note', label: 'Regenerating meeting note' },
      ];
  // Map recorder state → which stage is active / done.
  const phase = state === 'processing' ? 0 : state === 'uploading' || state === 'done' ? stages.length : 0;
  const done = state === 'done';
  return (
    <div className="nt-proc">
      <div className="nt-proc-card">
        <div className="nt-proc-ttl">{done ? 'Done' : 'Reprocessing'}</div>
        <div className="nt-proc-sub">{title}</div>
        <ul className="nt-proc-stages">
          {stages.map((s, i) => {
            const stState = done || i < phase ? 'done' : i === phase ? 'active' : 'pending';
            return (
              <li key={s.key} className={'st ' + stState}>
                <span className="dot">{stState === 'done' ? '✓' : ''}</span>
                <span className="lb">{s.label}</span>
              </li>
            );
          })}
        </ul>
        <div className="nt-proc-foot">Runs in the background — you can keep working; the note updates when it finishes.</div>
      </div>
    </div>
  );
}

// ── dictionary panel (backed by the real glossary) ──────────────────────────
function DictionaryPanel({
  glossary, prefill, onClose, onAddAndFix, onApplyToNote,
}: {
  glossary: GlossaryStore;
  prefill: { heard: string } | null; onClose: () => void;
  onAddAndFix: (canonical: string, heard: string, type: string) => void;
  onApplyToNote: () => void;
}) {
  const [canonical, setCanonical] = useState('');
  const [variant, setVariant] = useState(prefill ? prefill.heard : '');
  const [type, setType] = useState('name');
  const [q, setQ] = useState('');
  const canonRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    if (prefill && canonRef.current) canonRef.current.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [prefill, onClose]);
  const submit = (e: React.FormEvent): void => {
    e.preventDefault();
    if (!canonical.trim()) return;
    if (prefill && variant.trim()) onAddAndFix(canonical.trim(), variant.trim(), type);
    else void glossary.addEntry({ canonical: canonical.trim(), aliases: variant.trim() ? [variant.trim()] : [], category: TYPE_TO_CAT[type] ?? 'other', source: 'manual' });
    setCanonical(''); setVariant('');
  };
  const list = glossary.file.entries.filter((d) =>
    !q || d.canonical.toLowerCase().includes(q.toLowerCase())
    || d.aliases.some((v) => v.toLowerCase().includes(q.toLowerCase())));
  return (
    <>
      <div className="nt-dict-scrim" onClick={onClose} />
      <aside className="nt-dict" data-screen-label="Terminology dictionary">
        <header className="nt-dict-head">
          <div className="eyebrow">Terminology dictionary</div>
          <button className="x" onClick={onClose}>×</button>
        </header>
        <p className="nt-dict-intro">Shared across every meeting (the recording glossary). Corrections you add here are applied whenever a transcript is fixed or reprocessed.</p>

        <form className="nt-dict-add" onSubmit={submit}>
          <div className="nt-dict-add-h">{prefill ? 'Correct a mis-heard term' : 'Add a term'}</div>
          {prefill && <div className="nt-dict-prefill">Heard in this note: <strong>“{prefill.heard}”</strong></div>}
          <div className="row">
            <input ref={canonRef} value={canonical} onChange={(e) => setCanonical(e.target.value)} placeholder="Correct spelling (e.g. SAML)" />
          </div>
          <div className="row">
            <input value={variant} onChange={(e) => setVariant(e.target.value)} placeholder="Heard as… (e.g. Sam-El)" />
            <select value={type} onChange={(e) => setType(e.target.value)}>
              <option value="name">name</option><option value="term">term</option>
              <option value="org">org</option><option value="region">region</option>
              <option value="project">project</option>
            </select>
          </div>
          <button type="submit" className="nt-btn primary sm">{prefill ? 'Save & fix in this note' : 'Add term'}</button>
        </form>

        <div className="nt-dict-search">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter dictionary…" />
          <button className="nt-btn sm" onClick={onApplyToNote} title="Apply every matching term to this note">Apply to this note</button>
        </div>

        <div className="nt-dict-list">
          {list.map((d) => (
            <div key={d.id} className="nt-dict-row">
              <div className="lead"><span className="can">{d.canonical}</span><span className="ty">{CAT_TO_TYPE[d.category] ?? d.category}</span></div>
              <div className="vars">{d.aliases.length ? d.aliases.map((v, i) => <span key={i} className="v">{v}</span>) : <span className="none">no variants yet</span>}</div>
              <button className="rm" title="Remove" onClick={() => void glossary.deleteEntry(d.id)}>×</button>
            </div>
          ))}
          {list.length === 0 && <div className="nt-list-empty">No terms yet.</div>}
        </div>
      </aside>
    </>
  );
}

// ── audio scrubber ─────────────────────────────────────────────────────────
function Scrubber({
  peaks, cur, dur, playing, ready, onToggle, onSeek, canOpenAudio, onOpenAudio,
}: {
  peaks: number[]; cur: number; dur: number; playing: boolean; ready: boolean;
  onToggle: () => void; onSeek: (sec: number) => void;
  canOpenAudio: boolean; onOpenAudio: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const frac = dur ? cur / dur : 0;
  const playedTo = Math.round(frac * peaks.length);
  const onClick = (e: React.MouseEvent): void => {
    const r = ref.current?.getBoundingClientRect(); if (!r) return;
    onSeek(((e.clientX - r.left) / r.width) * dur);
  };
  return (
    <div className="nt-scrub">
      <button className="nt-play" onClick={onToggle} disabled={!ready}
        title={ready ? '' : 'Loading audio…'} aria-label={playing ? 'Pause' : 'Play'}>
        {playing
          ? <svg width="13" height="13" viewBox="0 0 12 12" fill="currentColor"><rect x="2.5" y="2" width="2.5" height="8" /><rect x="7" y="2" width="2.5" height="8" /></svg>
          : <svg width="13" height="13" viewBox="0 0 12 12" fill="currentColor"><path d="M3 2l7 4-7 4z" /></svg>}
      </button>
      <div className="nt-wave" ref={ref} onClick={onClick}>
        {peaks.map((p, i) => <div key={i} className={'bar' + (i < playedTo ? ' played' : '')} style={{ height: (12 + p * 24) + 'px' }} />)}
        <div className="ph" style={{ left: (frac * 100) + '%' }} />
      </div>
      <div className="nt-scrub-time"><span className="cur">{ntTime(cur)}</span> / {ntTime(dur)}</div>
      {canOpenAudio && (
        <button className="nt-scrub-open" title="Show the recording in Finder" onClick={onOpenAudio}>⤢</button>
      )}
    </div>
  );
}

// ── speaker relabel popover ─────────────────────────────────────────────────
function SpeakerPopover({
  note, pop, onClose, onReassign, onRename,
}: {
  note: EffNote; pop: { segId: string; spId: string; x: number; y: number };
  onClose: () => void; onReassign: (spId: string) => void; onRename: (spId: string, name: string) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const cur = note.speakers.find((s) => s.id === pop.spId);
  const [name, setName] = useState(cur ? cur.name : '');
  useEffect(() => {
    const onDown = (e: MouseEvent): void => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDown); document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [onClose]);
  const left = Math.min(pop.x, window.innerWidth - 248);
  const top = Math.min(pop.y, window.innerHeight - 280);
  return (
    <div className="nt-spk-pop" ref={ref} style={{ left, top }}>
      <div className="nt-spk-pop-h">Assign this line to</div>
      {note.speakers.map((s) => (
        <button key={s.id} className={'nt-spk-opt' + (s.id === pop.spId ? ' cur' : '')} onClick={() => onReassign(s.id)}>
          <span className="sp-dot" style={{ background: spkColor(s.hue) }} />{s.name}
          {s.role && <span className="role">{s.role}</span>}
        </button>
      ))}
      <div className="nt-spk-note">Rename {cur ? cur.name : 'speaker'} everywhere:</div>
      <form className="nt-spk-rename" onSubmit={(e) => { e.preventDefault(); if (name.trim()) { onRename(pop.spId, name.trim()); onClose(); } }}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Speaker name" autoFocus />
        <button type="submit">Rename</button>
      </form>
    </div>
  );
}
