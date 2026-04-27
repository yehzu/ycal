import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { IPC } from '@shared/types';
import { isConfigured } from './config';
import { startAddAccount } from './auth';
import { removeAccount } from './tokenStore';
import { fetchColors, listAccountSummaries, listAllCalendars, listEvents } from './calendar';
import {
  getWeatherUrl, setWeatherUrl, getUiSettings, setUiSettings,
} from './settings';
import { clearWeatherCache, fetchWeather } from './weather';
import {
  setupAutoUpdater, getLastUpdateStatus, checkForUpdatesNow, requestInstall,
} from './updater';

const __dirname_ = path.dirname(fileURLToPath(import.meta.url));

// Resolve the dock/window icon. In dev we point at the source PNG; in
// production electron-builder bakes the .icns into the app bundle, so we
// don't pass an explicit icon path.
const DEV_ICON_PATH = path.resolve(__dirname_, '../../build/icon.png');

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1480,
    height: 900,
    minWidth: 1100,
    minHeight: 720,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#f4ede0',
    vibrancy: 'under-window',
    visualEffectState: 'followWindow',
    icon: process.env.ELECTRON_RENDERER_URL ? DEV_ICON_PATH : undefined,
    show: false,
    webPreferences: {
      preload: path.join(__dirname_, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // safeStorage callable from main only — preload stays clean.
    },
  });

  win.once('ready-to-show', () => win.show());

  // Any window.open(url) from the renderer (e.g. clicked links in event
  // descriptions) opens in the user's default browser instead of a new
  // BrowserWindow.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url) || /^mailto:/i.test(url)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // Block in-place navigation to external URLs too — should never happen
  // with our CSP, but defense-in-depth.
  win.webContents.on('will-navigate', (event, url) => {
    if (process.env.ELECTRON_RENDERER_URL && url.startsWith(process.env.ELECTRON_RENDERER_URL)) {
      return; // dev-server reloads
    }
    if (url.startsWith('file://')) return; // production bundle
    event.preventDefault();
    if (/^https?:\/\//i.test(url) || /^mailto:/i.test(url)) {
      void shell.openExternal(url);
    }
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    win.loadFile(path.join(__dirname_, '../renderer/index.html'));
  }

  return win;
}

function registerIpc() {
  ipcMain.handle(IPC.IsConfigured, () => isConfigured());

  ipcMain.handle(IPC.AddAccount, async () => {
    try {
      const stored = await startAddAccount();
      return {
        ok: true as const,
        account: {
          id: stored.id,
          email: stored.email,
          name: stored.name,
          picture: stored.picture,
        },
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false as const, error: message };
    }
  });

  ipcMain.handle(IPC.RemoveAccount, (_e, id: string) => {
    removeAccount(id);
    return { ok: true as const };
  });

  ipcMain.handle(IPC.ListAccounts, () => listAccountSummaries());

  ipcMain.handle(IPC.ListCalendars, async () => {
    try {
      return { ok: true as const, calendars: await listAllCalendars() };
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
    }
  });

  ipcMain.handle(IPC.ListEvents, async (_e, req) => {
    try {
      return { ok: true as const, events: await listEvents(req) };
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
    }
  });

  ipcMain.handle(IPC.GetColors, async () => {
    try {
      return { ok: true as const, colors: await fetchColors() };
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
    }
  });

  ipcMain.handle(IPC.GetWeatherUrl, () => getWeatherUrl());

  ipcMain.handle(IPC.SetWeatherUrl, (_e, url: string | null) => {
    try {
      setWeatherUrl(url);
      clearWeatherCache();
      return { ok: true as const };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error('[yCal] setWeatherUrl failed:', e);
      return { ok: false as const, error: message };
    }
  });

  ipcMain.handle(IPC.GetWeather, async () => {
    try {
      return { ok: true as const, days: await fetchWeather() };
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
    }
  });

  ipcMain.handle(IPC.GetUiSettings, () => getUiSettings());

  ipcMain.handle(IPC.SetUiSettings, (_e, patch) => {
    try {
      setUiSettings(patch);
      return { ok: true as const };
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
    }
  });

  ipcMain.handle(IPC.UpdateCheck, async () => {
    await checkForUpdatesNow();
    return getLastUpdateStatus();
  });

  ipcMain.handle(IPC.UpdateInstall, () => {
    requestInstall();
  });
}

app.whenReady().then(() => {
  // In dev, set the dock icon explicitly — electron-builder only injects the
  // real icns on packaged builds.
  if (process.platform === 'darwin' && process.env.ELECTRON_RENDERER_URL && app.dock) {
    try { app.dock.setIcon(DEV_ICON_PATH); } catch { /* dock icon is best-effort */ }
  }
  registerIpc();

  if (!isConfigured()) {
    dialog.showMessageBoxSync({
      type: 'warning',
      title: 'yCal — OAuth not configured',
      message: 'OAuth client credentials missing.',
      detail:
        'Place oauth-client.json in:\n' +
        `  ${app.getPath('userData')}\n\n` +
        'See README.md for Google Cloud Console setup.',
    });
  }

  const win = createWindow();
  setupAutoUpdater(win);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
