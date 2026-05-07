// yCal — Google Drive cross-device sync.
//
// Layered ON TOP of cloudStore. The user's source-of-truth files still live
// on disk (in iCloud Drive or userData, per their cloudStorage pref).
// Drive sync mirrors them through the per-app `appdata` folder so a phone
// running iOS yCal sees the same state.
//
// Two flows:
//   * Local change → cloudStore writes → onCloudFileChange fires →
//     debounced push to Drive (1.5s window).
//   * Drive change → pull (on launch + every 5 min + manual) → write to
//     cloudStore → cloudStore's lastSeen + the dedup gate here keep the
//     watcher from echoing the just-applied change back to Drive.
//
// `lastSeen[filename]` is the byte body we last observed on the Drive
// SIDE for each file. The dedup gate fires whenever a candidate push or
// pull body matches lastSeen — that's the loop breaker. Mirrors iOS
// DriveSyncStore semantics so the two stay coherent.

import type { BrowserWindow } from 'electron';
import { authClientForAccount } from './auth';
import { getAccount } from './tokenStore';
import {
  CLOUD_FILES, onCloudFileChange, onCloudFileWrite, readRaw, writeJson, writeText,
} from './cloudStore';
import {
  getDriveSyncAccountId, getDriveSyncEnabled,
  setDriveSyncAccountId, setDriveSyncEnabled,
} from './device';
import { DriveAppDataAPI } from './driveAppData';
import { IPC, type DriveSyncStatus } from '@shared/types';

let win: BrowserWindow | null = null;
const lastSeen = new Map<string, string>();
const pushTimers = new Map<string, NodeJS.Timeout>();
let pullInterval: NodeJS.Timeout | null = null;
let pulling = false;
let pushing = 0;
let lastPushed: number | null = null;
let lastPulled: number | null = null;
let lastError: string | null = null;

const PUSH_DEBOUNCE_MS = 1500;
const PULL_INTERVAL_MS = 5 * 60 * 1000;

export function startDriveSync(window: BrowserWindow): void {
  win = window;

  // Two sources of "this file's bytes changed and we should consider
  // pushing to Drive":
  //   1. onCloudFileChange — cloudStore's poll-watcher firing because
  //      iCloud delivered an edit from another Mac. The watcher only
  //      fires when the on-disk body differs from cloudStore's lastSeen
  //      (which is what makes it cross-Mac specific).
  //   2. onCloudFileWrite — every successful local writeAtomic. This
  //      is what catches drag-to-schedule, settings toggles, etc. on
  //      THIS Mac. The watcher would otherwise miss these because
  //      cloudStore.lastSeen is updated synchronously inside
  //      writeAtomic, so the watcher's next poll sees no diff.
  //
  // Both routes funnel through the same dedup-and-debounce push trigger.
  // driveSync's own per-filename `lastSeen` tracks what we last sent to
  // Drive — equality means "we already pushed this, skip".
  const queuePush = (filename: string, body: string): void => {
    if (!isOurFile(filename)) return;
    if (!getDriveSyncEnabled()) return;
    if (lastSeen.get(filename) === body) return; // already on Drive
    schedulePush(filename, body);
  };
  onCloudFileChange(queuePush);
  onCloudFileWrite(queuePush);

  // Initial pull on boot, plus a periodic catch-up. Failures don't kill
  // the timer — they just surface in the status panel until the next
  // attempt succeeds.
  if (getDriveSyncEnabled()) {
    void pullAll().catch(() => { /* surfaced via state */ });
  }
  pullInterval = setInterval(() => {
    if (getDriveSyncEnabled()) {
      void pullAll().catch(() => { /* surfaced via state */ });
    }
  }, PULL_INTERVAL_MS);
}

export function stopDriveSync(): void {
  if (pullInterval) clearInterval(pullInterval);
  pullInterval = null;
  for (const t of pushTimers.values()) clearTimeout(t);
  pushTimers.clear();
  win = null;
}

function isOurFile(filename: string): boolean {
  return (CLOUD_FILES as readonly string[]).includes(filename);
}

