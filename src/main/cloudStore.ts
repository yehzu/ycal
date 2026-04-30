// yCal — cloud-aware JSON file store.
//
// Files written through this module live in iCloud Drive when the user has
// the iCloud Drive folder available AND has the storage preference set to
// 'icloud'. Otherwise they live in the local userData dir. The same file
// name is used in both locations, so toggling between them just swaps the
// directory we read from / write to.
//
// Today this backs `rhythm.json` (wake/sleep) and `tasks-schedule.json`
// (Todoist-task local schedule overlay). Adding a new file is one call
// to `readJson` / `writeJson`.

import { app } from 'electron';
import {
  accessSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CloudStorage, CloudStorageInfo } from '@shared/types';
import { getCloudStoragePref, setCloudStoragePref } from './settings';

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

export function writeJson<T>(filename: string, data: T): void {
  const { path: p } = pathFor(filename);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(data, null, 2), 'utf-8');
}

// List of filenames to migrate when the user flips the storage toggle. Add
// any new cloud-stored files here.
export const CLOUD_FILES = ['rhythm.json', 'tasks-schedule.json'];
