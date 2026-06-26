// yCal — local task overlay (schedule + done state) backed by cloud store.
//
// What lives here:
//   * `scheduled[id] = { date, start }` — where the user dropped a task on
//     the calendar. This is intentionally local + iCloud-mirrored — it is
//     NEVER pushed back to the source provider (Todoist), because users
//     want to schedule things in yCal without rewriting Todoist's `due`.
//   * `doneOn[id] = 'YYYY-MM-DD'` — local mirror of "user marked it done
//     today" so the panel's "Done today · N" footer works without a fresh
//     fetch. The provider gets the canonical close call when the user
//     toggles done, so the truth is still upstream.
//   * `completed[id]` — snapshot of a closed task so the grid keeps showing
//     its chip for ~30 days after the provider drops it.
//
// ── Cross-device merge (the data-loss fix) ──────────────────────────────
// This overlay is synced by TWO last-write-wins channels at once: iCloud
// Drive (Mac↔Mac) and Google Drive appdata (Mac↔iPhone). Both replace the
// WHOLE file. The old model let any device write its full in-memory maps
// back, so a peer holding a stale blob silently reverted every per-entry
// change another device had made since its snapshot — the "checked todos
// vanished, only Monday survived" bug.
//
// The fix has three parts, all in this file:
//   1. Every tracked key carries a logical clock; deletes leave a
//      tombstone. Combining two versions is therefore a per-key
//      LWW-element-set union (`mergeOverlay`) — never a blind overwrite.
//   2. Mutations arrive as operations (`applyTaskOps`), so MAIN is the sole
//      stamper of clocks. The renderer can no longer ship a stale full map
//      that reverts a key it simply hadn't heard about yet.
//   3. An in-memory `authoritative` copy is the source of truth while the
//      process lives. When a sync channel clobbers the on-disk file with a
//      staler blob, the next read/ingest merges it against `authoritative`
//      and WRITES THE RECOVERED STATE BACK — so disk + every peer converge
//      to the union instead of the stale snapshot.
//
// `cache`/`cacheAt` are a per-device render-on-boot snapshot of the
// provider's task list. They are deliberately NOT part of the merge: each
// device keeps its own freshly-fetched cache so a peer's cache can't churn
// the file across the network.
//
// On first run with the new schema we migrate any pre-existing data out of
// settings.json into tasks-schedule.json (cloud) and scrub the legacy keys.

import type { TaskItem, TaskOverlayOp, TasksLocalState } from '@shared/types';
import { readJsonStrict, writeJson } from './cloudStore';
import { clearLegacyFields, readLegacyTasks } from './settings';

const FILE = 'tasks-schedule.json';
let migrated = false;

// In-memory source of truth. Seeded from disk on first access and kept in
// step with every applyTaskOps / setTasksLocal / ingestRemoteOverlay. It
// survives an out-of-band on-disk clobber by a sync channel — that's what
// lets us recover entries the clobbering peer never knew about.
let authoritative: TasksLocalState | null = null;

// How long we keep a chip on the calendar grid after a task is closed.
// Anything older is pruned at write time so the file doesn't grow forever.
const COMPLETED_RETAIN_DAYS = 30;
// Tombstones can be dropped once no live peer could still be holding the
// deleted entry with an older clock. 60 days is comfortably past any
// realistic offline-device window and keeps the metadata bounded.
const TOMBSTONE_RETAIN_MS = 60 * 24 * 60 * 60 * 1000;

type TrackedMap = 'scheduled' | 'doneOn' | 'completed';
const TRACKED: TrackedMap[] = ['scheduled', 'doneOn', 'completed'];

function nowMs(): number {
  return Date.now();
}

function emptyState(): TasksLocalState {
  return { scheduled: {}, doneOn: {} };
}

