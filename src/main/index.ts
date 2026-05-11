import { app, BrowserWindow, globalShortcut, ipcMain, dialog, shell, Notification } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

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
  getSettingsSnapshotStrict,
} from './settings';
import { clearWeatherCache, fetchWeather } from './weather';
import {
  setupAutoUpdater, getLastUpdateStatus, checkForUpdatesNow, requestInstall,
} from './updater';
import { refreshTraySoon, startTray, stopTray } from './tray';
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
  getStatus as driveSyncGetStatus,
  setEnabled as driveSyncSetEnabled,
  setAccount as driveSyncSetAccount,
  pushAllNow as driveSyncPushAllNow,
  pullAllNow as driveSyncPullAllNow,
  startDriveSync,
} from './driveSync';
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

// Quick-add: small frameless popup that takes a single title, sends it to
// the active task provider, then dismisses itself. Lives apart from the
// main window so the user can fire it without leaving whatever app they
// were in. URL param `mode=quickadd` flips the renderer entry to render
// the QuickAdd component instead of the full calendar app.
const QUICK_ADD_SHORTCUT = 'CommandOrControl+Shift+Y';
let quickAddWindow: BrowserWindow | null = null;
// Bundle id of the app that was frontmost when the chord fired. Captured
// synchronously (via awaited osascript) BEFORE the popup window opens, so
// we know it's the user's previous app (Slack, browser, …), not yCal
// itself. Consumed once on dismiss.
let quickAddPreviousAppId: string | null = null;

// AppleScript that returns the bundle id of whichever app is currently
// frontmost. The 0.6.2/0.6.3 implementation kicked this off in parallel
// with window creation — by the time osascript actually queried System
// Events, our popup had already focused and yCal was frontmost. The
// returned id was always "com.ycal.app", which we filtered to null,
// leaving us with nothing to reactivate on close. Now we await the
// query BEFORE creating the window so the result is meaningful.
const GET_FRONTMOST_BUNDLE_OSASCRIPT = `tell application "System Events"
  set procs to (processes whose frontmost is true)
  if (count of procs) is 0 then return ""
  return bundle identifier of first item of procs
end tell`;

const YCAL_BUNDLE_ID = 'com.ycal.app';

async function captureFrontmostApp(): Promise<string | null> {
  try {
    const { stdout } = await execFile('osascript', [
      '-e', GET_FRONTMOST_BUNDLE_OSASCRIPT,
    ]);
    const id = stdout.trim();
    if (!id) return null;
    if (id === YCAL_BUNDLE_ID) return null;
    return id;
  } catch {
    return null;
  }
}

// Reactivate the captured previous app so yCal stops being frontmost.
// Awaits the osascript so callers can rely on yCal being deactivated by
// the time this resolves — important because the popup-close handler runs
// this BEFORE tearing the window down (otherwise macOS picks the next yCal
// window in z-order and flashes the main calendar forward).
async function returnFocusToPreviousApp(): Promise<void> {
  const bundleId = quickAddPreviousAppId;
  quickAddPreviousAppId = null;
  if (!bundleId) return;
  try {
    await execFile('osascript', [
      '-e', `tell application id "${bundleId}" to activate`,
    ]);
  } catch { /* best-effort */ }
}

