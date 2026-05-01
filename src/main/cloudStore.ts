// yCal — cloud-aware file store.
//
// Files written through this module live in iCloud Drive when the user has
// the iCloud Drive folder available AND has the storage preference set to
// 'icloud'. Otherwise they live in the local userData dir. The same file
// name is used in both locations, so toggling between them just swaps the
// directory we read from / write to.
//
// Today this backs:
//   * `rhythm.json`            — wake/sleep
//   * `tasks-schedule.json`    — Todoist-task local schedule overlay
//   * `settings.json`          — UI prefs, calendar visibility, weather URL
//   * `tasks.md`               — markdown-provider task store
//
// The `cloudStorage` preference itself lives in `device.json` (per-device,
// userData) so we can read settings.json from the right location without
// bootstrapping ourselves into a circular import.
//
// Adding a new file: register the filename in `CLOUD_FILES`, then read /
// write through `readJson` / `writeJson` (or `readText` / `writeText` for
// non-JSON payloads).

import { app } from 'electron';
import {
  accessSync, constants, existsSync, mkdirSync, readFileSync,
  renameSync, statSync, unlinkSync, unwatchFile, watchFile,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CloudStorage, CloudStorageInfo } from '@shared/types';
import { getCloudStoragePref, setCloudStoragePref } from './device';

const ICLOUD_ROOT = path.join(
  os.homedir(), 'Library/Mobile Documents/com~apple~CloudDocs',
);
const ICLOUD_DIR = path.join(ICLOUD_ROOT, 'yCal');

