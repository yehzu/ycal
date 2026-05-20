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
import { fileURLToPath } from 'node:url';
import { BrowserWindow, Notification, powerMonitor, shell } from 'electron';
import { IPC, DEFAULT_MERGE_CRITERIA } from '@shared/types';
import type { CalendarEvent, RecentRecording, RecordingStatus, UiSettings } from '@shared/types';
import { dedupEvents } from '@shared/dedup';
import { getUiSettings } from './settings';
import { listAccountSummaries, listAllCalendars, listEvents } from './calendar';
import { setRecordings } from './recorderBus';
import { getUserShellPath } from './userShellPath';
import { getActiveModelPath } from './recorderSetup';
import {
  type MeetSignal, diagnoseDetection, getMeetSignal, onMeetChange,
  startMeetDetector, stopMeetDetector,
} from './meetDetector';

// Re-export for index.ts → IPC plumbing. Keeps meetRecorder.ts as the
// single entry point for "everything recorder" without index needing to
// pull from two separate modules.
export { diagnoseDetection, getMeetSignal } from './meetDetector';

const POLL_MS = 30_000;
const LOOK_BEHIND_MS = 5 * 60_000;
const LOOK_AHEAD_MS = 4 * 60 * 60_000;
const STOP_SLACK_MS = 10 * 60_000;   // safety net beyond event.end
const DONE_RETAIN_MS = 30 * 60_000;  // keep finished statuses visible this long
// Minimum bytes a finished .m4a must have to be worth keeping. A 16-kbps
// AAC-LC moov-only header is ~600 bytes, a 1-second valid clip lands
// around 4-6 KB, and below ~30 KB the recording is empty mic + empty
// system audio (about 3 seconds of silence). Delete sub-threshold files
// on stop instead of running them through whisper.
const MIN_AUDIO_BYTES = 30 * 1024;
// Cooldown in activeMeet mode: don't auto-start a new recording within
// this window of a previous stop. Prevents a flickering Meet detection
// (stale browser tab, brief tab switch, sleep/wake bounce) from
// churning out dozens of short empty files.
const ACTIVE_MEET_COOLDOWN_MS = 3 * 60_000;

const __dirname_ = path.dirname(fileURLToPath(import.meta.url));

const SCRIPT_DIR = path.join(os.homedir(), '.ycal');
const STATE_DIR = path.join(SCRIPT_DIR, 'recordings');
const RECORD_SH = path.join(SCRIPT_DIR, 'record-meet.sh');
const POST_SH = path.join(SCRIPT_DIR, 'post-meet.sh');
const TAP_BIN = path.join(SCRIPT_DIR, 'bin', 'coreaudio-tap');

