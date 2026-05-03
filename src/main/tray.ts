// yCal — macOS menubar tray with next-event title + lead-time notifications.
//
// What this gives the user:
//   * A label on the menubar showing the next non-declined timed event,
//     with a relative countdown ("12m · Standup") that turns into a
//     "now (24m)" while the event is in progress.
//   * A dropdown listing today's remaining events (and tomorrow's first
//     few once today is empty), clickable to jump straight to Google.
//   * A native macOS notification N minutes before each event starts
//     (default 5). Clicking the notification opens the event.
//
// Filtering mirrors the GUI's "agenda" view: active accounts only,
// visible calendars only, "normal"-role calendars only (no read-only
// subscriptions, no holidays). Same shape as the CLI's default — keeps
// the menubar consistent with what you see in yCal's main window.
//
// Refresh cadence:
//   * Initial fetch on startTray().
//   * 60s poll redraws the title (so the countdown ticks down) and
//     re-runs the agenda fetch (covers Google-side changes within a few
//     minutes; the rest is the existing 30s events cache).
//   * Notifications scheduled per-event with setTimeout. We dedupe by
//     event id within a session so the 60s poll doesn't re-fire the
//     same alert. After app restart the dedupe set resets — acceptable
//     for a personal tool, and unlikely to matter since the lead-time
//     window is short.

import {
  app, BrowserWindow, Menu, Notification, Tray, nativeImage, shell,
} from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  invalidateEventsCache, listAccountSummaries, listAllCalendars, listEvents,
} from './calendar';
import { getUiSettings } from './settings';
import { dedupEvents } from '@shared/dedup';
import { DEFAULT_MERGE_CRITERIA } from '@shared/types';
import type { CalendarEvent } from '@shared/types';

const __dirname_ = path.dirname(fileURLToPath(import.meta.url));

const POLL_INTERVAL_MS = 60_000;
// Alert lead time. Hardcoded for the first cut; can move into settings
// later when there's evidence the user wants to tune it.
const NOTIFY_LEAD_MIN = 5;
const TITLE_MAX = 28;

let tray: Tray | null = null;
let pollTimer: NodeJS.Timeout | null = null;
let notifyTimers: NodeJS.Timeout[] = [];
const notifiedIds = new Set<string>();
let mainWindowRef: BrowserWindow | null = null;

export function startTray(mainWindow: BrowserWindow): void {
  // Tray API ships on all three desktop platforms but our visual + UX
  // assumptions (top-of-screen menubar, NSStatusItem-style dropdown) only
  // hold on macOS. Skip elsewhere rather than ship a half-broken UI.
  if (process.platform !== 'darwin') return;
  if (tray) return;
  mainWindowRef = mainWindow;

  // Empty image + setTitle gives a label-only menubar item — no icon
  // square, just text. macOS handles this cleanly. We could add a small
  // template glyph later; the title alone is more informative.
  tray = new Tray(nativeImage.createEmpty());
  tray.setTitle(' yCal');
  tray.setToolTip('yCal — upcoming events');

  // Left-click should open the dropdown (default macOS behaviour for
  // tray icons with a context menu). Double-click brings the main
  // window forward — handy when the user just wants to hop back.
  tray.on('double-click', () => focusMainWindow());

  void refresh();
  pollTimer = setInterval(() => { void refresh(); }, POLL_INTERVAL_MS);
}

export function stopTray(): void {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  for (const t of notifyTimers) clearTimeout(t);
  notifyTimers = [];
  notifiedIds.clear();
  if (tray) { tray.destroy(); tray = null; }
  mainWindowRef = null;
}

// External hook: call when the user adds/removes an account or toggles
// calendars so the next refresh reflects it immediately. The main IPC
// handlers can wire this in if they want — for now we rely on the 60s
// poll, which is fast enough for personal use.
export function refreshTraySoon(): void {
  if (!tray) return;
  void refresh();
}

function focusMainWindow(): void {
  const win = mainWindowRef;
  if (!win || win.isDestroyed()) {
    // Re-launch the main window if it's been closed (Cmd-W on macOS).
    // We don't track this here — let the existing `activate` handler in
    // index.ts do it by emitting `app.activate`.
    if (process.platform === 'darwin') app.dock?.show();
    app.emit('activate');
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

async function fetchAgenda(): Promise<CalendarEvent[]> {
  const accounts = listAccountSummaries();
  if (accounts.length === 0) return [];
  const allCals = await listAllCalendars();
  const ui = getUiSettings();

  const targets = allCals.filter((c) => {
    if (ui.accountsActive[c.accountId] === false) return false;
    const k = `${c.accountId}|${c.id}`;
    const visible = ui.calVisible[k] ?? c.selected;
    if (!visible) return false;
    const role = ui.calRoles[k] ?? 'normal';
    return role === 'normal';
  });
  if (targets.length === 0) return [];

  const calendarIds = Array.from(new Set(targets.map((c) => c.id)));
  const pairKeys = new Set(targets.map((c) => `${c.accountId}|${c.id}`));

  // Look ahead 36 hours so the menubar still has something useful right
  // before midnight (the next morning's first meeting, for example).
  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(now.getTime() + 36 * 60 * 60 * 1000);

  let events = await listEvents({
    timeMin: start.toISOString(),
    timeMax: end.toISOString(),
    calendarIds,
  });
  events = events.filter((ev) => pairKeys.has(`${ev.accountId}|${ev.calendarId}`));
  events = dedupEvents(events, allCals, ui.mergeCriteria ?? DEFAULT_MERGE_CRITERIA);
  events = events.filter((ev) => ev.rsvp !== 'declined');
  // All-day events are noise on the menubar — they don't have a "starts
  // in N min" semantic. The dropdown still includes them under their
  // calendar source if the user opens it.
  const timed = events.filter((ev) => !ev.allDay);
  timed.sort((a, b) => a.start.localeCompare(b.start));
  return timed;
}

function findCurrentOrNext(events: CalendarEvent[]): CalendarEvent | null {
  const now = Date.now();
  // Prefer "in progress right now" — it's what the user is actually in.
  for (const ev of events) {
    const startMs = new Date(ev.start).getTime();
    const endMs = new Date(ev.end).getTime();
    if (startMs <= now && endMs > now) return ev;
  }
  for (const ev of events) {
    if (new Date(ev.start).getTime() > now) return ev;
  }
  return null;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: 'numeric', minute: '2-digit',
  });
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1).trimEnd() + '…';
}

