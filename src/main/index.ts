import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { IPC } from '@shared/types';
import { isConfigured } from './config';
import { startAddAccount } from './auth';
import { removeAccount } from './tokenStore';
import {
  fetchColors, listAccountSummaries, listAllCalendars, listEvents,
  invalidateCalendarCache, invalidateEventsCache,
} from './calendar';
import {
  getWeatherUrl, setWeatherUrl, getUiSettings, setUiSettings, getTaskProviderId,
} from './settings';
import { clearWeatherCache, fetchWeather } from './weather';
import {
  setupAutoUpdater, getLastUpdateStatus, checkForUpdatesNow, requestInstall,
} from './updater';
import { runCli, extractCliArgs, isCliInvocation } from './cli';
import { startCliServer } from './cliServer';
import {
  getRhythm, setOverride, clearOverride, setDefault,
} from './rhythm';
import {
  CLOUD_FILES, getStorageInfo, migrateMissingToCloud, onCloudFileChange,
  setStorage, startCloudWatcher,
} from './cloudStore';
import {
  getActiveProvider, getActiveProviderInfo, listProviders, revealMarkdownFile,
  setActiveProvider,
} from './taskProviders';
import { getTasksLocal, setTasksLocal } from './tasksStore';

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
      invalidateCalendarCache();
      invalidateEventsCache();
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
    invalidateCalendarCache();
    invalidateEventsCache();
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

  // ── Tasks (active provider) ───────────────────────────────────────
  ipcMain.handle(IPC.TasksGetProviderInfo, () => getActiveProviderInfo());
  ipcMain.handle(IPC.TasksListProviders, () => listProviders());
  ipcMain.handle(IPC.TasksSetActiveProvider, (_e, id: 'todoist' | 'markdown') => {
    try {
      const info = setActiveProvider(id);
      return { ok: true as const, info };
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
    }
  });
  ipcMain.handle(IPC.TasksRevealStorage, () => {
    if (getActiveProvider().id === 'markdown') revealMarkdownFile();
  });
  ipcMain.handle(IPC.TasksSetCredentials, (_e, key: string | null) => {
    try {
      getActiveProvider().setCredentials(key);
      return { ok: true as const };
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
    }
  });
  ipcMain.handle(IPC.TasksList, async () => {
    try {
      const result = await getActiveProvider().listTasks();
      setTasksLocal({ cache: result.tasks, cacheAt: new Date().toISOString() });
      return { ok: true as const, ...result };
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
    }
  });
  ipcMain.handle(IPC.TasksClose, async (_e, taskId: string) => {
    try {
      await getActiveProvider().closeTask(taskId);
      return { ok: true as const };
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
    }
  });
  ipcMain.handle(IPC.TasksReopen, async (_e, taskId: string) => {
    try {
      await getActiveProvider().reopenTask(taskId);
      return { ok: true as const };
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
    }
  });
  ipcMain.handle(IPC.TasksAddComment, async (_e, taskId: string, text: string) => {
    try {
      const comment = await getActiveProvider().addComment(taskId, text);
      return { ok: true as const, comment };
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
    }
  });
  ipcMain.handle(IPC.TasksGetLocal, () => getTasksLocal());
  ipcMain.handle(IPC.TasksSetLocal, (_e, patch) => {
    try {
      const next = setTasksLocal(patch);
      return { ok: true as const, state: next };
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
    }
  });

  // ── Day rhythm ────────────────────────────────────────────────────
  ipcMain.handle(IPC.RhythmGet, () => getRhythm());
  ipcMain.handle(IPC.RhythmSetOverride, (_e, dateStr: string, patch: { wakeMin?: number; sleepMin?: number }) => {
    try {
      const data = setOverride(dateStr, patch);
      return { ok: true as const, data };
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
    }
  });
  ipcMain.handle(IPC.RhythmClearOverride, (_e, dateStr: string) => {
    try {
      const data = clearOverride(dateStr);
      return { ok: true as const, data };
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
    }
  });
  ipcMain.handle(IPC.RhythmSetDefault, (_e, fromDateStr: string, next: { wakeMin: number; sleepMin: number }) => {
    try {
      const data = setDefault(fromDateStr, next);
      return { ok: true as const, data };
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
    }
  });

  // ── Cloud storage (rhythm.json + tasks-schedule.json) ─────────────
  ipcMain.handle(IPC.CloudGetStorageInfo, () => getStorageInfo());
  ipcMain.handle(IPC.CloudSetStorage, (_e, pref: 'icloud' | 'local') => {
    try {
      const info = setStorage(pref, CLOUD_FILES);
      return { ok: true as const, info };
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
    }
  });
}

if (isCliInvocation(process.argv)) {
  // Headless CLI mode. We still need Electron's runtime (safeStorage relies
  // on it) but we skip the window, dock icon, missing-config dialog, and
  // auto-updater. Quit explicitly with the CLI's exit code.
  if (process.platform === 'darwin' && app.dock) {
    try { app.dock.hide(); } catch { /* best-effort */ }
  }
  // Some Google API failure paths log via console.log; keep stdout reserved
  // for the CLI's structured output by pinning info to stderr.
  const origLog = console.log;
  console.log = (...args: unknown[]) => console.error(...args);
  app.whenReady().then(async () => {
    let code = 0;
    try {
      try { migrateMissingToCloud(); } catch { /* CLI keeps going */ }
      code = await runCli(extractCliArgs(process.argv), process.stdout, process.stderr);
    } catch (e) {
      process.stderr.write(`ycal: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
      code = 1;
    } finally {
      console.log = origLog;
      app.exit(code);
    }
  });
} else {
  app.whenReady().then(() => {
    // In dev, set the dock icon explicitly — electron-builder only injects the
    // real icns on packaged builds.
    if (process.platform === 'darwin' && process.env.ELECTRON_RENDERER_URL && app.dock) {
      try { app.dock.setIcon(DEV_ICON_PATH); } catch { /* dock icon is best-effort */ }
    }
    // One-shot: when upgrading to a build that adds new entries to
    // CLOUD_FILES (e.g. settings.json moves into the synced set), copy
    // any pre-existing userData copies into iCloud so the first launch
    // after the upgrade reads the right values instead of resetting.
    try { migrateMissingToCloud(); } catch (e) { console.error('[yCal] cloud migration error', e); }
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
    startCliServer();
    startCloudSync(win);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

// Cross-device sync: watch every cloud-routed file. When iCloud Drive
// delivers an edit from another Mac, the file's mtime changes, the
// watcher reads the new body, and we push the relevant slice to the
// renderer over IPC. cloudStore dedupes by content so our own writes
// don't echo back as fake remote events.
function startCloudSync(win: BrowserWindow): void {
  startCloudWatcher();
  onCloudFileChange((filename) => {
    if (win.isDestroyed()) return;
    try {
      switch (filename) {
        case 'settings.json':
          win.webContents.send(IPC.SettingsChanged, {
            ui: getUiSettings(),
            weatherIcsUrl: getWeatherUrl(),
            taskProviderId: getTaskProviderId(),
          });
          break;
        case 'rhythm.json':
          win.webContents.send(IPC.RhythmChanged, getRhythm());
          break;
        case 'tasks-schedule.json':
          win.webContents.send(IPC.TasksLocalChanged, getTasksLocal());
          break;
        case 'tasks.md':
          // No payload — renderer just calls tasks.refresh() if the
          // markdown provider is currently active.
          win.webContents.send(IPC.TasksProviderDataChanged, {
            providerId: 'markdown',
          });
          break;
      }
    } catch (e) {
      console.error('[yCal] cloud-sync push failed for', filename, e);
    }
  });
}