export function isIcloudAvailable(): boolean {
  if (process.platform !== 'darwin') return false;
  if (!existsSync(ICLOUD_ROOT)) return false;
  try {
    accessSync(ICLOUD_ROOT, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function effectiveDir(): { dir: string; effective: CloudStorage } {
  const pref = getCloudStoragePref();
  if (pref === 'icloud' && isIcloudAvailable()) {
    return { dir: ICLOUD_DIR, effective: 'icloud' };
  }
  return { dir: app.getPath('userData'), effective: 'local' };
}

export function pathFor(filename: string): { path: string; effective: CloudStorage } {
  const { dir, effective } = effectiveDir();
  return { path: path.join(dir, filename), effective };
}

export function getStorageInfo(): CloudStorageInfo {
  const { dir, effective } = effectiveDir();
  return {
    effective,
    preferred: getCloudStoragePref(),
    dir,
    icloudAvailable: isIcloudAvailable(),
  };
}

// Move every cloud-stored file across when the preference changes. We copy
// rather than rename so a botched move can be backed out by hand — the old
// file just sits where it was.
export function setStorage(
  pref: CloudStorage, filenames: string[],
): CloudStorageInfo {
  const before = effectiveDir();
  setCloudStoragePref(pref);
  const after = effectiveDir();
  if (after.dir !== before.dir) {
    for (const name of filenames) {
      const src = path.join(before.dir, name);
      if (!existsSync(src)) continue;
      try {
        const data = readFileSync(src, 'utf-8');
        const dst = path.join(after.dir, name);
        mkdirSync(path.dirname(dst), { recursive: true });
        writeFileSync(dst, data, 'utf-8');
      } catch (e) {
        // Don't tank the toggle just because one file copy failed; log it.
        console.error('[yCal] cloud move failed for', name, e);
      }
    }
    // The active dir just moved — repoint the watcher so we observe
    // changes at the new location instead of the old one.
    rebuildCloudWatcher();
  }
  return getStorageInfo();
}

// Last-known body per cloud-routed filename. Maintained on every read AND
// every write. The watcher uses it to suppress no-op notifications: if we
// just wrote v3 ourselves, the watcher's next poll will see the same v3
// and skip emitting a "file changed" event (we already know). It also
// suppresses the round-trip when a renderer applies a remote update and
// then auto-writes the identical state back: writeJson sees lastSeen ===
// new body and skips the disk hit entirely.
const lastSeen = new Map<string, string>();

export function readJson<T>(filename: string, fallback: T): T {
  const { path: p } = pathFor(filename);
  if (!existsSync(p)) return fallback;
  try {
    const body = readFileSync(p, 'utf-8');
    lastSeen.set(filename, body);
    return JSON.parse(body) as T;
  } catch {
    return fallback;
  }
}

// Atomic write via tmp-sibling + rename. iCloud Drive briefly locks the
// live file mid-sync, which makes a plain truncate-and-write hit EPERM.
// rename(2) on the same filesystem doesn't need to open the destination,
// so it slips past that lock window. We also retry a few times because
// the upload window can straddle a single attempt.
const ATTEMPTS = 4;
const _waitBuf = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms: number): void {
  Atomics.wait(_waitBuf, 0, 0, ms);
}

function writeAtomic(filename: string, body: string): void {
  // Content-dedupe: if the new body matches what we last saw on disk,
  // there's nothing to write. This is the primary loop-breaker for the
  // remote-update path — renderer receives v2 → applies → auto-save
  // effect tries to write v2 → we no-op here.
  if (lastSeen.get(filename) === body) return;
  const { path: p, effective } = pathFor(filename);
  mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  let lastErr: unknown = null;
  for (let i = 0; i < ATTEMPTS; i++) {
    try {
      writeFileSync(tmp, body, 'utf-8');
      renameSync(tmp, p);
      lastSeen.set(filename, body);
      return;
    } catch (e) {
      lastErr = e;
      try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best-effort */ }
      if (i < ATTEMPTS - 1) sleepSync(75 * (i + 1));
    }
  }
  const hint = effective === 'icloud'
    ? ' (iCloud Drive may be syncing this file — try again in a moment, or switch storage to Local in Settings → Sync)'
    : '';
  throw new Error(
    `cloudStore: failed to write ${filename}${hint}: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`,
  );
}

export function writeJson<T>(filename: string, data: T): void {
  writeAtomic(filename, JSON.stringify(data, null, 2));
}

export function readText(filename: string, fallback: string): string {
  const { path: p } = pathFor(filename);
  if (!existsSync(p)) return fallback;
  try {
    const body = readFileSync(p, 'utf-8');
    lastSeen.set(filename, body);
    return body;
  } catch {
    return fallback;
  }
}

export function writeText(filename: string, body: string): void {
  writeAtomic(filename, body);
}

// One-shot startup migration: when upgrading to a build that adds new
// entries to CLOUD_FILES (e.g. settings.json moves into the synced set),
// the user may already have those files in userData but not in iCloud.
// If iCloud is the active storage and the iCloud-side copy is missing,
// copy the userData-side copy across so the renderer doesn't see a
// reset on first launch after the upgrade.
export function migrateMissingToCloud(): void {
  const pref = getCloudStoragePref();
  if (pref !== 'icloud') return;
  if (!isIcloudAvailable()) return;
  for (const name of CLOUD_FILES) {
    const local = path.join(app.getPath('userData'), name);
    const cloud = path.join(ICLOUD_DIR, name);
    if (existsSync(cloud)) continue;
    if (!existsSync(local)) continue;
    try {
      mkdirSync(path.dirname(cloud), { recursive: true });
      writeFileSync(cloud, readFileSync(local, 'utf-8'), 'utf-8');
    } catch (e) {
      console.error('[yCal] startup cloud migration failed for', name, e);
    }
  }
}

// List of filenames that follow the user across devices via the storage
// toggle. Add any new cloud-stored files here AND register them above in
// the file-purpose comment so future maintainers know what travels.
export const CLOUD_FILES = [
  'rhythm.json',
  'tasks-schedule.json',
  'settings.json',
  'tasks.md',
];

// ── Cross-device file watcher ────────────────────────────────────────
//
// fs.watchFile (poll-based) over fs.watch (FSEvents) is a deliberate
// choice for iCloud Drive. FSEvents on iCloud-synced replacements is
// unreliable in practice — Apple replaces files atomically via rename,
// and depending on whether the placeholder was downloaded or evicted,
// the event sometimes never fires in the receiving process. Polling
// stat() every 1.5s gives us a ceiling on the worst-case detection lag
// with no missed events. The cost (one stat per file per poll) is
// negligible at our scale (4 files).
//
// The watcher is started by main on app boot and rebuilt on storage
// toggle (effectiveDir() may have moved). Handlers fire only when the
// new body differs from `lastSeen` — so our own writes never echo back
// as remote changes.

type CloudFileHandler = (filename: string, body: string) => void;
const handlers = new Set<CloudFileHandler>();

let watchedDir: string | null = null;

export function onCloudFileChange(handler: CloudFileHandler): () => void {
  handlers.add(handler);
  return () => { handlers.delete(handler); };
}

function pollListener(filename: string): () => void {
  return () => {
    // statSync may race with iCloud's atomic rename; guard against
    // transient absence and try again on the next tick.
    let body: string;
    try {
      const { path: p } = pathFor(filename);
      if (!existsSync(p)) return;
      body = readFileSync(p, 'utf-8');
    } catch {
      return;
    }
    if (lastSeen.get(filename) === body) return;
    lastSeen.set(filename, body);
    for (const h of handlers) {
      try { h(filename, body); } catch (e) {
        console.error('[yCal] cloud file watcher handler error', e);
      }
    }
  };
}

const watcherCallbacks = new Map<string, ReturnType<typeof pollListener>>();

function detachWatcher(): void {
  if (!watchedDir) return;
  for (const [name, cb] of watcherCallbacks) {
    try { unwatchFile(path.join(watchedDir, name), cb); } catch { /* ignore */ }
  }
  watcherCallbacks.clear();
  watchedDir = null;
}

function attachWatcher(): void {
  const { dir } = effectiveDir();
  if (watchedDir === dir) return;
  detachWatcher();
  watchedDir = dir;
  for (const name of CLOUD_FILES) {
    const cb = pollListener(name);
    watcherCallbacks.set(name, cb);
    // 1500ms — under iCloud's typical sync delivery window so the user
    // sees a remote change within a couple of seconds. watchFile is
    // tolerant of files that don't yet exist; stat returns size 0 and
    // we no-op on read failure until the file appears.
    try {
      watchFile(path.join(dir, name), { interval: 1500, persistent: false }, cb);
    } catch (e) {
      console.error('[yCal] failed to watch', name, e);
    }
  }
}

export function startCloudWatcher(): void {
  attachWatcher();
  // Seed lastSeen from existing files so the first poll doesn't fire
  // a spurious "changed!" notification on every file we already know
  // about. Without this, every file emits once on app boot.
  for (const name of CLOUD_FILES) {
    if (lastSeen.has(name)) continue;
    const { path: p } = pathFor(name);
    if (!existsSync(p)) continue;
    try {
      // stat first to avoid a read on a 0-byte placeholder.
      const st = statSync(p);
      if (st.size === 0) continue;
      lastSeen.set(name, readFileSync(p, 'utf-8'));
    } catch { /* best-effort */ }
  }
}

// Repoint the watcher after the user toggles cloudStorage. Called from
// setStorage() below so the new effective directory is the one we poll.
export function rebuildCloudWatcher(): void {
  // Drop the lastSeen map — content read from the new dir might differ
  // from what we remember in the old dir, and we WANT to fire a
  // "changed" event when the new dir's contents are different (so the
  // renderer picks up the post-toggle state).
  lastSeen.clear();
  attachWatcher();
  startCloudWatcher(); // re-seed from new dir
}