// Locate a bundled asset across dev + packaged layouts. In dev we sit at
// <repo>/out/main/index.js, so build/<name> is two dirs up. In packaged
// builds electron-builder copies extraResources to <Resources>/<name>.
function resolveBundled(...parts: string[]): string | null {
  const candidates = [
    path.join(process.resourcesPath ?? '', ...parts),
    path.join(__dirname_, '..', '..', 'build', ...parts),
  ];
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

// Resolve a helper-script source path. Production builds ship the
// shell scripts via extraResources at Resources/scripts/<name>. Dev
// runs (`npm run dev`) read them straight from the repo tree at
// tools/recording/<name>. Returns null when neither location has the
// file — that's the only case where ensureHelpersInstalled can't do
// anything for the user.
function scriptSource(name: string): string | null {
  const candidates = [
    path.join(process.resourcesPath ?? '', 'scripts', name),
    path.join(__dirname_, '..', '..', 'tools', 'recording', name),
  ];
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

// Mirror the helper scripts + coreaudio-tap into ~/.ycal/ at app launch
// so the recorder, the standalone CLI smoke test, and a fresh
// auto-update all see consistent files. We only copy when the source
// looks newer than the installed copy (or when the installed copy is
// missing entirely) — keeps user-edited prompts and override scripts
// from being clobbered if they intentionally diverged.
function ensureHelpersInstalled(): void {
  try {
    fs.mkdirSync(path.join(SCRIPT_DIR, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(SCRIPT_DIR, 'recordings'), { recursive: true });
  } catch (e) {
    console.error('[yCal recorder] mkdir failed', e);
  }

  const pairs: Array<[string | null, string, string]> = [
    [resolveBundled('native', 'coreaudio-tap'), TAP_BIN, 'coreaudio-tap'],
    [scriptSource('record-meet.sh'), RECORD_SH, 'record-meet.sh'],
    [scriptSource('post-meet.sh'), POST_SH, 'post-meet.sh'],
  ];
  for (const [src, dst, label] of pairs) {
    if (!src) {
      // The source disappeared somewhere between build and runtime.
      // Most likely cause is a stale install where the user upgraded
      // from a pre-0.6.48 release; their app bundle never had
      // Resources/scripts/. Logging the miss makes that obvious in
      // ~/Library/Logs/yCal/ instead of just leaving the status row
      // ✗ with a misleading "auto-sync on next launch" hint.
      console.error(`[yCal recorder] no source for ${label}; check Resources/ + dev tree`);
      continue;
    }
    try {
      const srcStat = fs.statSync(src);
      let copy = true;
      if (fs.existsSync(dst)) {
        const dstStat = fs.statSync(dst);
        if (dstStat.mtimeMs >= srcStat.mtimeMs && dstStat.size === srcStat.size) {
          copy = false;
        }
      }
      if (copy) {
        fs.copyFileSync(src, dst);
        fs.chmodSync(dst, 0o755);
        console.log(`[yCal recorder] synced ${label}: ${src} → ${dst}`);
      }
    } catch (e) {
      console.error(`[yCal recorder] failed to sync ${label}`, e);
    }
  }
}

const recordings = new Map<string, RecordingStatus>();
const skipped = new Set<string>();
// Events that have crossed event.start while the user has
// "confirmBeforeStart" on. We've shown a notification; the user hasn't
// clicked yet. Keep the event payload so the notification's action
// handler can hand it to startRecording without re-fetching.
const pendingConfirm = new Map<string, { event: CalendarEvent; notifiedAt: number }>();
let pollTimer: NodeJS.Timeout | null = null;
let mainWindowRef: BrowserWindow | null = null;
let detectorUnsub: (() => void) | null = null;
// When the activeMeet detector last stopped a recording. Used to skip
// auto-restart inside ACTIVE_MEET_COOLDOWN_MS. Cleared on manual start.
let lastActiveMeetStopAt = 0;
// Set in startMeetRecorder so we unhook on stopMeetRecorder.
let powerHandlersBound = false;

export function startMeetRecorder(mainWindow: BrowserWindow): void {
  // The whole pipeline assumes macOS — ScreenCaptureKit, avfoundation,
  // and the bundled coreaudio-tap binary are all darwin-only.
  if (process.platform !== 'darwin') return;
  if (pollTimer) return;
  mainWindowRef = mainWindow;
  ensureHelpersInstalled();
  recoverInFlightRecordings();
  pollTimer = setInterval(() => { void tick(); }, POLL_MS);
  // First tick after 2s — gives the window time to paint and the user
  // time to grant mic permission if this is the very first launch.
  setTimeout(() => { void tick(); }, 2_000);

  // Start the window-title detector regardless of the user's current
  // trigger mode. It's cheap when no Meet is open (one osascript call
  // every 20s) and starting it eagerly means switching modes in
  // Settings doesn't require a yCal restart. Recorder reactions to
  // its signal are gated on getUiSettings().recordingTrigger in the
  // handler.
  startMeetDetector();
  detectorUnsub = onMeetChange((s) => {
    void handleMeetSignal(s);
    // Push the latest probe to the renderer so Settings → Recording's
    // "Live detection" widget reflects reality without polling.
    const win = mainWindowRef;
    if (win && !win.isDestroyed()) {
      try { win.webContents.send(IPC.RecorderMeetSignalChanged, s); } catch { /* */ }
    }
  });

  bindPowerHandlers();
}

export function stopMeetRecorder(): void {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  // We deliberately leave in-flight ffmpeg processes alone — the user
  // may be mid-meeting. They'll self-terminate at their `-t` boundary.
  mainWindowRef = null;
  if (detectorUnsub) { detectorUnsub(); detectorUnsub = null; }
  stopMeetDetector();
  if (powerHandlersBound) {
    powerMonitor.removeListener('suspend', onSystemSuspend);
    powerMonitor.removeListener('resume', onSystemResume);
    powerHandlersBound = false;
  }
}

// ── Sleep handling ─────────────────────────────────────────────────────
// When the Mac suspends, our setInterval stops firing but the
// activeMeet detector's lastSeen state and any browser-side stale Meet
// tabs persist. On wake, the detector wakes too and may instantly fire
// inMeet=true against a tab the user isn't actually using — leading
// to "ghost" recordings of empty desktops. Stop everything in flight
// on suspend; the detector's own setInterval pauses with the kernel
// freeze, so we just have to re-arm after resume.

function onSystemSuspend(): void {
  console.log('[yCal recorder] system suspending — stopping in-flight recordings');
  for (const [id, s] of recordings) {
    if (s.state === 'recording') void stopRecording(id);
  }
  // Cancel any pending "start" confirmations the user wasn't around to
  // answer; we'd just re-notify them on wake otherwise.
  pendingConfirm.clear();
}

function onSystemResume(): void {
  console.log('[yCal recorder] system resumed — recorder back online');
  // Give the OS + browser a few seconds to settle before the next
  // probe so we don't read a half-restored window list. The existing
  // poll interval will handle the rest.
  lastActiveMeetStopAt = Date.now();
  setTimeout(() => { void tick(); }, 5_000);
}

function bindPowerHandlers(): void {
  if (powerHandlersBound) return;
  powerMonitor.on('suspend', onSystemSuspend);
  powerMonitor.on('resume', onSystemResume);
  powerHandlersBound = true;
}

export function listRecordings(): RecordingStatus[] {
  return [...recordings.values()];
}

// Scan ~/Recordings/yCal for finished m4a files + their companion
// transcript + summary siblings. We don't open the m4a (avoid metadata
// reads on potentially-many files); stat is enough to surface size +
// modified-at for the UI list.
export function listRecentRecordings(limit = 50): RecentRecording[] {
  const dir = process.env.YCAL_RECORDING_DIR
    || path.join(os.homedir(), 'Recordings', 'yCal');
  let entries: string[];
  try { entries = fs.readdirSync(dir); } catch { return []; }
  const results: RecentRecording[] = [];
  for (const name of entries) {
    if (!name.endsWith('.m4a')) continue;
    const audioFile = path.join(dir, name);
    try {
      const st = fs.statSync(audioFile);
      const base = audioFile.replace(/\.m4a$/, '');
      const baseName = path.basename(audioFile, '.m4a');
      // Filename shape: <stamp>__<safe-title>__<event_id>. Eventid is
      // everything after the FINAL `__` — and crucially we can't use a
      // [^_]+ regex because recurring-event ids include the instance
      // timestamp suffix (e.g. `abc123_20260520T023000Z`), which has
      // its own underscore. Slicing from the last `__` is unambiguous
      // since titles get tr'd to [A-Za-z0-9-] before going in.
      const sep = baseName.lastIndexOf('__');
      const eventId = sep >= 0 ? baseName.slice(sep + 2) : null;
      const transcriptFile = `${base}.transcript.txt`;
      const summaryFile = `${base}.summary.md`;
      results.push({
        audioFile,
        baseName,
        eventId,
        hasTranscript: fs.existsSync(transcriptFile),
        hasSummary: fs.existsSync(summaryFile),
        summaryFile: fs.existsSync(summaryFile) ? summaryFile : null,
        transcriptFile: fs.existsSync(transcriptFile) ? transcriptFile : null,
        modifiedAt: st.mtimeMs,
        sizeBytes: st.size,
      });
    } catch { /* missing/unreadable — skip */ }
  }
  results.sort((a, b) => b.modifiedAt - a.modifiedAt);
  return results.slice(0, limit);
}

export function recordingsDir(): string {
  return process.env.YCAL_RECORDING_DIR
    || path.join(os.homedir(), 'Recordings', 'yCal');
}

// Guard for IPC.RecorderOpenFile: only allow paths that resolve inside
// ~/Recordings/yCal so a compromised renderer can't trick main into
// opening /etc/passwd or similar. Returns the absolute path on success
// or null when the requested path is unsafe.
export function safeRecordingPath(input: string): string | null {
  const dir = recordingsDir();
  const abs = path.resolve(input);
  const dirAbs = path.resolve(dir);
  if (!abs.startsWith(dirAbs + path.sep) && abs !== dirAbs) return null;
  if (!fs.existsSync(abs)) return null;
  return abs;
}

export async function startRecordingManual(event: CalendarEvent): Promise<void> {
  // Allow a manual start to replace a previously-failed entry. Without
  // this, a botched first attempt would block the popover's "Try again"
  // button (and every subsequent manual start) for the next 30 minutes
  // because `recordings.has(event.id)` already returns true for the
  // failed status. The other in-flight states ('recording', 'processing',
  // 'done') are still respected so concurrent starts don't stomp on a
  // healthy recording in progress.
  const existing = recordings.get(event.id);
  if (existing && existing.state !== 'failed') return;
  if (existing && existing.state === 'failed') {
    // Drop the stale failed status BEFORE startRecording inserts a new
    // one — otherwise the renderer would see one tick of "failed" status
    // racing against the new 'recording' status.
    recordings.delete(event.id);
    skipped.delete(event.id);
    pushStatus();
  }
  await startRecording(event);
}

export async function stopRecordingManual(eventId: string): Promise<void> {
  const state = recordings.get(eventId);
  if (!state || state.state !== 'recording') return;
  await stopRecording(eventId);
}

// Re-run post-meet.sh on an existing .m4a — used by the popover's
// "Re-process" button when the user has changed the whisper model or
// summary prompt and wants to regenerate the transcript + note
// without re-recording. We insert a synthetic 'processing' status
// into the recordings map so the popover row reflects progress, then
// let postProcess do its normal work. The eventId comes from the
// filename (popover supplies it) so the popover-side correlation
// still works after the new note lands.
export async function reprocessRecording(
  eventId: string,
  audioFile: string,
  title: string,
): Promise<void> {
  if (!fs.existsSync(audioFile)) {
    throw new Error(`audio file missing: ${audioFile}`);
  }
  const safe = safeRecordingPath(audioFile);
  if (!safe) {
    throw new Error('audio file is not under the recordings dir');
  }
  // Drop any stale status for this event so postProcess's final
  // status.set isn't fighting an older 'done'/'failed' entry. Also
  // clear `skipped` so a later auto-record on the same eventId can
  // still fire — re-processing is an explicit do-over, not a skip.
  skipped.delete(eventId);
  const status: RecordingStatus = {
    eventId,
    title,
    state: 'processing',
    startedAt: Date.now(),
    audioFile: safe,
  };
  recordings.set(eventId, status);
  pushStatus();
  await postProcess(eventId, safe, title);
}

// ── Recovery ────────────────────────────────────────────────────────────
// On startup, scan ~/.ycal/recordings for live ffmpeg processes the
// previous yCal instance launched. The helper script uses nohup so
// ffmpeg gets re-parented to init when yCal quits; the audio file
// keeps growing. We adopt those back so the user can stop them from
// the tray / popover and so postProcess runs when the user explicitly
// stops or the script's -t boundary fires (which we miss because we
// don't have a pid handle anymore — but the file lands on disk and
// the next "Re-process" picks it up).

function recoverInFlightRecordings(): void {
  let entries: string[];
  try { entries = fs.readdirSync(STATE_DIR); } catch { return; }
  for (const name of entries) {
    const m = /^(.+)\.pid$/.exec(name);
    if (!m) continue;
    const eventId = m[1];
    const pidPath = path.join(STATE_DIR, name);
    let pid: number;
    try {
      const raw = fs.readFileSync(pidPath, 'utf8').trim();
      pid = parseInt(raw, 10);
    } catch { continue; }
    if (!Number.isFinite(pid) || pid <= 0) continue;
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch { /* dead */ }
    if (!alive) {
      // Stale pid file. Clean up so the next start for the same id
      // isn't confused by it.
      for (const ext of ['pid', 'tap.pid', 'keep.pid', 'file', 'fifo', 'stdin', 'meta.json']) {
        try { fs.unlinkSync(path.join(STATE_DIR, `${eventId}.${ext}`)); } catch { /* */ }
      }
      continue;
    }
    let audioFile: string | undefined;
    try {
      audioFile = fs.readFileSync(path.join(STATE_DIR, `${eventId}.file`), 'utf8').trim();
    } catch { /* */ }
    let title = 'Recovered recording';
    let startedAt = Date.now();
    let endsAt: number | undefined;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(STATE_DIR, `${eventId}.meta.json`), 'utf8'));
      if (typeof meta.title === 'string' && meta.title.trim()) title = meta.title;
      if (typeof meta.startedAt === 'number') startedAt = meta.startedAt;
      if (typeof meta.endsAt === 'number') endsAt = meta.endsAt;
    } catch { /* meta missing on pre-recovery builds — keep defaults */ }
    if (!endsAt && audioFile) {
      try {
        const st = fs.statSync(audioFile);
        // No event end recorded → assume a 2h ceiling from the file's
        // mtime so the watcher still has a stop boundary.
        startedAt = st.birthtimeMs || st.mtimeMs || startedAt;
      } catch { /* */ }
    }
    const status: RecordingStatus = {
      eventId,
      title,
      state: 'recording',
      startedAt,
      endsAt,
      audioFile,
    };
    recordings.set(eventId, status);
    console.log(`[yCal recorder] adopted in-flight recording ${eventId} (pid ${pid})`);
  }
  if (recordings.size > 0) pushStatus();
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
    // Also drop any pending-confirm entries: the user disabled the
    // feature, so we shouldn't keep "deferred-recording" state for
    // events the recorder no longer cares about.
    pendingConfirm.clear();
    return;
  }
  if (!scriptsInstalled()) return;

  // 'activeMeet' mode: the meetDetector callback is the start/stop
  // signal. The calendar-time logic below would race with it (e.g.
  // start recording at event.start even though the user isn't in Meet
  // yet), so short-circuit and rely on handleMeetSignal exclusively.
  // We still call pruneFinished and update recordings (above) so the
  // UI list ages out cleanly.
  if (ui.recordingTrigger === 'activeMeet') return;

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

  // Clean up pending entries whose event has ended (user ignored the
  // notification, the meeting passed). We treat ignored as "skip".
  for (const [id, p] of pendingConfirm) {
    const end = Date.parse(p.event.end);
    if (Number.isFinite(end) && now >= end) {
      pendingConfirm.delete(id);
      skipped.add(id);
    }
  }

  for (const ev of candidates) {
    if (recordings.has(ev.id)) continue;
    if (skipped.has(ev.id)) continue;
    if (pendingConfirm.has(ev.id)) continue;
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
    if (ui.recordingConfirmBeforeStart) {
      askToStart(ev);
    } else {
      void startRecording(ev);
    }
  }
}