function isoDateMinusDays(days: number): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Read-only view of a tracked map — never mutates the input (so passing an
// overlay with no `completed` doesn't graft an empty object onto it).
function liveMap(s: TasksLocalState, m: TrackedMap): Record<string, unknown> {
  if (m === 'scheduled') return s.scheduled;
  if (m === 'doneOn') return s.doneOn;
  return (s.completed ?? {}) as Record<string, unknown>;
}

// ── Clock / tombstone bookkeeping ───────────────────────────────────────

function setClock(s: TasksLocalState, m: TrackedMap, id: string, t: number): void {
  const key = `${m}:${id}`;
  (s.clocks ??= {})[key] = t;
  if (s.tombstones) delete s.tombstones[key];
}

function setTombstone(s: TasksLocalState, m: TrackedMap, id: string, t: number): void {
  const key = `${m}:${id}`;
  (s.tombstones ??= {})[key] = t;
  if (s.clocks) delete s.clocks[key];
}

// ── Pruning ─────────────────────────────────────────────────────────────

function prune(s: TasksLocalState): TasksLocalState {
  // Drop completed snapshots past the retention window, plus their clocks.
  if (s.completed) {
    const cutoff = isoDateMinusDays(COMPLETED_RETAIN_DAYS);
    for (const [id, entry] of Object.entries(s.completed)) {
      if (entry.completedOn < cutoff) {
        delete s.completed[id];
        if (s.clocks) delete s.clocks[`completed:${id}`];
      }
    }
    if (Object.keys(s.completed).length === 0) delete s.completed;
  }
  // Drop stale tombstones so the metadata stays bounded.
  if (s.tombstones) {
    const tombCutoff = nowMs() - TOMBSTONE_RETAIN_MS;
    for (const [key, ts] of Object.entries(s.tombstones)) {
      if (ts < tombCutoff) delete s.tombstones[key];
    }
    if (Object.keys(s.tombstones).length === 0) delete s.tombstones;
  }
  if (s.clocks && Object.keys(s.clocks).length === 0) delete s.clocks;
  return s;
}

// ── Per-key LWW-element-set merge ───────────────────────────────────────
//
// `a` is the LOCAL side, `b` the REMOTE side. cache/cacheAt always come
// from `a` (see file header — cache is intentionally device-local).
function maxDef(x: number | undefined, y: number | undefined): number | undefined {
  if (x === undefined) return y;
  if (y === undefined) return x;
  return x > y ? x : y;
}

export function mergeOverlay(a: TasksLocalState, b: TasksLocalState): TasksLocalState {
  const out: TasksLocalState = {
    scheduled: {},
    doneOn: {},
    completed: {},
    clocks: {},
    cache: a.cache,
    cacheAt: a.cacheAt,
  };
  const tombstones: Record<string, number> = {};

  for (const m of TRACKED) {
    const am = liveMap(a, m);
    const bm = liveMap(b, m);
    const ids = new Set<string>([...Object.keys(am), ...Object.keys(bm)]);
    // Also consider keys that exist only as clock/tombstone metadata so a
    // remote delete (tombstone, no live entry) is honoured.
    for (const src of [a, b]) {
      for (const rec of [src.clocks, src.tombstones]) {
        if (!rec) continue;
        for (const key of Object.keys(rec)) {
          if (key.startsWith(`${m}:`)) ids.add(key.slice(m.length + 1));
        }
      }
    }

    const outMap = liveMap(out, m) as Record<string, unknown>;
    for (const id of ids) {
      const key = `${m}:${id}`;
      const aHas = Object.prototype.hasOwnProperty.call(am, id);
      const bHas = Object.prototype.hasOwnProperty.call(bm, id);
      // Legacy files have no clocks: a present entry counts as clock 0 so
      // any timestamped peer write wins over it, but it still beats a peer
      // that simply lacks the key (absent, no tombstone).
      let aClk = a.clocks?.[key];
      if (aClk === undefined && aHas) aClk = 0;
      let bClk = b.clocks?.[key];
      if (bClk === undefined && bHas) bClk = 0;
      const aTomb = a.tombstones?.[key];
      const bTomb = b.tombstones?.[key];

      const clk = maxDef(aClk, bClk);
      const tomb = maxDef(aTomb, bTomb);
      if (clk === undefined && tomb === undefined) continue;

      const live = clk !== undefined && (tomb === undefined || clk >= tomb);
      if (live) {
        let val: unknown;
        if (aHas && (bClk === undefined || (aClk ?? -1) >= (bClk ?? -1))) val = am[id];
        else if (bHas) val = bm[id];
        else val = aHas ? am[id] : bm[id];
        if (val !== undefined) {
          outMap[id] = val;
          // Don't persist the synthetic clock-0 we give legacy (pre-merge)
          // entries — that would churn the file against a peer still on the
          // old format. Real clocks are Date.now() and always positive.
          if (clk) out.clocks![key] = clk;
        }
      } else {
        tombstones[key] = tomb!;
      }
    }
  }

  if (Object.keys(tombstones).length > 0) out.tombstones = tombstones;
  if (out.completed && Object.keys(out.completed).length === 0) delete out.completed;
  if (out.clocks && Object.keys(out.clocks).length === 0) delete out.clocks;
  return out;
}

// Signature of just the merge-tracked slices (everything except the
// device-local cache). Two overlays with the same tracked signature are
// equivalent for sync purposes, so we don't write or push on cache-only
// differences.
function trackedSig(s: TasksLocalState): string {
  const pick = (rec?: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(rec ?? {}).sort()) {
      out[k] = (rec as Record<string, unknown>)[k];
    }
    return out;
  };
  return JSON.stringify({
    scheduled: pick(s.scheduled),
    doneOn: pick(s.doneOn),
    completed: pick(s.completed as Record<string, unknown> | undefined),
    clocks: pick(s.clocks),
    tombstones: pick(s.tombstones),
  });
}

