// MeetRecorder — auto-records calendar events that have a video link.
//
// Once `UiSettings.autoRecordMeetings` is on, every 30s we look ahead a
// few hours, and for events that:
//   * have a meetUrl,
//   * the user hasn't declined,
//   * live in active accounts × visible "normal"-role calendars
//     (same filter the tray + CLI agenda use),
//   * have crossed their start time but not their end time,
// we spawn `~/.ycal/record-meet.sh start`. When the event's end time
// passes (or the user manually stops), we run `stop` and then kick off
// `post-meet.sh` in the background to transcribe + summarise.
//
// Two safety nets on the recording lifetime:
//   1. record-meet.sh receives a `max_seconds` arg (event duration +
//      10min slack). ffmpeg's `-t` self-terminates at that boundary so a
//      crashed yCal can't run the mic indefinitely.
//   2. The ffmpeg child is started inside the helper script via
//      `nohup … &`; the script then exits. The kernel re-parents ffmpeg
//      to init, so quitting yCal mid-meeting does NOT kill the recording.
//
// The renderer + popover talk to this module via:
//   IPC.RecorderList   — array of RecordingStatus, includes recently-done
//   IPC.RecorderStart  — manual start (for off-calendar meetings)
//   IPC.RecorderStop   — manual stop (before scheduled end)
// and push updates on `IPC.RecorderStatusChanged` whenever a recording
// transitions state.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { BrowserWindow, Notification, shell } from 'electron';
import { IPC, DEFAULT_MERGE_CRITERIA } from '@shared/types';
import type { CalendarEvent, RecordingStatus, UiSettings } from '@shared/types';
import { dedupEvents } from '@shared/dedup';
import { getUiSettings } from './settings';
import { listAccountSummaries, listAllCalendars, listEvents } from './calendar';

const POLL_MS = 30_000;
const LOOK_BEHIND_MS = 5 * 60_000;
const LOOK_AHEAD_MS = 4 * 60 * 60_000;
const STOP_SLACK_MS = 10 * 60_000;   // safety net beyond event.end
const DONE_RETAIN_MS = 30 * 60_000;  // keep finished statuses visible this long

const SCRIPT_DIR = path.join(os.homedir(), '.ycal');
const RECORD_SH = path.join(SCRIPT_DIR, 'record-meet.sh');
const POST_SH = path.join(SCRIPT_DIR, 'post-meet.sh');

const recordings = new Map<string, RecordingStatus>();
const skipped = new Set<string>();
let pollTimer: NodeJS.Timeout | null = null;
let mainWindowRef: BrowserWindow | null = null;

export function startMeetRecorder(mainWindow: BrowserWindow): void {
  // Tray + recording only make sense on macOS today — script paths +
  // BlackHole + claude CLI assumptions all break elsewhere.
  if (process.platform !== 'darwin') return;
  if (pollTimer) return;
  mainWindowRef = mainWindow;
  pollTimer = setInterval(() => { void tick(); }, POLL_MS);
  // First tick after 2s — gives the window time to paint and the user
  // time to grant mic permission if this is the very first launch.
  setTimeout(() => { void tick(); }, 2_000);
}

export function stopMeetRecorder(): void {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  // We deliberately leave in-flight ffmpeg processes alone — the user
  // may be mid-meeting. They'll self-terminate at their `-t` boundary.
  mainWindowRef = null;
}

export function listRecordings(): RecordingStatus[] {
  return [...recordings.values()];
}

export async function startRecordingManual(event: CalendarEvent): Promise<void> {
  if (recordings.has(event.id)) return;
  await startRecording(event);
}

export async function stopRecordingManual(eventId: string): Promise<void> {
  const state = recordings.get(eventId);
  if (!state || state.state !== 'recording') return;
  await stopRecording(eventId);
}

// ── Polling loop ────────────────────────────────────────────────────────