function schedulePush(filename: string, body: string): void {
  const existing = pushTimers.get(filename);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => {
    pushTimers.delete(filename);
    void pushFile(filename, body);
  }, PUSH_DEBOUNCE_MS);
  pushTimers.set(filename, t);
}

async function getAuth() {
  const accountId = getDriveSyncAccountId();
  if (!accountId) throw new Error('No sync account selected.');
  const account = getAccount(accountId);
  if (!account) {
    throw new Error('Sync account not found — sign in to that account again.');
  }
  return authClientForAccount(account);
}

async function pushFile(filename: string, body: string): Promise<void> {
  if (!getDriveSyncEnabled()) return;
  if (lastSeen.get(filename) === body) return;
  pushing += 1;
  notify();
  try {
    const auth = await getAuth();
    const api = new DriveAppDataAPI(auth);
    await api.upsert(filename, Buffer.from(body, 'utf-8'));
    lastSeen.set(filename, body);
    lastPushed = Date.now();
    lastError = null;
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e);
  } finally {
    pushing -= 1;
    notify();
  }
}

async function pullAll(): Promise<void> {
  if (pulling) return;
  if (!getDriveSyncEnabled()) return;
  pulling = true;
  notify();
  try {
    const auth = await getAuth();
    const api = new DriveAppDataAPI(auth);
    const remote = await api.list();
    for (const f of CLOUD_FILES) {
      const file = remote.find((r) => r.name === f);
      if (!file?.id) continue;
      let bodyBuf: Buffer;
      try {
        bodyBuf = await api.read(file.id);
      } catch {
        continue;
      }
      const body = bodyBuf.toString('utf-8');
      if (lastSeen.get(f) === body) continue;
      lastSeen.set(f, body);
      // Write through cloudStore so its own lastSeen + the cross-device
      // watcher push to the renderer fire normally. cloudStore.writeJson
      // dedupes by content so this no-ops if the body equals what's
      // already on disk.
      if (f.endsWith('.json')) {
        try {
          const parsed = JSON.parse(body) as unknown;
          writeJson(f, parsed);
        } catch {
          // Malformed JSON on remote — skip rather than corrupt local.
          continue;
        }
      } else {
        writeText(f, body);
      }
    }
    lastPulled = Date.now();
    lastError = null;
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e);
  } finally {
    pulling = false;
    notify();
  }
}

/// Manual push of every cloud-routed file's current bytes. Used by the
/// "PUSH NOW" button in Settings → Sync. Skips files that don't exist on
/// disk yet — they'll get pushed when first written.
export async function pushAllNow(): Promise<void> {
  for (const f of CLOUD_FILES) {
    const body = readRaw(f);
    if (body === null) continue;
    await pushFile(f, body);
  }
}

export async function pullAllNow(): Promise<void> {
  await pullAll();
}

export function getStatus(): DriveSyncStatus {
  return {
    enabled: getDriveSyncEnabled(),
    accountId: getDriveSyncAccountId(),
    state: lastError ? 'error'
      : (pulling || pushing > 0) ? 'syncing'
      : 'idle',
    lastError,
    lastPushedAt: lastPushed,
    lastPulledAt: lastPulled,
  };
}

export function setEnabled(enabled: boolean): DriveSyncStatus {
  setDriveSyncEnabled(enabled);
  if (enabled) {
    void pullAll().catch(() => { /* surfaced via state */ });
  }
  notify();
  return getStatus();
}

export function setAccount(accountId: string | null): DriveSyncStatus {
  setDriveSyncAccountId(accountId);
  // Account changed → invalidate the lastSeen map; the new account's
  // appdata folder is a different bucket and we shouldn't dedupe across.
  lastSeen.clear();
  if (getDriveSyncEnabled() && accountId) {
    void pullAll().catch(() => { /* surfaced via state */ });
  }
  notify();
  return getStatus();
}

function notify(): void {
  if (!win || win.isDestroyed()) return;
  win.webContents.send(IPC.DriveSyncStatusChanged, getStatus());
}