async function openQuickAdd(): Promise<void> {
  // Capture which app was frontmost BEFORE we surface the popup window.
  // This blocks the chord by ~30–100ms while osascript runs, but that's
  // strictly better than racing the window-focus call and getting yCal
  // back as the answer.
  const cameFromOutside = BrowserWindow.getFocusedWindow() == null;
  quickAddPreviousAppId = cameFromOutside ? await captureFrontmostApp() : null;

  // Reuse the persistent popup if it survived from a previous chord. The
  // window-close handler hides instead of destroying, so this path runs
  // every chord after the first — saves the BrowserWindow + Vite-bundle
  // boot cost (~hundreds of ms) that the user would otherwise feel.
  if (quickAddWindow && !quickAddWindow.isDestroyed()) {
    quickAddWindow.webContents.send(IPC.QuickAddReset);
    quickAddWindow.center();
    quickAddWindow.show();
    quickAddWindow.focus();
    return;
  }

  const win = new BrowserWindow({
    width: 560,
    height: 84,
    frame: false,
    resizable: false,
    movable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    backgroundColor: '#00000000',
    transparent: true,
    vibrancy: 'hud',
    visualEffectState: 'active',
    webPreferences: {
      preload: path.join(__dirname_, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.once('ready-to-show', () => {
    win.center();
    win.show();
    win.focus();
  });
  // Spotlight-style: dismiss when focus leaves. The user already activated
  // another app to trigger blur, so yCal is no longer frontmost — hiding
  // here doesn't flash the main window forward and we don't need to run
  // returnFocusToPreviousApp.
  win.on('blur', () => {
    if (!win.isDestroyed() && win.isVisible()) win.hide();
  });
  win.on('closed', () => {
    quickAddWindow = null;
    quickAddPreviousAppId = null;
  });
  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(`${process.env.ELECTRON_RENDERER_URL}?mode=quickadd`);
  } else {
    win.loadFile(path.join(__dirname_, '../renderer/index.html'), {
      search: 'mode=quickadd',
    });
  }
  quickAddWindow = win;
}

function registerIpc() {
  ipcMain.handle(IPC.IsConfigured, () => isConfigured());

  ipcMain.handle(IPC.AddAccount, async () => {
    try {
      const stored = await startAddAccount();
      invalidateCalendarCache();
      invalidateEventsCache();
      refreshTraySoon();
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
    refreshTraySoon();
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
      const { events, failures } = await listEvents(req);
      return { ok: true as const, events, failures };
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
  ipcMain.handle(IPC.TasksAdd, async (_e, input: { title: string; due?: string }) => {
    try {
      const provider = getActiveProvider();
      const created = await provider.addTask(input);
      // Push a "provider data changed" event so the main window refreshes
      // its tasks panel even though the add originated from the quick-add
      // popup (or, in future, the menubar). The cross-device cloud watcher
      // dedupes by content so the originating window doesn't re-process
      // its own write — but in-process we want every open BrowserWindow
      // to know.
      const payload = { providerId: provider.id };
      for (const w of BrowserWindow.getAllWindows()) {
        if (w.isDestroyed()) continue;
        w.webContents.send(IPC.TasksProviderDataChanged, payload);
      }
      return { ok: true as const, id: created.id };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      // The quick-add popup fires this fire-and-forget so the popup can
      // dismiss instantly. That means there's no UI left to surface a
      // failure inline — fall back to a system notification so the user
      // knows their task didn't land.
      if (Notification.isSupported()) {
        new Notification({
          title: 'yCal — task not added',
          body: `“${input.title}” — ${error}`,
        }).show();
      }
      return { ok: false as const, error };
    }
  });
  ipcMain.handle(IPC.WindowClose, async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win || win.isDestroyed()) return;
    // For the quick-add popup specifically: reactivate the previous app
    // BEFORE hiding this window. The popup is alwaysOnTop so it stays
    // visible during the activation; once yCal is no longer frontmost,
    // hiding doesn't pull the main calendar window forward. We hide
    // (rather than close) so the next chord can re-show in <50ms.
    if (win === quickAddWindow) {
      await returnFocusToPreviousApp();
      if (win.isDestroyed()) return;
      win.hide();
      return;
    }
    win.close();
  });
  ipcMain.handle(IPC.WindowResize, (e, height: number) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win || win.isDestroyed()) return;
    const [w] = win.getContentSize();
    const clamped = Math.max(60, Math.min(600, Math.round(height)));
    win.setContentSize(w, clamped, false);
  });
  ipcMain.handle(IPC.TasksAddComment, async (_e, taskId: string, text: string) => {
    try {
      const comment = await getActiveProvider().addComment(taskId, text);
      return { ok: true as const, comment };
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
    }
  });
  ipcMain.handle(IPC.TasksListLabels, async () => {
    try {
      const labels = await getActiveProvider().listLabels();
      return { ok: true as const, labels };
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

  // ── Drive sync (cross-device with iOS) ────────────────────────────
  ipcMain.handle(IPC.DriveSyncGetStatus, () => driveSyncGetStatus());
  ipcMain.handle(IPC.DriveSyncSetEnabled, (_e, enabled: boolean) =>
    driveSyncSetEnabled(!!enabled),
  );
  ipcMain.handle(IPC.DriveSyncSetAccount, (_e, accountId: string | null) =>
    driveSyncSetAccount(accountId ?? null),
  );
  ipcMain.handle(IPC.DriveSyncPushNow, async () => {
    try {
      await driveSyncPushAllNow();
      return { ok: true as const, status: driveSyncGetStatus() };
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
    }
  });
  ipcMain.handle(IPC.DriveSyncPullNow, async () => {
    try {
      await driveSyncPullAllNow();
      return { ok: true as const, status: driveSyncGetStatus() };
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
    startTray(win);

    // Global shortcut for the quick-add popup. registerAll-style: log on
    // failure (another app may already own the chord) but don't block app
    // launch — the user can still add tasks the normal way.
    try {
      const ok = globalShortcut.register(QUICK_ADD_SHORTCUT, () => {
        void openQuickAdd();
      });
      if (!ok) {
        console.error('[yCal] failed to register quick-add shortcut', QUICK_ADD_SHORTCUT);
      }
    } catch (e) {
      console.error('[yCal] quick-add shortcut error', e);
    }
    // Defer cloud-sync work until AFTER the window is on-screen. Two
    // things are deferred together:
    //   1. migrateMissingToCloud — copies userData → iCloud for files
    //      newly added to CLOUD_FILES on upgrade. Touches iCloud paths.
    //   2. startCloudSync — attaches the file watcher.
    // Both involve the iCloud Drive directory. On macOS, an unsigned
    // app launched from Finder doesn't yet hold TCC for iCloud — so a
    // sync read or stat against an iCloud placeholder during boot can
    // hang the event loop before the window paints. Deferring past
    // `ready-to-show` guarantees the user sees a window first; if any
    // I/O does block, it blocks the watcher, not launch.
    win.once('ready-to-show', () => {
      try { migrateMissingToCloud(); } catch (e) {
        console.error('[yCal] cloud migration error', e);
      }
      try { startCloudSync(win); } catch (e) {
        console.error('[yCal] cloud sync setup failed', e);
      }
      try { startDriveSync(win); } catch (e) {
        console.error('[yCal] drive sync setup failed', e);
      }
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    stopTray();
  });
}

// Cross-device sync: watch every cloud-routed file. When iCloud Drive
// delivers an edit from another Mac, the file's mtime changes, the
// watcher reads the new body, and we push the relevant slice to the
// renderer over IPC. cloudStore dedupes by content so our own writes
// don't echo back as fake remote events.
function startCloudSync(win: BrowserWindow): void {
  startCloudWatcher();
  onCloudFileChange((filename, body) => {
    if (win.isDestroyed()) return;
    try {
      switch (filename) {
        case 'settings.json': {
          // iCloud Drive can briefly serve a 0-byte placeholder or a
          // mid-rename partial during sync. Use the strict snapshot so
          // a corrupt re-read inside the handler is treated the same
          // as an unparseable watcher body: skip the broadcast. The
          // next legitimate write triggers a fresh notification.
          if (!isParseableJsonObject(body)) return;
          const snap = getSettingsSnapshotStrict();
          if (!snap) return;
          win.webContents.send(IPC.SettingsChanged, snap);
          break;
        }
        case 'rhythm.json':
          if (!isParseableJsonObject(body)) return;
          win.webContents.send(IPC.RhythmChanged, getRhythm());
          break;
        case 'tasks-schedule.json':
          if (!isParseableJsonObject(body)) return;
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

function isParseableJsonObject(body: string): boolean {
  if (!body) return false;
  try {
    const parsed = JSON.parse(body) as unknown;
    return !!parsed && typeof parsed === 'object';
  } catch {
    return false;
  }
}
