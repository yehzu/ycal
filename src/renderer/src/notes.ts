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

const EMPTY_OVERLAY: NotesOverlayFile = { version: 1, notes: {}, updatedAt: 0 };

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
}

export function useMeetingNotes(): NotesStore {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [summaries, setSummaries] = useState<MeetingNoteSummary[]>([]);
  const [overlay, setOverlay] = useState<NotesOverlayFile>(EMPTY_OVERLAY);
  const [bases, setBases] = useState<Record<string, MeetingNote>>({});
  // Guard against concurrent fetches of the same note (selection churn).
  const inflight = useRef<Set<string>>(new Set());

  const refreshList = useCallback(async () => {
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
        setError(null);
      } else if (!local.ok) {
        setError(full.error);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshList();
    void window.ycal.notesGetOverlay().then(setOverlay);
    const off = window.ycal.onNotesOverlayChanged((next) => setOverlay(next));
    return off;
  }, [refreshList]);

  const fetchNote = useCallback(async (eventId: string, accountId?: string | null) => {
    if (inflight.current.has(eventId)) return;
    inflight.current.add(eventId);
    try {
      const res = await window.ycal.noteGet({ eventId, accountId: accountId ?? null });
      if (res.ok) {
        setBases((prev) => ({ ...prev, [eventId]: res.note }));
        setError(null);
      } else {
        setError(res.error);
      }
    } finally {
      inflight.current.delete(eventId);
    }
  }, []);

  const ensureNote = useCallback(async (eventId: string, accountId?: string | null) => {
    if (bases[eventId]) return;
    await fetchNote(eventId, accountId);
  }, [bases, fetchNote]);

  const reloadNote = useCallback(async (eventId: string, accountId?: string | null) => {
    await fetchNote(eventId, accountId);
  }, [fetchNote]);

  const patchOverlay = useCallback((eventId: string, fn: (cur: NoteOverlay) => NoteOverlay) => {
    setOverlay((prev) => {
      const cur = prev.notes[eventId] ?? {};
      const nextForEvent = fn(cur);
      const next: NotesOverlayFile = {
        version: 1,
        notes: { ...prev.notes, [eventId]: nextForEvent },
        updatedAt: Date.now(),
      };
      // Persist (and let the cloud watcher echo back idempotently).
      void window.ycal.notesSetOverlay({ eventId, overlay: nextForEvent });
      return next;
    });
  }, []);

  return {
    loading, error, summaries, overlay, bases,
    refreshList, ensureNote, reloadNote, patchOverlay,
  };
}
