// Auto-update wiring against GitHub releases.
//
// electron-updater polls the repo's "latest.yml" (published by electron-builder
// when `publish: github` is configured), downloads the new dmg/zip when one
// appears, and exposes `quitAndInstall()` to swap binaries on next launch.
// We surface its lifecycle to the renderer as a single UpdateStatus stream so
// the UI can render the toast + splash from the design.
import electronUpdater from 'electron-updater';
import type { BrowserWindow } from 'electron';
import { app } from 'electron';

import { IPC } from '@shared/types';
import type { UpdateStatus } from '@shared/types';

const { autoUpdater } = electronUpdater;

// Re-check every 6 hours while the app is running. Cheap; GitHub serves
// latest.yml from a CDN, and it's the only way users on long-lived sessions
// learn about new releases without a restart.
const RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

let lastStatus: UpdateStatus = { state: 'idle', version: null };
let currentWin: BrowserWindow | null = null;
let installRequested = false;
let downloadedVersion: string | null = null;

function broadcast(status: UpdateStatus): void {
  lastStatus = status;
  if (currentWin && !currentWin.isDestroyed()) {
    currentWin.webContents.send(IPC.UpdateStatus, status);
  }
}

export function setupAutoUpdater(win: BrowserWindow): void {
  currentWin = win;

  // electron-updater no-ops in dev (no app.asar) — short-circuit so we don't
  // log scary "update check failed" noise during `npm run dev`.
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    broadcast({ state: 'checking', version: null });
  });

  autoUpdater.on('update-available', (info) => {
    // Download starts automatically (autoDownload=true). The toast appears
    // immediately so the user can click "Install & restart" without waiting
    // for the bytes to land — if they're quick, we'll bridge the gap with
    // the splash; if they wait, the install is instant.
    broadcast({ state: 'available', version: info.version, progress: 0 });
  });

  autoUpdater.on('update-not-available', () => {
    broadcast({ state: 'idle', version: null });
  });

  autoUpdater.on('download-progress', (p) => {
    // Surface progress only while the user has already requested install —
    // otherwise the toast text stays calm ("Update available") instead of
    // ticking percentages at someone who hasn't opted in.
    if (installRequested) {
      broadcast({
        state: 'installing',
        version: lastStatus.version,
        progress: Math.round(p.percent),
      });
    }
  });

  autoUpdater.on('update-downloaded', (info) => {
    downloadedVersion = info.version;
    if (installRequested) {
      // User already clicked Install — finish the loop without bouncing
      // back to the renderer. quitAndInstall closes the app, swaps the
      // bundle, and relaunches.
      autoUpdater.quitAndInstall(false, true);
    } else {
      // Stay in `available` so the toast keeps showing "Install & restart";
      // when the user clicks, the install will be instant.
      broadcast({ state: 'available', version: info.version, progress: 100 });
    }
  });

  autoUpdater.on('error', (err) => {
    broadcast({
      state: 'error',
      version: lastStatus.version,
      error: err?.message ?? String(err),
    });
  });

  void autoUpdater.checkForUpdates().catch(() => { /* surfaced via 'error' event */ });
  setInterval(() => {
    void autoUpdater.checkForUpdates().catch(() => {});
  }, RECHECK_INTERVAL_MS);
}

export function getLastUpdateStatus(): UpdateStatus {
  return lastStatus;
}

export async function checkForUpdatesNow(): Promise<void> {
  if (!app.isPackaged) return;
  await autoUpdater.checkForUpdates();
}

// One-click flow: flip the splash on, then either quit immediately (if the
// download already finished) or wait for `update-downloaded` to fire it for
// us. Either way the user only clicks once.
export function requestInstall(): void {
  if (!app.isPackaged) return;
  installRequested = true;
  broadcast({
    state: 'installing',
    version: downloadedVersion ?? lastStatus.version,
    progress: downloadedVersion ? 100 : (lastStatus.progress ?? 0),
  });
  if (downloadedVersion) {
    autoUpdater.quitAndInstall(false, true);
  }
}
