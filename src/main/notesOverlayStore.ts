// notesOverlayStore — the Notes correction overlay (meeting-notes.json),
// merged per key instead of overwritten. Same three parts as tasksStore
// (CLAUDE.md invariant #11), with the pure merge in
// @shared/notesOverlayMerge:
//   1. Every key (a field, or one entry of segHtml / speakerNames /
//      segSpeakers) carries a clock; deletes leave a clock with no value,
//      and deleting a note leaves a file-level tombstone.
//   2. The renderer sends ops (`applyOverlayOps`), so MAIN is the only
//      stamper — a renderer holding a stale copy can't revert a key it
//      never touched.
//   3. An in-memory `authoritative` copy survives a sync channel clobbering
//      the file with a staler blob: every read merges disk against it and
//      writes the recovered union back, so disk and peers converge.
//
// Kept apart from notesStore (which pulls in meetRecorder / meetingArchive)
// so driveSync can import it without a cycle.

import type { NoteOverlay, NoteOverlayOp, NotesOverlayFile } from '@shared/types';
import {
  applyNoteOverlayOps, diffNoteOverlay, mergeNotesOverlay, normalizeNotesOverlayFile,
  stableStringify, tombstoneNote,
} from '@shared/notesOverlayMerge';
import { readJsonStrict, writeJson } from './cloudStore';

export const NOTES_OVERLAY_FILE = 'meeting-notes.json';

let authoritative: NotesOverlayFile | null = null;
const remoteListeners = new Set<(file: NotesOverlayFile) => void>();

const empty = (): NotesOverlayFile => ({ version: 1, notes: {}, updatedAt: 0 });
// Content signature: notes + tombstones. The file-level updatedAt is
// bookkeeping and must not make two equal unions look different.
const sig = (f: NotesOverlayFile): string => stableStringify({ n: f.notes, t: f.tombstones ?? {} });

// Fold whatever is on disk (possibly replaced by iCloud) into the
// authoritative copy; restore the union to disk if the disk was behind.
function reconcileDisk(): NotesOverlayFile {
  const res = readJsonStrict<NotesOverlayFile>(NOTES_OVERLAY_FILE);
  if (res.status === 'corrupt') return authoritative ?? empty();
  const disk = res.data ? normalizeNotesOverlayFile(res.data) : empty();
  const merged = mergeNotesOverlay(authoritative ?? disk, disk, Date.now());
  authoritative = merged;
  if (res.data && sig(merged) !== sig(disk)) writeJson(NOTES_OVERLAY_FILE, merged);
  return merged;
}

export function getNotesOverlayFile(): NotesOverlayFile {
  return reconcileDisk();
}

function commit(next: NotesOverlayFile): NotesOverlayFile {
  authoritative = next;
  writeJson(NOTES_OVERLAY_FILE, next);
  return next;
}

/** The renderer's edits to one note, as ops. Main stamps the clocks. */
export function applyOverlayOps(eventId: string, ops: NoteOverlayOp[]): NotesOverlayFile {
  const base = reconcileDisk();
  if (ops.length === 0) return base;
  return commit(applyNoteOverlayOps(base, eventId, ops, Date.now()));
}

/**
 * Legacy whole-note write (the pre-ops IPC payload). Diffed against what
 * main holds, so only keys that really differ get stamped — still lossy
 * for a stale caller, which is why the renderer sends ops instead.
 */
export function setNoteOverlay(eventId: string, overlay: NoteOverlay): NotesOverlayFile {
  const base = reconcileDisk();
  return applyOverlayOps(eventId, diffNoteOverlay(base.notes[eventId] ?? {}, overlay));
}

/** Delete one note's overlay, leaving a tombstone so peers can't revive it. */
export function deleteNoteOverlay(eventId: string): void {
  const base = reconcileDisk();
  if (!base.notes[eventId] && !base.tombstones?.[eventId]) return;
  commit(tombstoneNote(base, eventId, Date.now()));
}

/**
 * Fold a remote body (Drive pull, or the iCloud watcher's re-read) into the
 * authoritative copy and write the union back. `changed` = the union moved
 * the local disk, or holds something the remote lacked (so the caller should
 * push it back for the sender to converge). Listeners hear about it when the
 * local content moved — writeJson updates cloudStore's lastSeen, so the
 * file watcher never reports a Drive-pulled write to the renderer itself.
 */
export function ingestRemoteNotesOverlay(body: string): {
  file: NotesOverlayFile; changed: boolean;
} {
  const base = reconcileDisk();
  let remote: NotesOverlayFile;
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!parsed || typeof parsed !== 'object') return { file: base, changed: false };
    remote = normalizeNotesOverlayFile(parsed);
  } catch {
    return { file: base, changed: false };
  }
  const merged = mergeNotesOverlay(base, remote, Date.now());
  const movedLocal = sig(merged) !== sig(base);
  if (movedLocal) {
    commit(merged);
    for (const fn of remoteListeners) {
      try { fn(merged); } catch (e) { console.error('[yCal notes] overlay listener failed', e); }
    }
  } else {
    authoritative = merged;
  }
  return { file: merged, changed: movedLocal || sig(merged) !== sig(remote) };
}

/** Subscribe to overlay changes that arrived from another Mac. */
export function onRemoteNotesOverlay(fn: (file: NotesOverlayFile) => void): () => void {
  remoteListeners.add(fn);
  return () => remoteListeners.delete(fn);
}