// ── Disk IO ─────────────────────────────────────────────────────────────

// `corrupt` mirrors the same defense used in settings.ts / rhythm.ts:
// when iCloud Drive briefly serves a 0-byte placeholder during sync, a
// blind write would clobber the user's real schedule with an empty map.
function readStrict(): { data: TasksLocalState; corrupt: boolean } {
  const result = readJsonStrict<TasksLocalState>(FILE);
  if (result.status === 'missing' || !result.data) {
    return { data: emptyState(), corrupt: result.status === 'corrupt' };
  }
  const raw = result.data;
  return {
    data: {
      scheduled: raw.scheduled ?? {},
      doneOn: raw.doneOn ?? {},
      cache: raw.cache,
      cacheAt: raw.cacheAt,
      completed: raw.completed,
      clocks: raw.clocks,
      tombstones: raw.tombstones,
    },
    corrupt: false,
  };
}

// Reconcile the in-memory authoritative copy with whatever is on disk right
// now, folding in any change a sync channel applied out-of-band. If the
// merge recovers entries the disk was missing (a stale clobber), write the
// union back so disk + peers converge. Returns the reconciled state.
function reconcileDisk(): TasksLocalState {
  const { data: disk, corrupt } = readStrict();
  if (corrupt) return authoritative ?? emptyState();
  if (!authoritative) {
    authoritative = prune(disk);
    return authoritative;
  }
  // a = our authoritative (keeps cache), b = disk.
  const merged = prune(mergeOverlay(authoritative, disk));
  authoritative = merged;
  if (trackedSig(merged) !== trackedSig(disk)) {
    // Disk was stale/clobbered relative to what we hold — restore the union.
    writeJson(FILE, merged);
  }
  return merged;
}

function migrateIfNeeded(): void {
  if (migrated) return;
  migrated = true;
  const legacy = readLegacyTasks();
  if (!legacy) return;
  // If the cloud file already exists with content, prefer it — the user
  // may have already migrated on another device. Just clear settings.json.
  const { data: existing, corrupt } = readStrict();
  if (corrupt) return; // never clobber on a transient bad read
  if (Object.keys(existing.scheduled).length > 0
      || Object.keys(existing.doneOn).length > 0) {
    clearLegacyFields();
    return;
  }
  const next: TasksLocalState = {
    scheduled: legacy.scheduled,
    doneOn: legacy.doneOn,
  };
  writeJson(FILE, next);
  clearLegacyFields();
}

// ── Public API ──────────────────────────────────────────────────────────

export function getTasksLocal(): TasksLocalState {
  migrateIfNeeded();
  return reconcileDisk();
}