// ── Active Meet trigger ────────────────────────────────────────────────
// Subscribed to meetDetector.onMeetChange. Each transition either starts
// a recording (matching the closest calendar event, or a synthetic one
// when no calendar match exists) or stops the active recording.
//
// Why find a calendar match: lets the recording inherit the meeting
// title for the filename + the eventId for the popover's "Recording"
// row to surface. When the user joins a Meet that isn't on the
// calendar (e.g. someone DMs them a link), we still record but under
// a synthetic event so they aren't surprised by yCal silently doing
// nothing.

async function handleMeetSignal(signal: MeetSignal): Promise<void> {
  const ui = getUiSettings();
  if (!ui.autoRecordMeetings) return;
  if (ui.recordingTrigger !== 'activeMeet') return;
  if (!scriptsInstalled()) return;

  if (signal.inMeet) {
    // Don't start if anything is already actively recording — the
    // detector might fire spuriously when the user toggles tabs.
    for (const s of recordings.values()) {
      if (s.state === 'recording' || s.state === 'processing') return;
    }
    // Cooldown after a stop. A stale Meet tab (or a sleep/wake bounce)
    // can re-trigger the detector seconds after a previous recording
    // ends. Without this gate, we churn out short empty files in a
    // loop. The user can still kick off a recording manually from the
    // popover during the cooldown.
    const sinceStop = Date.now() - lastActiveMeetStopAt;
    if (lastActiveMeetStopAt > 0 && sinceStop < ACTIVE_MEET_COOLDOWN_MS) {
      console.log(`[yCal recorder] in-Meet signal ignored — cooldown ${Math.round(sinceStop / 1000)}s/${ACTIVE_MEET_COOLDOWN_MS / 1000}s`);
      return;
    }
    const event = await pickEventForActiveMeet(ui, signal);
    void startRecording(event);
  } else {
    let stoppedAny = false;
    for (const [id, s] of recordings) {
      if (s.state === 'recording') { void stopRecording(id); stoppedAny = true; }
    }
    if (stoppedAny) lastActiveMeetStopAt = Date.now();
  }
}

