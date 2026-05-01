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
  renameSync, unlinkSync, writeFileSync,
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
  }
  return getStorageInfo();
}

export function readJson<T>(filename: string, fallback: T): T {
  const { path: p } = pathFor(filename);
  if (!existsSync(p)) return fallback;
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as T;
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
  const { path: p, effective } = pathFor(filename);
  mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  let lastErr: unknown = null;
  for (let i = 0; i < ATTEMPTS; i++) {
    try {
      writeFileSync(tmp, body, 'utf-8');
      renameSync(tmp, p);
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
    return readFileSync(p, 'utf-8');
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