// Apply the renderer's schedule/done intents. MAIN stamps the merge clocks
// here so a stale full-map write can never silently revert a peer's key.
export function applyTaskOps(ops: TaskOverlayOp[]): TasksLocalState {
  migrateIfNeeded();
  const base = reconcileDisk();
  if (ops.length === 0) return base;
  const next: TasksLocalState = {
    scheduled: { ...base.scheduled },
    doneOn: { ...base.doneOn },
    completed: base.completed ? { ...base.completed } : undefined,
    cache: base.cache,
    cacheAt: base.cacheAt,
    clocks: { ...(base.clocks ?? {}) },
    tombstones: base.tombstones ? { ...base.tombstones } : undefined,
  };
  const t = nowMs();
  for (const op of ops) {
    switch (op.kind) {
      case 'schedule':
        next.scheduled[op.id] = { date: op.date, start: op.start };
        setClock(next, 'scheduled', op.id, t);
        break;
      case 'unschedule':
        delete next.scheduled[op.id];
        setTombstone(next, 'scheduled', op.id, t);
        break;
      case 'close':
        next.doneOn[op.id] = op.completedOn;
        setClock(next, 'doneOn', op.id, t);
        if (op.snapshot) {
          (next.completed ??= {})[op.id] = {
            snapshot: op.snapshot,
            completedOn: op.completedOn,
          };
          setClock(next, 'completed', op.id, t);
        }
        break;
      case 'reopen':
        delete next.doneOn[op.id];
        setTombstone(next, 'doneOn', op.id, t);
        if (next.completed) delete next.completed[op.id];
        setTombstone(next, 'completed', op.id, t);
        break;
    }
  }
  const pruned = prune(next);
  authoritative = pruned;
  writeJson(FILE, pruned);
  return pruned;
}

// Fold a remote body (from a Drive pull, or the iCloud watcher re-reading a
// just-replaced file) into our authoritative state. Writes the union back
// to disk when the tracked slices changed, so a stale peer blob can never
// erase entries it didn't know about. Returns the merged state plus whether
// the tracked content moved (callers use that to decide whether to push the
// recovered union back upstream).
export function ingestRemoteOverlay(body: string): {
  state: TasksLocalState; changed: boolean;
} {
  migrateIfNeeded();
  const base = reconcileDisk();
  let remote: TasksLocalState;
  try {
    const parsed = JSON.parse(body) as Partial<TasksLocalState> | null;
    if (!parsed || typeof parsed !== 'object') return { state: base, changed: false };
    remote = {
      scheduled: parsed.scheduled ?? {},
      doneOn: parsed.doneOn ?? {},
      completed: parsed.completed,
      clocks: parsed.clocks,
      tombstones: parsed.tombstones,
    };
  } catch {
    return { state: base, changed: false };
  }
  const merged = prune(mergeOverlay(base, remote));
  authoritative = merged;
  const changedDisk = trackedSig(merged) !== trackedSig(base);
  if (changedDisk) writeJson(FILE, merged);
  // Did the union end up with anything the remote lacked? If so the caller
  // should push it so the sending peer converges too.
  const aheadOfRemote = trackedSig(merged) !== trackedSig(remote);
  return { state: merged, changed: changedDisk || aheadOfRemote };
}

// Cache-only updates (the per-device Todoist poll). Kept off the merge path
// — cache is device-local — so this never stamps clocks. Preserves the
// schedule/done/clock/tombstone slices untouched.
export function setTasksLocal(patch: Partial<TasksLocalState>): TasksLocalState {
  migrateIfNeeded();
  const cur = reconcileDisk();
  const next: TasksLocalState = {
    scheduled: patch.scheduled ?? cur.scheduled,
    doneOn: patch.doneOn ?? cur.doneOn,
    cache: patch.cache ?? cur.cache,
    cacheAt: patch.cacheAt ?? cur.cacheAt,
    completed: patch.completed ?? cur.completed,
    clocks: cur.clocks,
    tombstones: cur.tombstones,
  };
  authoritative = next;
  // Dedupe excluding cacheAt — every TasksList poll bumps cacheAt even when
  // nothing else changed, which would otherwise echo across Macs every 5
  // minutes via the cloud watcher.
  if (
    JSON.stringify({ ...cur, cacheAt: undefined }) ===
      JSON.stringify({ ...next, cacheAt: undefined })
  ) {
    return cur;
  }
  writeJson(FILE, next);
  return next;
}