async function pickEventForActiveMeet(
  ui: UiSettings,
  signal: MeetSignal,
): Promise<CalendarEvent> {
  // Find a calendar event we can attribute this Meet to. We only count
  // events with meetUrl, RSVP-not-declined, and a [start-15min,
  // end+60min] window containing now. Picks the event with the
  // closest absolute distance from now to ev.start — typically the
  // one the user is "in", even if it's delayed by 10 min or running
  // 20 min over.
  try {
    const candidates = await fetchCandidates(ui);
    const now = Date.now();
    let best: CalendarEvent | null = null;
    let bestDist = Infinity;
    for (const ev of candidates) {
      if (!ev.meetUrl) continue;
      if (ev.rsvp === 'declined') continue;
      if (ev.allDay) continue;
      const start = Date.parse(ev.start);
      const end = Date.parse(ev.end);
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      if (now < start - 15 * 60_000) continue;
      if (now > end + 60 * 60_000) continue;
      const dist = Math.abs(start - now);
      if (dist < bestDist) { best = ev; bestDist = dist; }
    }
    if (best) return best;
  } catch (e) {
    console.error('[yCal recorder] candidate fetch for active Meet failed', e);
  }
  return synthesizeMeetEvent(signal);
}

function synthesizeMeetEvent(signal: MeetSignal): CalendarEvent {
  // Title heuristic: Google Meet uses "Meet - <code>" or "Meet -
  // <topic>" in the tab title. Strip the prefix when present.
  const title = (signal.title ?? '').replace(/^.*Meet\s*-\s*/, '').trim()
    || 'Untitled meeting';
  const now = new Date();
  const end = new Date(now.getTime() + 60 * 60_000);  // 1h cap; safety net catches overruns at +30m
  return {
    id: `meet-${now.toISOString().replace(/[:.]/g, '-')}`,
    accountId: '',
    calendarId: '',
    start: now.toISOString(),
    end: end.toISOString(),
    allDay: false,
    title,
    location: null,
    description: null,
    color: '#888888',
    colorId: null,
    htmlLink: null,
    status: 'confirmed',
    eventType: 'default',
    rsvp: 'accepted',
    meetUrl: '',
  };
}