async function tick(): Promise<void> {
  pruneFinished();

  const ui = getUiSettings();
  if (!ui.autoRecordMeetings) {
    // Setting may have been toggled off mid-meeting — stop anything
    // that's still recording so we honor the user's intent immediately.
    for (const [id, s] of recordings) {
      if (s.state === 'recording') void stopRecording(id);
    }
    return;
  }
  if (!scriptsInstalled()) return;

  const now = Date.now();

  // Stop recordings whose scheduled end has passed.
  for (const [id, s] of recordings) {
    if (s.state !== 'recording') continue;
    if (s.endsAt != null && now >= s.endsAt) {
      void stopRecording(id);
    }
  }

  const candidates = await fetchCandidates(ui).catch((e) => {
    console.error('[yCal recorder] candidates fetch failed', e);
    return [] as CalendarEvent[];
  });

  for (const ev of candidates) {
    if (recordings.has(ev.id)) continue;
    if (skipped.has(ev.id)) continue;
    if (!ev.meetUrl) continue;
    if (ev.rsvp === 'declined') continue;
    if (ev.allDay) continue;
    const start = Date.parse(ev.start);
    const end = Date.parse(ev.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (now < start) continue;       // not yet
    if (now >= end) { skipped.add(ev.id); continue; }   // already over
    // Skip events with bizarre durations (>4h) to avoid burning disk on
    // an all-day office-hours block that happens to have a meetUrl.
    if (end - start > 4 * 60 * 60_000) continue;
    void startRecording(ev);
  }
}

async function fetchCandidates(ui: UiSettings): Promise<CalendarEvent[]> {
  const accounts = listAccountSummaries();
  if (accounts.length === 0) return [];
  const allCals = await listAllCalendars();
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

  const now = Date.now();
  const { events } = await listEvents({
    timeMin: new Date(now - LOOK_BEHIND_MS).toISOString(),
    timeMax: new Date(now + LOOK_AHEAD_MS).toISOString(),
    calendarIds,
  });
  let filtered = events.filter((ev) => pairKeys.has(`${ev.accountId}|${ev.calendarId}`));
  filtered = dedupEvents(filtered, allCals, ui.mergeCriteria ?? DEFAULT_MERGE_CRITERIA);
  return filtered;
}

// ── Start / stop / post-process ─────────────────────────────────────────

async function startRecording(ev: CalendarEvent): Promise<void> {
  const endsAt = Date.parse(ev.end);
  const maxSecs = Math.ceil((endsAt - Date.now() + STOP_SLACK_MS) / 1000);

  const status: RecordingStatus = {
    eventId: ev.id,
    title: ev.title,
    state: 'recording',
    startedAt: Date.now(),
    endsAt,
  };
  recordings.set(ev.id, status);
  pushStatus();

  try {
    const stdout = await execScript([RECORD_SH, 'start', ev.id, ev.title, String(maxSecs)]);
    status.audioFile = stdout.trim() || undefined;
    pushStatus();
    notify('yCal · recording', ev.title || 'Meeting');
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('[yCal recorder] start failed', message);
    status.state = 'failed';
    status.error = message;
    pushStatus();
    notify('yCal · recording failed to start', message.slice(0, 140));
    skipped.add(ev.id);
  }
}

async function stopRecording(eventId: string): Promise<void> {
  const status = recordings.get(eventId);
  if (!status) return;
  // Move out of 'recording' immediately so concurrent ticks don't try
  // to start/stop again.
  status.state = 'processing';
  pushStatus();
  skipped.add(eventId);

  let audioFile = status.audioFile;
  try {
    const stdout = await execScript([RECORD_SH, 'stop', eventId]);
    if (!audioFile && stdout.trim()) audioFile = stdout.trim();
    status.audioFile = audioFile;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('[yCal recorder] stop failed', message);
    // The ffmpeg trailer might still be on disk even if `stop` returned
    // an error (it logs to stderr while the file is fine). Try to
    // continue with post-processing if we have a file path.
  }

  if (!audioFile || !fs.existsSync(audioFile)) {
    status.state = 'failed';
    status.error = 'recording file missing';
    pushStatus();
    notify('yCal · recording missing', status.title);
    return;
  }
  void postProcess(eventId, audioFile, status.title);
}

async function postProcess(eventId: string, audioFile: string, title: string): Promise<void> {
  notify('yCal · transcribing', title);
  try {
    const stdout = await execScript([POST_SH, audioFile, title], { timeoutMs: 30 * 60_000 });
    const summary = stdout.trim() || audioFile.replace(/\.m4a$/, '.summary.md');
    const status = recordings.get(eventId);
    if (status) {
      status.state = 'done';
      status.summaryFile = summary;
      pushStatus();
    }
    const n = new Notification({
      title: 'yCal · meeting notes ready',
      body: title,
    });
    n.on('click', () => {
      void shell.openPath(fs.existsSync(summary) ? summary : audioFile);
    });
    n.show();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('[yCal recorder] post-process failed', message);
    const status = recordings.get(eventId);
    if (status) {
      status.state = 'failed';
      status.error = message;
      pushStatus();
    }
    notify('yCal · transcription failed', message.slice(0, 140));
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

function scriptsInstalled(): boolean {
  return fs.existsSync(RECORD_SH) && fs.existsSync(POST_SH);
}

function pruneFinished(): void {
  const cutoff = Date.now() - DONE_RETAIN_MS;
  let changed = false;
  for (const [id, s] of recordings) {
    if (s.state !== 'done' && s.state !== 'failed') continue;
    if (s.startedAt < cutoff) {
      recordings.delete(id);
      changed = true;
    }
  }
  if (changed) pushStatus();
}

function pushStatus(): void {
  const win = mainWindowRef;
  if (!win || win.isDestroyed()) return;
  try {
    win.webContents.send(IPC.RecorderStatusChanged, listRecordings());
  } catch { /* best-effort */ }
}

function notify(title: string, body: string): void {
  if (!Notification.isSupported()) return;
  try {
    new Notification({ title, body, silent: true }).show();
  } catch { /* best-effort */ }
}

function execScript(
  argv: string[],
  opts: { timeoutMs?: number } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const [cmd, ...args] = argv;
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    let timedOut = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => { timedOut = true; proc.kill('SIGTERM'); }, opts.timeoutMs)
      : null;
    proc.on('error', (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
    proc.on('exit', (code) => {
      if (timer) clearTimeout(timer);
      if (timedOut) return reject(new Error('script timed out'));
      if (code === 0) return resolve(stdout);
      reject(new Error(stderr.trim() || `exit ${code}`));
    });
  });
}