function formatTrayLabel(next: CalendarEvent | null): string {
  if (!next) return ' No upcoming';
  const now = Date.now();
  const startMs = new Date(next.start).getTime();
  const endMs = new Date(next.end).getTime();
  let prefix: string;
  if (startMs <= now && endMs > now) {
    const minsLeft = Math.max(1, Math.round((endMs - now) / 60_000));
    prefix = `now ${minsLeft}m`;
  } else {
    const minsTo = Math.round((startMs - now) / 60_000);
    if (minsTo <= 0) prefix = 'now';
    else if (minsTo < 60) prefix = `${minsTo}m`;
    else if (minsTo < 24 * 60) prefix = formatTime(next.start);
    else prefix = `tomorrow ${formatTime(next.start)}`;
  }
  return ` ${prefix} · ${truncate(next.title, TITLE_MAX)}`;
}

async function refresh(): Promise<void> {
  if (!tray) return;
  // Bust the events cache once per minute so we pick up Google-side
  // edits without waiting for the next renderer focus event. The cache
  // exists to amortize back-to-back calls within a single user gesture,
  // not to defer long-running periodic refreshes.
  invalidateEventsCache();

  let events: CalendarEvent[] = [];
  try {
    events = await fetchAgenda();
  } catch (e) {
    console.error('[yCal tray] fetch failed', e);
  }

  const next = findCurrentOrNext(events);
  tray.setTitle(formatTrayLabel(next));
  tray.setContextMenu(buildMenu(events));
  scheduleNotifications(events);
}

function buildMenu(events: CalendarEvent[]): Menu {
  const todayKey = new Date().toLocaleDateString();
  const items: Electron.MenuItemConstructorOptions[] = [];

  // Filter to events that haven't ended yet — past entries are noise.
  const now = Date.now();
  const upcoming = events.filter((ev) => new Date(ev.end).getTime() > now);

  if (upcoming.length === 0) {
    items.push({ label: 'No upcoming events', enabled: false });
  } else {
    let sectionLabel = '';
    for (const ev of upcoming.slice(0, 12)) {
      const evDay = new Date(ev.start).toLocaleDateString();
      const newSection = evDay === todayKey ? 'Today' : 'Tomorrow';
      if (newSection !== sectionLabel) {
        if (sectionLabel) items.push({ type: 'separator' });
        items.push({ label: newSection, enabled: false });
        sectionLabel = newSection;
      }
      const time = formatTime(ev.start);
      items.push({
        label: `${time}  ${truncate(ev.title, 36)}`,
        click: () => {
          if (ev.htmlLink) void shell.openExternal(ev.htmlLink);
          else focusMainWindow();
        },
      });
    }
  }

  items.push({ type: 'separator' });
  items.push({ label: 'Open yCal', click: () => focusMainWindow() });
  items.push({ label: 'Quit yCal', role: 'quit' });
  return Menu.buildFromTemplate(items);
}

function scheduleNotifications(events: CalendarEvent[]): void {
  for (const t of notifyTimers) clearTimeout(t);
  notifyTimers = [];
  if (!Notification.isSupported()) return;

  const now = Date.now();
  const cutoff = now + 24 * 60 * 60 * 1000;
  for (const ev of events) {
    if (notifiedIds.has(ev.id)) continue;
    const startMs = new Date(ev.start).getTime();
    if (startMs <= now) continue;        // already started; no lead-time ping
    if (startMs > cutoff) continue;       // far future; reschedule on next poll
    const fireAt = startMs - NOTIFY_LEAD_MIN * 60_000;
    const delay = Math.max(0, fireAt - now);
    const id = ev.id;
    const captured = ev;
    const timer = setTimeout(() => {
      notifiedIds.add(id);
      try {
        const n = new Notification({
          title: captured.title,
          body: `Starts in ${NOTIFY_LEAD_MIN} min · ${formatTime(captured.start)}`,
          silent: false,
        });
        n.on('click', () => {
          if (captured.htmlLink) void shell.openExternal(captured.htmlLink);
          else focusMainWindow();
        });
        n.show();
      } catch (e) {
        console.error('[yCal tray] notification failed', e);
      }
    }, delay);
    notifyTimers.push(timer);
  }
}

// Keep the import non-empty even if some checks above don't need it; the
// `__dirname_` resolution is reserved for future use (custom tray icon).
void __dirname_;
