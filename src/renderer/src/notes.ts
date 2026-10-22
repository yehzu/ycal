// yCal — meeting notes store hook (Notes view).
//
// Owns the master list of meeting-note summaries, the per-note correction
// overlay (cloudStore-backed, cross-device), and a lazily-populated cache
// of full structured notes. The base note comes from main (built from the
// recording archive); corrections live in the overlay and are merged over
// the base in the view — exactly the design's "base fixtures + localStorage
// edits" split, but real and synced.

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  MeetingNote, MeetingNoteSummary, NoteOverlay, NotesOverlayFile,
} from '@shared/types';
import { diffNoteOverlay } from '@shared/notesOverlayMerge';

const EMPTY_OVERLAY: NotesOverlayFile = { version: 1, notes: {}, updatedAt: 0 };
// Auto-refresh throttle for focus / visibility / remote-overlay triggers —
// the full list waits on a Drive round-trip per account.
const AUTO_REFRESH_MIN_MS = 30_000;

// What a cached full note was built from; when a row's signature moves
// (another Mac reprocessed it, a Drive archive landed) the cache is stale.
const rowSig = (s: MeetingNoteSummary): string =>
  [s.updatedAt ?? 0, s.hasAudio, s.hasTranscript, s.hasSummary].join('|');

export interface NotesStore {
  loading: boolean;
  error: string | null;
  summaries: MeetingNoteSummary[];
  overlay: NotesOverlayFile;
  bases: Record<string, MeetingNote>;
  refreshList: () => Promise<void>;
  ensureNote: (eventId: string, accountId?: string | null) => Promise<void>;
  reloadNote: (eventId: string, accountId?: string | null) => Promise<void>;
  patchOverlay: (eventId: string, fn: (cur: NoteOverlay) => NoteOverlay) => void;
  deleteNote: (eventId: string, accountId?: string | null) => Promise<{ ok: boolean; error?: string }>;
}

export function useMeetingNotes(): NotesStore {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [summaries, setSummaries] = useState<MeetingNoteSummary[]>([]);
  const [overlay, setOverlay] = useState<NotesOverlayFile>(EMPTY_OVERLAY);
  const [bases, setBases] = useState<Record<string, MeetingNote>>({});
  // Guard against concurrent fetches of the same note (selection churn).
  const inflight = useRef<Set<string>>(new Set());
  // Latest overlay, read outside setState so patchOverlay can diff and send
  // its IPC exactly once (a setState updater may run twice).
  const overlayRef = useRef<NotesOverlayFile>(EMPTY_OVERLAY);
  // Row signatures the cached full notes were fetched against.
  const fetchedSig = useRef<Map<string, string>>(new Map());
  const lastRefreshAt = useRef(0);
  const basesRef = useRef<Record<string, MeetingNote>>({});
  basesRef.current = bases;

  const fetchNote = useCallback(async (eventId: string, accountId?: string | null) => {
    if (inflight.current.has(eventId)) return;
    inflight.current.add(eventId);
    try {
      const res = await window.ycal.noteGet({ eventId, accountId: accountId ?? null });
      if (res.ok) {
        setBases((prev) => ({ ...prev, [eventId]: res.note }));
        fetchedSig.current.set(eventId, rowSig(res.note));
        setError(null);
      } else {
        setError(res.error);
      }
    } finally {
      inflight.current.delete(eventId);
    }
  }, []);

  // Refetch any cached full note whose row moved since it was fetched, in
  // place (the old copy stays on screen until the new one lands).
  const refetchStale = useCallback((rows: MeetingNoteSummary[]) => {
    for (const row of rows) {
      if (!basesRef.current[row.id]) continue;
      const was = fetchedSig.current.get(row.id);
      if (was !== undefined && was !== rowSig(row)) void fetchNote(row.id, row.accountId);
    }
  }, [fetchNote]);

  const refreshList = useCallback(async () => {
    lastRefreshAt.current = Date.now();
    setLoading(true);
    try {
      // Phase 1 — local-only, instant paint. No Drive network in the way.
      const local = await window.ycal.notesListLocal();
      if (local.ok) {
        setSummaries(local.notes);
        setError(null);
        setLoading(false);    // page is usable now; Drive merges in below
      }
      // Phase 2 — full list incl. cross-Mac Drive archives. Replaces the
      // local set once the network round-trip returns (superset of phase 1).
      const full = await window.ycal.notesList();
      if (full.ok) {
        setSummaries(full.notes);
        refetchStale(full.notes);
        setError(null);
      } else if (!local.ok) {
        setError(full.error);
      }
    } finally {
      setLoading(false);
    }
  }, [refetchStale]);

  useEffect(() => {
    const apply = (next: NotesOverlayFile): void => {
      overlayRef.current = next;
      setOverlay(next);
    };
    // Throttled: another Mac's edit, or coming back to the window, are both
    // moments the list (rows recorded / reprocessed elsewhere) may be stale.
    const maybeRefresh = (): void => {
      if (Date.now() - lastRefreshAt.current < AUTO_REFRESH_MIN_MS) return;
      void refreshList();
    };
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') maybeRefresh();
    };
    void refreshList();
    void window.ycal.notesGetOverlay().then(apply);
    const off = window.ycal.onNotesOverlayChanged((next) => { apply(next); maybeRefresh(); });
    window.addEventListener('focus', maybeRefresh);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      off();
      window.removeEventListener('focus', maybeRefresh);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refreshList]);

  const ensureNote = useCallback(async (eventId: string, accountId?: string | null) => {
    if (bases[eventId]) return;
    await fetchNote(eventId, accountId);
  }, [bases, fetchNote]);

  const reloadNote = useCallback(async (eventId: string, accountId?: string | null) => {
    await fetchNote(eventId, accountId);
  }, [fetchNote]);

  // Apply locally right away, then send main ONLY the keys that changed —
  // main stamps their merge clocks. Sending the whole note would revert any
  // key another Mac edited that this window hasn't heard about yet.
  const patchOverlay = useCallback((eventId: string, fn: (cur: NoteOverlay) => NoteOverlay) => {
    const prev = overlayRef.current;
    const cur = prev.notes[eventId] ?? {};
    const nextForEvent = fn(cur);
    const ops = diffNoteOverlay(cur, nextForEvent);
    if (ops.length === 0) return;
    const next: NotesOverlayFile = {
      ...prev,
      notes: { ...prev.notes, [eventId]: nextForEvent },
      updatedAt: Date.now(),
    };
    overlayRef.current = next;
    setOverlay(next);
    void window.ycal.notesSetOverlay({ eventId, ops });
  }, []);

  const deleteNote = useCallback(async (eventId: string, accountId?: string | null) => {
    const res = await window.ycal.notesDelete({ eventId, accountId: accountId ?? null });
    if (!res.ok) return { ok: false as const, error: res.error };
    // Drop it locally right away so the list/selection update without a
    // round-trip, then reconcile against main (Drive may lag).
    setSummaries((prev) => prev.filter((s) => s.id !== eventId));
    setBases((prev) => {
      if (!(eventId in prev)) return prev;
      const next = { ...prev }; delete next[eventId]; return next;
    });
    const prev = overlayRef.current;
    if (eventId in prev.notes) {
      const notes = { ...prev.notes }; delete notes[eventId];
      overlayRef.current = { ...prev, notes, updatedAt: Date.now() };
      setOverlay(overlayRef.current);
    }
    void refreshList();
    return { ok: true as const };
  }, [refreshList]);

  return {
    loading, error, summaries, overlay, bases,
    refreshList, ensureNote, reloadNote, patchOverlay, deleteNote,
  };
}