// "Ask before starting" path: fire an actionable notification at
// event.start. The user clicks Start (or Skip) to decide. Body click
// brings yCal forward so the user can use the popover instead. We
// register the event in pendingConfirm so subsequent polls don't
// re-fire the notification — one shot per event.
function askToStart(event: CalendarEvent): void {
  pendingConfirm.set(event.id, { event, notifiedAt: Date.now() });
  if (!Notification.isSupported()) {
    // No native notifications — fall back to recording anyway, since
    // the user explicitly enabled auto-record but we can't ask them.
    void startRecording(event);
    pendingConfirm.delete(event.id);
    return;
  }
  try {
    const startTime = new Date(event.start).toLocaleTimeString(undefined, {
      hour: 'numeric', minute: '2-digit',
    });
    const n = new Notification({
      title: 'yCal · meeting starting',
      body: `${event.title || 'Meeting'} (started ${startTime}) — record?`,
      // macOS surfaces these as buttons when the user expands the
      // notification (Alert style) or hovers (Banner). Banner-only
      // users still see the body and can click it to focus yCal.
      actions: [
        { type: 'button', text: 'Start' },
        { type: 'button', text: 'Skip' },
      ],
      // Keep silent so it doesn't interrupt the user mid-meeting with
      // a sound. They're already in the meeting; visual is enough.
      silent: true,
    });
    n.on('action', (_e, idx) => {
      if (idx === 0) {
        pendingConfirm.delete(event.id);
        void startRecording(event);
      } else if (idx === 1) {
        pendingConfirm.delete(event.id);
        skipped.add(event.id);
      }
    });
    // Default click (notification body, not an action button) → focus
    // yCal so the user can use the popover's Start button. We don't
    // start recording on body click because that's ambiguous intent.
    n.on('click', () => {
      const w = mainWindowRef;
      if (w && !w.isDestroyed()) { w.show(); w.focus(); }
    });
    n.show();
  } catch (e) {
    console.error('[yCal recorder] notification failed', e);
    // Fall back to recording — better than silently doing nothing.
    pendingConfirm.delete(event.id);
    void startRecording(event);
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
  // Clear cooldown — explicit start (manual or automatic) means this
  // is the recording we want, not a stale-tab echo.
  lastActiveMeetStopAt = 0;
  pushStatus();

  // Persist enough metadata next to the pid files so recoverInFlightRecordings()
  // can rebuild a useful status row after a yCal crash / update / restart.
  try {
    const metaPath = path.join(STATE_DIR, `${ev.id}.meta.json`);
    fs.mkdirSync(path.dirname(metaPath), { recursive: true });
    fs.writeFileSync(metaPath, JSON.stringify({
      title: ev.title,
      startedAt: status.startedAt,
      endsAt,
    }));
  } catch (e) {
    console.error('[yCal recorder] failed to write meta sidecar', e);
  }

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

  // Clear meta sidecar — recovery doesn't need it once the script's
  // stop has unwound the pid files.
  try { fs.unlinkSync(path.join(STATE_DIR, `${eventId}.meta.json`)); } catch { /* */ }

  if (!audioFile || !fs.existsSync(audioFile)) {
    status.state = 'failed';
    status.error = 'recording file missing';
    pushStatus();
    notify('yCal · recording missing', status.title);
    return;
  }

  // Reject obviously-empty recordings before running them through
  // whisper. This protects against the "stale Meet tab kicked the
  // detector while I was at lunch" pattern: the file is ~10KB of
  // silence, transcription would produce empty text and a hallucinated
  // summary. Delete instead of keeping noise around.
  try {
    const st = fs.statSync(audioFile);
    if (st.size < MIN_AUDIO_BYTES) {
      console.log(`[yCal recorder] discarding empty recording (${st.size}B) ${audioFile}`);
      try { fs.unlinkSync(audioFile); } catch { /* */ }
      recordings.delete(eventId);
      pushStatus();
      return;
    }
  } catch { /* stat failed — fall through and let postProcess decide */ }

  void postProcess(eventId, audioFile, status.title);
}

async function postProcess(eventId: string, audioFile: string, title: string): Promise<void> {
  notify('yCal · transcribing', title);
  try {
    // If the user has a custom summary prompt in Settings → Recording,
    // materialise it on disk so post-meet.sh can read it via
    // YCAL_SUMMARY_PROMPT. Empty / unset → script falls back to its
    // built-in heredoc (which mirrors DEFAULT_SUMMARY_PROMPT). One
    // file per call: live next to the audio so the user can inspect
    // what was sent to Claude if a summary looks wrong.
    let promptFile: string | undefined;
    const custom = (getUiSettings().recordingSummaryPrompt ?? '').trim();
    if (custom) {
      promptFile = `${audioFile.replace(/\.m4a$/, '')}.summary.prompt.txt`;
      try {
        fs.writeFileSync(promptFile, custom);
      } catch (e) {
        console.error('[yCal recorder] failed to write prompt file', e);
        promptFile = undefined;
      }
    }
    // Resolve the user's currently-selected whisper model (defaults to
    // large-v3-turbo) and hand it to post-meet.sh via env. The script's
    // YCAL_WHISPER_MODEL fallback to the legacy hard-coded path still
    // works for users mid-upgrade who haven't downloaded the new model
    // yet — they just keep transcribing with whatever's at the old
    // path.
    const modelPath = getActiveModelPath();
    const envExtras: NodeJS.ProcessEnv = {};
    if (promptFile) envExtras.YCAL_SUMMARY_PROMPT = promptFile;
    if (fs.existsSync(modelPath)) envExtras.YCAL_WHISPER_MODEL = modelPath;
    const stdout = await execScript([POST_SH, audioFile, title], {
      timeoutMs: 30 * 60_000,
      envExtras: Object.keys(envExtras).length > 0 ? envExtras : undefined,
    });
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
  const list = listRecordings();
  // In-process bus: lets the tray flip its title without waiting for
  // its own 60s poll. The bus has no listeners during unit tests, so
  // calling it from any code path is safe.
  setRecordings(list);
  const win = mainWindowRef;
  if (!win || win.isDestroyed()) return;
  try {
    win.webContents.send(IPC.RecorderStatusChanged, list);
  } catch { /* best-effort */ }
}

function notify(title: string, body: string): void {
  if (!Notification.isSupported()) return;
  try {
    new Notification({ title, body, silent: true }).show();
  } catch { /* best-effort */ }
}

// Homebrew prefixes. launchd hands Electron a stripped PATH when yCal is
// launched from /Applications, so a `spawn('record-meet.sh')` would not
// find `ffmpeg`/`whisper-cli`/`claude` even though they're "on PATH" in
// the user's interactive shell. We layer these on top of whatever
// process.env.PATH has so the scripts resolve their dependencies the
// same way `which` does in Terminal.
const HOMEBREW_BIN_DIRS = [
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/local/bin',
  '/usr/local/sbin',
];

function execScript(
  argv: string[],
  opts: { timeoutMs?: number; envExtras?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const [cmd, ...args] = argv;
    // Pin YCAL_COREAUDIO_TAP to the bundled binary so the script always
    // uses the version that ships with this yCal release, even if the
    // user has an older copy floating around in ~/.ycal/bin. Callers can
    // tack on more env via opts.envExtras (e.g. a per-call
    // YCAL_SUMMARY_PROMPT pointing at the user's customised prompt).
    const bundledTap = resolveBundled('native', 'coreaudio-tap');
    const env = {
      ...process.env,
      ...(bundledTap ? { YCAL_COREAUDIO_TAP: bundledTap } : {}),
      ...(opts.envExtras ?? {}),
      PATH: [
        ...HOMEBREW_BIN_DIRS,
        process.env.PATH ?? '',
        // User's actual shell PATH (discovered via `zsh -ilc echo $PATH`
        // at startup). Lets the script find `claude` and friends when
        // they're installed somewhere weird like
        // /Applications/cmux.app/Contents/Resources/bin.
        getUserShellPath() ?? '',
      ].filter(Boolean).join(':'),
    };
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
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
