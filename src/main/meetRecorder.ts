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
import { app, BrowserWindow, Notification, powerMonitor, powerSaveBlocker, shell } from 'electron';
import { IPC, DEFAULT_MERGE_CRITERIA } from '@shared/types';
import type { CalendarEvent, RecentRecording, RecordingStatus, UiSettings } from '@shared/types';
import { dedupEvents } from '@shared/dedup';
import { getUiSettings } from './settings';
import { getCaptureMic, getCaptureVoiceProcessing } from './device';
import { listAccountSummaries, listAllCalendars, listEvents } from './calendar';
import { setRecordings } from './recorderBus';
import { getUserShellPath } from './userShellPath';
import { getActiveModelPath, getDiarizeVenvPython, isDiarizeVenvReady } from './recorderSetup';
import { uploadMeetingArtifacts, uploadMeetingNoteSidecar } from './meetingArchive';
import { listAccounts } from './tokenStore';
import {
  applyGlossaryToSummaryPrompt, buildRuntimeFiles, getEffectiveEntries,
} from './glossary';
import { lookupPerson, loadPeopleText, parsePeople } from './peopleStore';
import { DEFAULT_SUMMARY_PROMPT } from '@shared/recorderPrompt';
import {
  type MeetSignal, diagnoseDetection, extractMeetCode, getMeetSignal,
  onMeetChange, probeMeetCodeOpen, startMeetDetector, stopMeetDetector,
} from './meetDetector';
import { rlog, rtrace } from './recorderLog';

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
// Overrun extension in activeMeet mode: when a recording's endsAt is
// reached but the meet room is still open in a browser tab, roll
// endsAt forward by this much and keep recording. Capped by
// OVERRUN_MAX_MS so a forgotten tab can't run forever.
const OVERRUN_EXTEND_MS = 15 * 60_000;
const OVERRUN_MAX_MS = 60 * 60_000;

const __dirname_ = path.dirname(fileURLToPath(import.meta.url));

const SCRIPT_DIR = path.join(os.homedir(), '.ycal');
const STATE_DIR = path.join(SCRIPT_DIR, 'recordings');
const RECORD_SH = path.join(SCRIPT_DIR, 'record-meet.sh');
const POST_SH = path.join(SCRIPT_DIR, 'post-meet.sh');
const DIARIZE_PY = path.join(SCRIPT_DIR, 'diarize.py');
const TAP_BIN = path.join(SCRIPT_DIR, 'bin', 'coreaudio-tap');
const VPIO_BIN = path.join(SCRIPT_DIR, 'bin', 'voiceproc-mic');

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
    [resolveBundled('native', 'voiceproc-mic'), VPIO_BIN, 'voiceproc-mic'],
    [scriptSource('record-meet.sh'), RECORD_SH, 'record-meet.sh'],
    [scriptSource('post-meet.sh'), POST_SH, 'post-meet.sh'],
    [scriptSource('diarize.py'), DIARIZE_PY, 'diarize.py'],
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

// Per-recording scratch lives in STATE_DIR. record-meet.sh deletes the
// live runtime files (.pid/.fifo/.stdin/.meta.json/.file) on stop, but the
// diagnostic logs (.ffmpeg.log/.tap.log/.vpio.log/.tap-exhausted) are
// deliberately KEPT — they're the forensic trail when a recording comes
// back silent / cut / garbled, which you only notice AFTER it finishes
// (so deleting on stop would destroy the evidence at the worst moment).
// They're only useful while recent, so prune anything older than this at
// startup. Active recordings' files are freshly written, so an age cutoff
// never touches an in-flight capture. (Recorded .m4a audio lives in
// ~/Recordings/yCal, NOT here, so this never deletes a recording.)
const RECORDER_STATE_RETAIN_DAYS = 14;

function pruneRecorderState(): void {
  let entries: string[];
  try { entries = fs.readdirSync(STATE_DIR); } catch { return; }
  const cutoff = Date.now() - RECORDER_STATE_RETAIN_DAYS * 24 * 60 * 60_000;
  let pruned = 0;
  for (const name of entries) {
    const p = path.join(STATE_DIR, name);
    try {
      const st = fs.statSync(p);
      if (!st.isFile() || st.mtimeMs >= cutoff) continue;
      fs.unlinkSync(p);
      pruned += 1;
    } catch { /* missing/unreadable — skip */ }
  }
  if (pruned > 0) {
    console.log(`[yCal recorder] pruned ${pruned} stale state files (>${RECORDER_STATE_RETAIN_DAYS}d) from ${STATE_DIR}`);
  }
}

const recordings = new Map<string, RecordingStatus>();
const skipped = new Set<string>();
// Meet room codes whose last start attempt failed. Used to break the
// active-Meet retry loop when record-meet.sh keeps failing on the same
// room (missing helper script, denied mic permission, broken tap, etc.).
// Each detector tick generates a brand-new synthetic eventId
// (`meet-<timestamp>`) so the per-eventId `skipped` set can't block
// retries. Keyed by meet code instead so the same room is rejected
// regardless of how many synthetic events get generated. Cleared on the
// `inMeet=false` transition (user actually left) and on manual start
// (explicit do-over).
const failedMeetCodes = new Set<string>();
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

// macOS aggressively suspends background apps in Low Power Mode and
// during display sleep, which causes coreaudio-tap to feed zero-sample
// callbacks and avfoundation's mic stream to deliver buffers of
// silence — neither path returns an error, so ffmpeg keeps "recording"
// what is in effect a silent stream. powerSaveBlocker tells macOS to
// keep the app schedulable while a recording is in flight; we refcount
// it so concurrent recordings (rare but possible) only release the
// hold once all are stopped. 'prevent-app-suspension' is enough — we
// don't need to block display sleep, just App Nap / low-power throttling.
let powerSaveBlockerId: number | null = null;
let powerSaveRefcount = 0;
function acquirePowerSaveBlocker(): void {
  powerSaveRefcount += 1;
  if (powerSaveBlockerId !== null) return;
  try {
    powerSaveBlockerId = powerSaveBlocker.start('prevent-app-suspension');
    rlog(`powerSaveBlocker.start → id=${powerSaveBlockerId} (Low Power Mode mitigation)`);
  } catch (e) {
    console.error('[yCal recorder] powerSaveBlocker.start failed', e);
    powerSaveBlockerId = null;
  }
}
function releasePowerSaveBlocker(): void {
  powerSaveRefcount = Math.max(0, powerSaveRefcount - 1);
  if (powerSaveRefcount > 0) return;
  if (powerSaveBlockerId === null) return;
  try { powerSaveBlocker.stop(powerSaveBlockerId); } catch { /* */ }
  rlog(`powerSaveBlocker.stop → id=${powerSaveBlockerId}`);
  powerSaveBlockerId = null;
}

// Per-recording health monitor state. We poll fs.stat on the in-flight
// m4a every HEALTH_TICK_MS and compute bytes/sec over the rolling
// HEALTH_WINDOW_MS window. AAC at 192 kbps with actual speech lands
// around 24 kB/s; near-pure silence drops to ~700 B/s (verified against
// the 2026-05-26 Builder Leveling case: 1.8MB / 44min ≈ 720 B/s). If
// the rolling rate stays below SILENT_BPS_THRESHOLD across the full
// window, the recording is almost certainly capturing silence —
// surface a warning state to the popover so the user can intervene
// instead of discovering it post-meeting.
const HEALTH_TICK_MS = 15_000;
const HEALTH_WINDOW_MS = 60_000;
const SILENT_BPS_THRESHOLD = 1500;
const healthTimers = new Map<string, NodeJS.Timeout>();
const healthSamples = new Map<string, Array<{ atMs: number; size: number }>>();

export function startMeetRecorder(mainWindow: BrowserWindow): void {
  // The whole pipeline assumes macOS — ScreenCaptureKit, avfoundation,
  // and the bundled coreaudio-tap binary are all darwin-only.
  if (process.platform !== 'darwin') return;
  if (pollTimer) return;
  mainWindowRef = mainWindow;
  ensureHelpersInstalled();
  void refreshAudioInputDevices(true);   // warm the menubar Capture list
  recoverInFlightRecordings();
  pruneRecorderState();                  // clear stale per-recording logs (>14d)
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
  rlog('onSystemSuspend — stopping in-flight recordings');
  for (const [id, s] of recordings) {
    if (s.state === 'recording') void stopRecording(id, 'system-suspend');
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

// ── Audio input devices (for the menubar Capture menu) ──────────────────
// Cheap-ish to enumerate (ffmpeg avfoundation list ~200-500ms), so we
// cache the names and refresh on a TTL. The tray reads the cache
// synchronously when building its menu and kicks an async refresh when
// stale; warmed once at recorder startup so the first menu open is populated.
const AUDIO_DEV_TTL_MS = 60_000;
let audioDevCache: string[] = [];
let audioDevCacheAt = 0;

export function getAudioInputDevices(): string[] {
  return audioDevCache;
}

export async function refreshAudioInputDevices(force = false): Promise<string[]> {
  if (!force && audioDevCache.length > 0 && Date.now() - audioDevCacheAt < AUDIO_DEV_TTL_MS) {
    return audioDevCache;
  }
  if (!scriptsInstalled()) return audioDevCache;
  try {
    const out = await execScript([RECORD_SH, 'list-devices']);
    // Lines look like: `[AVFoundation indev @ 0x..] [0] Yeti Nano`.
    // Pull the name after the trailing `[N] ` token; dedupe (devices like
    // the Yeti register twice) while preserving enumeration order.
    const seen = new Set<string>();
    const names: string[] = [];
    for (const line of out.split('\n')) {
      const m = line.match(/\[\d+\]\s+(.+?)\s*$/);
      if (!m) continue;
      const name = m[1].trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      names.push(name);
    }
    audioDevCache = names;
    audioDevCacheAt = Date.now();
  } catch (e) {
    console.error('[yCal recorder] list-devices failed', e);
  }
  return audioDevCache;
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
  const abs = path.resolve(input);
  if (!fs.existsSync(abs)) return null;
  // Local recordings live in ~/Recordings/yCal. Drive-fetched
  // artifacts live in <userData>/meeting-cache. Allow both so the
  // popover can `recorderOpenFile` either one through the same IPC.
  const allowed = [
    path.resolve(recordingsDir()),
    path.resolve(app.getPath('userData'), 'meeting-cache'),
  ];
  for (const dir of allowed) {
    if (abs === dir) return abs;
    if (abs.startsWith(dir + path.sep)) return abs;
  }
  return null;
}

// Best-effort recovery of a recording's original wall-clock start. Used
// by reprocess + resummarize so re-running the pipeline doesn't rewrite
// the cached meta.json's startedAt to "now" (which loses the real
// meeting timestamp for any list/sort/UI that reads it later). Fallback
// chain: in-memory status → cache meta.json (most reliable post-upload)
// → audio filename prefix `2026-05-26_1705_…` → audio mtime → now.
function resolveOriginalStartedAt(eventId: string, audioFile: string): number {
  const existing = recordings.get(eventId);
  if (existing?.startedAt && Number.isFinite(existing.startedAt)) return existing.startedAt;
  try {
    const cacheRoot = path.join(app.getPath('userData'), 'meeting-cache');
    const safe = eventId.replace(/[^A-Za-z0-9._@-]+/g, '-').slice(0, 200) || 'unknown';
    const metaPath = path.join(cacheRoot, safe, 'meta.json');
    if (fs.existsSync(metaPath)) {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as { startedAt?: number };
      if (typeof meta.startedAt === 'number' && Number.isFinite(meta.startedAt)) {
        return meta.startedAt;
      }
    }
  } catch { /* fall through */ }
  // Filename shape from record-meet.sh: `<YYYY-MM-DD>_<HHMM>__<title>__<eventId>.m4a`.
  // Local time (whatever zone the user was in when the recording was made).
  const base = path.basename(audioFile);
  const m = base.match(/^(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})__/);
  if (m) {
    const [, y, mo, d, hh, mm] = m;
    const dt = new Date(Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mm));
    if (!Number.isNaN(dt.getTime())) return dt.getTime();
  }
  try { return fs.statSync(audioFile).mtimeMs; } catch { /* */ }
  return Date.now();
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
  // Manual start is an explicit do-over — clear the per-room block so
  // the active-Meet detector can retry this room before the user leaves.
  const manualCode = extractMeetCode(event.meetUrl);
  if (manualCode) failedMeetCodes.delete(manualCode);
  await startRecording(event);
}

export async function stopRecordingManual(eventId: string): Promise<void> {
  const state = recordings.get(eventId);
  if (!state || state.state !== 'recording') return;
  await stopRecording(eventId, 'manual-ipc');
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
  accountId?: string,
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
    // Preserve original recording time across re-process — otherwise the
    // re-uploaded meta.json would carry Date.now() and the popover /
    // listings would show "started at 18:23" for a meeting that actually
    // ran 17:05-17:49. Falls back through cache meta → filename → mtime.
    startedAt: resolveOriginalStartedAt(eventId, safe),
    audioFile: safe,
    accountId,
  };
  recordings.set(eventId, status);
  pushStatus();
  await postProcess(eventId, safe, title, accountId);
}

// Re-run ONLY the claude summarization step against the existing
// transcript.txt next to the audio. Skips whisper entirely — useful when
// the transcript is fine but the user wants a fresh note against a
// different prompt or an updated glossary. Fails if the transcript is
// missing (the user should re-process instead in that case).
export async function resummarizeRecording(
  eventId: string,
  audioFile: string,
  title: string,
  accountId?: string,
): Promise<void> {
  if (!fs.existsSync(audioFile)) {
    throw new Error(`audio file missing: ${audioFile}`);
  }
  const safe = safeRecordingPath(audioFile);
  if (!safe) {
    throw new Error('audio file is not under the recordings dir');
  }
  const transcript = safe.replace(/\.m4a$/, '.transcript.txt');
  if (!fs.existsSync(transcript)) {
    throw new Error('no transcript on disk — use Re-process instead');
  }
  skipped.delete(eventId);
  const status: RecordingStatus = {
    eventId,
    title,
    state: 'processing',
    // Same rationale as reprocessRecording — preserve original timing.
    startedAt: resolveOriginalStartedAt(eventId, safe),
    audioFile: safe,
    accountId,
  };
  recordings.set(eventId, status);
  pushStatus();
  await postProcess(eventId, safe, title, accountId, true);
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
      for (const ext of ['pid', 'tap.pid', 'keep.pid', 'vpio.pid', 'file', 'fifo', 'stdin', 'mic.fifo', 'meta.json']) {
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
    let accountId: string | undefined;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(STATE_DIR, `${eventId}.meta.json`), 'utf8'));
      if (typeof meta.title === 'string' && meta.title.trim()) title = meta.title;
      if (typeof meta.startedAt === 'number') startedAt = meta.startedAt;
      if (typeof meta.endsAt === 'number') endsAt = meta.endsAt;
      if (typeof meta.accountId === 'string' && meta.accountId.trim()) {
        accountId = meta.accountId;
      }
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
      accountId,
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
      if (s.state === 'recording') void stopRecording(id, 'autoRecord-toggled-off');
    }
    // Also drop any pending-confirm entries: the user disabled the
    // feature, so we shouldn't keep "deferred-recording" state for
    // events the recorder no longer cares about.
    pendingConfirm.clear();
    return;
  }
  if (!scriptsInstalled()) return;

  const now = Date.now();

  // Stop recordings whose scheduled end has passed. Calendar mode stops
  // immediately — that's the contract: the calendar event ended, the
  // recording ends with it. ActiveMeet mode is gentler: if the meet
  // room is still open in a browser tab, the meeting is overrunning —
  // roll endsAt forward by OVERRUN_EXTEND_MS and keep recording, up to
  // OVERRUN_MAX_MS past the original end so a forgotten tab can't run
  // the mic forever.
  for (const [id, s] of recordings) {
    if (s.state !== 'recording') continue;
    if (s.endsAt == null || now < s.endsAt) continue;

    if (ui.recordingTrigger === 'activeMeet' && s.meetCode) {
      const original = s.originalEndsAt ?? s.endsAt;
      const totalExtension = s.endsAt - original;
      if (totalExtension < OVERRUN_MAX_MS) {
        const stillOpen = await probeMeetCodeOpen(s.meetCode);
        if (stillOpen === true) {
          if (s.originalEndsAt == null) s.originalEndsAt = original;
          s.endsAt = s.endsAt + OVERRUN_EXTEND_MS;
          console.log(
            `[yCal recorder] meeting ${id} overrunning — extending +${OVERRUN_EXTEND_MS / 60_000}min (total +${(s.endsAt - original) / 60_000}min / cap ${OVERRUN_MAX_MS / 60_000}min)`,
          );
          pushStatus();
          continue;
        }
        // stillOpen === false: confirmed gone → stop. null (inconclusive):
        // fall through to stop too, since endsAt was hit and we can't
        // verify the call is still happening.
      } else {
        console.log(`[yCal recorder] meeting ${id} hit overrun cap (+${OVERRUN_MAX_MS / 60_000}min) — stopping`);
      }
    }
    void stopRecording(id, 'tick-endsAt-reached');
  }

  // 'activeMeet' mode: the meetDetector callback owns START decisions.
  // The remaining calendar-time logic below schedules new recordings
  // from upcoming events, which would race with the detector (e.g.
  // start recording at event.start even though the user isn't in Meet
  // yet) — short-circuit and rely on handleMeetSignal exclusively for
  // start. End-time auto-stop already ran above.
  if (ui.recordingTrigger === 'activeMeet') return;

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
    // Per-room block. If the previous attempt at THIS exact room failed
    // (script broken, mic permission denied, etc.), don't keep spamming
    // start attempts every 10s — wait until the user leaves and rejoins
    // (the inMeet=false transition clears failedMeetCodes).
    const signalCode = extractMeetCode(signal.title) ?? undefined;
    if (signalCode && failedMeetCodes.has(signalCode)) {
      console.log(`[yCal recorder] in-Meet signal ignored — ${signalCode} previously failed; leave + rejoin to retry`);
      return;
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
    // Tab-closed signal. The global probe lost the Meet — but that could
    // be a brief glitch (osascript timeout in a busy multi-tab browser,
    // hidden window state, etc.) rather than the user actually leaving.
    //
    // Two-tier check before stopping:
    //   1. If we know the recording's meet room code (extracted from the
    //      calendar event's meetUrl), do a *targeted* probe for that
    //      specific URL in any browser tab. If found → keep recording
    //      (user is still in this meeting, the global probe just missed
    //      it). If confidently gone → stop (user really left). If the
    //      targeted probe is inconclusive (timeout / browser not
    //      reachable) → fall through to step 2.
    //   2. If the calendar event is still in its scheduled window
    //      (real event with accountId + endsAt > now), keep recording
    //      and let tick() land the stop at the real end. Otherwise stop.
    //
    // Synthetic active-Meet events have no meetCode and no accountId,
    // so they stop on the tab-closed signal — same as before.
    const now = Date.now();
    let stoppedAny = false;
    for (const [id, s] of recordings) {
      if (s.state !== 'recording') continue;

      if (s.meetCode) {
        const stillOpen = await probeMeetCodeOpen(s.meetCode);
        if (stillOpen === true) {
          console.log(`[yCal recorder] inMeet=false ignored for ${id} — meet code ${s.meetCode} still open in browser`);
          continue;
        }
        if (stillOpen === false) {
          console.log(`[yCal recorder] meet code ${s.meetCode} confirmed gone — stopping ${id}`);
          void stopRecording(id, 'inMeet-false-targetedProbe-confirmed-gone');
          stoppedAny = true;
          continue;
        }
        // null: probe inconclusive (timeout / browser unreachable).
        // Fall through to the calendar-window fallback.
      }

      const calendarStillInWindow =
        s.accountId && s.endsAt != null && now < s.endsAt;
      if (calendarStillInWindow) {
        console.log(`[yCal recorder] inMeet=false ignored for ${id} — calendar event still active (ends in ${Math.round((s.endsAt! - now) / 1000)}s)`);
        continue;
      }
      void stopRecording(id, 'inMeet-false-no-calendar-window');
      stoppedAny = true;
    }
    if (stoppedAny) lastActiveMeetStopAt = Date.now();
    // User actually left (the detector's 90s off-debounce already
    // confirmed it). Forget any room-codes we'd blocked from earlier
    // failed starts so the next rejoin gets a fresh try.
    if (failedMeetCodes.size > 0) failedMeetCodes.clear();
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
  // <topic>" in the tab title. Strip the prefix when present. When the
  // signal carries a raw URL (the detector's `chrome:`/`arc:` path
  // captures the URL string itself), fall back to the meet code so the
  // tray/popover row shows "abc-defg-hij" instead of a 60-char URL.
  const rawTitle = (signal.title ?? '').trim();
  const code = extractMeetCode(rawTitle);
  let title = rawTitle.replace(/^.*Meet\s*-\s*/, '').trim();
  if (!title || /meet\.google\.com/i.test(title)) {
    title = code ?? 'Untitled meeting';
  }
  const meetUrl = code ? `https://meet.google.com/${code}` : '';
  const now = new Date();
  const end = new Date(now.getTime() + 60 * 60_000);  // 1h cap; overrun extension rolls this forward when the room is still open
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
    meetUrl,
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

// Drop a <audio>.context.json sidecar next to the m4a so post-meet.sh can
// inject attendee + organizer info into the summary prompt. "Me" comes
// from the recording account's profile — that lets Claude attribute the
// stereo transcript's [Me] segments to a real name rather than a generic
// "the user". Resources and declined attendees are filtered out; the
// description is included so Claude has any pre-meeting agenda the
// invite carried.
function writeRecordingContext(
  audioFile: string,
  ev: CalendarEvent,
  startedAt: number,
  endsAt: number,
): void {
  const contextPath = audioFile.replace(/\.m4a$/, '.context.json');
  const me = ev.accountId
    ? listAccountSummaries().find((a) => a.id === ev.accountId)
    : null;
  // Enrich each attendee with the title from the people directory
  // (people.md, cloudStore-routed). The directory may also override
  // the display name when Google's invite carries only an email.
  const directory = parsePeople(loadPeopleText());
  const attendees = (ev.attendees ?? [])
    .filter((a) => !a.resource && a.rsvp !== 'declined')
    .map((a) => {
      const known = lookupPerson(a.email);
      return {
        name: known?.name ?? a.name,
        email: a.email,
        title: known?.title ?? null,
        organizer: a.organizer,
        optional: a.optional,
        rsvp: a.rsvp,
      };
    });
  // Send the rest of the people directory too — names of folks who aren't
  // at this meeting but who the user knows. Used by the summary prompt
  // to distinguish "legitimate delegation to absent person" from
  // "Whisper hallucinated a name that doesn't exist" when LLM picks
  // owners for action items.
  const attendeeEmails = new Set(
    attendees.map((a) => (a.email ?? '').toLowerCase()).filter(Boolean),
  );
  const knownPeople = Array.from(directory.values())
    .filter((p) => p.name && !attendeeEmails.has(p.email))
    .map((p) => ({ name: p.name, email: p.email, title: p.title }));
  const isoOrNull = (ms: number): string | null => {
    if (!Number.isFinite(ms)) return null;
    try { return new Date(ms).toISOString(); } catch { return null; }
  };
  const body = {
    title: ev.title,
    startedAt: isoOrNull(startedAt),
    endsAt: isoOrNull(endsAt),
    me: me ? { email: me.email, name: me.name } : null,
    attendees,
    knownPeople,
    location: ev.location,
    description: ev.description,
  };
  fs.writeFileSync(contextPath, JSON.stringify(body, null, 2));
}

async function startRecording(ev: CalendarEvent): Promise<void> {
  const endsAt = Date.parse(ev.end);
  // Active-Meet detection can hand us an event that's already 30+ min past
  // its scheduled end (the user left the Meet tab open). Without clamping,
  // the script's `-t <negative>` lands in ffmpeg's atrim filter and
  // silently produces a 0-byte file — which stopRecording then auto-
  // deletes, leaving no trace for the user. Clamp to 30 min runway so the
  // recording can still run for someone who's actively in the call past
  // the scheduled end.
  const remainingMs = Number.isFinite(endsAt) ? endsAt - Date.now() : 0;
  const MIN_RUNWAY_SECS = 30 * 60;
  const maxSecs = Math.max(
    Math.ceil((remainingMs + STOP_SLACK_MS) / 1000),
    MIN_RUNWAY_SECS,
  );

  const meetCode = extractMeetCode(ev.meetUrl) ?? undefined;
  const status: RecordingStatus = {
    eventId: ev.id,
    title: ev.title,
    state: 'recording',
    startedAt: Date.now(),
    endsAt,
    originalEndsAt: Number.isFinite(endsAt) ? endsAt : undefined,
    accountId: ev.accountId || undefined,
    meetCode,
  };
  recordings.set(ev.id, status);
  rlog(`startRecording(${ev.id}) title="${ev.title}" endsAt=${Number.isFinite(endsAt) ? new Date(endsAt).toISOString() : 'null'} maxSecs=${maxSecs} meetCode=${meetCode ?? 'none'} accountId=${ev.accountId || 'none'}`);
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
      accountId: ev.accountId || null,
    }));
  } catch (e) {
    console.error('[yCal recorder] failed to write meta sidecar', e);
  }

  // Engage the power-save blocker BEFORE spawning ffmpeg so the child
  // inherits a non-suspended scheduler context. We pair with a release
  // in stopRecording (and in the catch below if start fails).
  acquirePowerSaveBlocker();
  try {
    // Per-device capture config (set from the menubar Capture menu).
    //   * Voice-Processing (Apple AEC): per-device toggle, falling back to
    //     the global default seed when this Mac has no explicit choice yet.
    //     When on, record-meet.sh routes the mic through voiceproc-mic so
    //     speaker bleed is echo-cancelled (no headphones); it falls back to
    //     raw capture if the binary is missing.
    //   * Mic device: a name substring pins the input device (both the raw
    //     and VPIO paths read YCAL_MIC_NAME); null = system default input.
    // Read at start and locked for this recording — changing the menubar
    // mid-meeting applies to the next recording, not this one.
    const startEnv: NodeJS.ProcessEnv = {};
    const vpDevice = getCaptureVoiceProcessing();
    const useVoiceProc = vpDevice === undefined
      ? (getUiSettings().recordingVoiceProcessing ?? false)
      : vpDevice;
    if (useVoiceProc) startEnv.YCAL_MIC_VPIO = '1';
    const captureMic = getCaptureMic();
    if (captureMic) startEnv.YCAL_MIC_NAME = captureMic;
    rlog(`startRecording capture: mic=${captureMic ?? 'system-default'} voiceProc=${useVoiceProc}`);
    const stdout = await execScript(
      [RECORD_SH, 'start', ev.id, ev.title, String(maxSecs)],
      Object.keys(startEnv).length > 0 ? { envExtras: startEnv } : {},
    );
    status.audioFile = stdout.trim() || undefined;
    pushStatus();
    // Drop a context.json next to the audio so post-meet.sh can feed
    // the attendee list (with the recorder's own identity surfaced as
    // "Me") into Claude's summary prompt. Failures here are non-fatal —
    // the summary still works, it just won't have attribution context.
    if (status.audioFile) {
      try { writeRecordingContext(status.audioFile, ev, status.startedAt, endsAt); }
      catch (e) { console.error('[yCal recorder] failed to write context sidecar', e); }
      // Kick off the file-growth-rate health monitor now that we have
      // an audio path. Stopped + cleared on stopRecording.
      startHealthMonitor(ev.id);
    }
    notify('yCal · recording', ev.title || 'Meeting');
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('[yCal recorder] start failed', message);
    status.state = 'failed';
    status.error = message;
    pushStatus();
    // We acquired the blocker just above; release it since the recording
    // never actually started.
    releasePowerSaveBlocker();
    notify('yCal · recording failed to start', message.slice(0, 140));
    skipped.add(ev.id);
    // Block re-entry for this exact meet room until the user leaves +
    // rejoins. Without this, active-Meet mode would mint a new
    // synthetic eventId every 10s and stack up another Failed row each
    // time. The set is cleared on inMeet=false (real exit) and on
    // manual start.
    if (meetCode) failedMeetCodes.add(meetCode);
  }
}

async function stopRecording(eventId: string, reason = 'unspecified'): Promise<void> {
  const status = recordings.get(eventId);
  if (!status) {
    rlog(`stopRecording(${eventId}, ${reason}) — no status, ignoring`);
    return;
  }
  // Persist the full call-site stack so we can identify which path
  // triggered an auto-stop after the fact. Cheap (one fs.write) and
  // only fires on stop transitions.
  rtrace(`stopRecording(${eventId}, reason=${reason}) state=${status.state} endsAt=${status.endsAt ? new Date(status.endsAt).toISOString() : 'null'}`);
  // Move out of 'recording' immediately so concurrent ticks don't try
  // to start/stop again.
  status.state = 'processing';
  status.silentSeconds = undefined;
  pushStatus();
  skipped.add(eventId);
  stopHealthMonitor(eventId);
  // Release the App-Nap blocker we acquired in startRecording. Paired
  // refcount so concurrent recordings don't drop the hold prematurely.
  releasePowerSaveBlocker();

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
      // Surface this as a visible failure instead of silently dropping
      // the row. Empty recordings used to vanish from the popover with
      // no explanation — the user just saw "yCal was recording" with no
      // file to show for it. Keep the entry around so the auto-prune
      // (30 min) sweeps it eventually but the user can see what happened.
      status.state = 'failed';
      status.error = `Recording produced no audio (${st.size}B). Check Screen Recording / Microphone permissions, or the event may already be over.`;
      status.audioFile = undefined;
      pushStatus();
      return;
    }
    // Silence gate: catch the case where MIN_AUDIO_BYTES passed (file is
    // multi-MB) but the recording is mostly silent — both inputs delivered
    // zeros across the meeting. AAC at 192 kbps with real speech averages
    // ~24 kB/s; pure silence drops to ~700 B/s (verified against the
    // 2026-05-26 Builder Leveling case: 1.8 MB / 44 min ≈ 720 B/s). Don't
    // burn 5 min of whisper + a Claude call on what we already know is
    // hallucination-bait. We KEEP the file on disk so the user can
    // manually salvage if needed — just don't auto-process or upload.
    const elapsedMs = Math.max(0, Date.now() - status.startedAt);
    if (elapsedMs > 60_000) {
      const avgBps = st.size / (elapsedMs / 1000);
      if (avgBps < SILENT_BPS_THRESHOLD) {
        // Distinguish "tap helper exhausted retries" from a generic
        // silent recording. record-meet.sh's watcher writes the marker
        // file when it SIGINTs ffmpeg after `restart 10/10` + sustained
        // dead-audio events — gives the user a concrete cause instead
        // of just "your file is silent".
        const tapMarker = path.join(STATE_DIR, `${eventId}.tap-exhausted`);
        const tapExhausted = fs.existsSync(tapMarker);
        try { fs.unlinkSync(tapMarker); } catch { /* */ }
        rlog(`silenceGate(${eventId}) avgBytesPerSec=${Math.round(avgBps)} sizeBytes=${st.size} elapsedSec=${Math.round(elapsedMs / 1000)} tapExhausted=${tapExhausted} → marking failed`);
        status.state = 'failed';
        status.error = tapExhausted
          ? `Recording stopped early — coreaudio-tap helper exhausted its 10 retries and the system audio stream never recovered. File kept at ${audioFile}; check Screen Recording permission and Mac power state.`
          : `Recording produced only silence (${Math.round(avgBps)} B/s over ${Math.round(elapsedMs / 60_000)} min). Mac was likely in Low Power Mode or App Nap. Audio file kept at ${audioFile}.`;
        pushStatus();
        notify(
          tapExhausted ? 'yCal · system audio tap died' : 'yCal · recording was silent',
          `${status.title || 'meeting'} — file kept locally, not uploaded.${tapExhausted ? '' : ' Disable Low Power Mode for in-room recordings.'}`,
        );
        return;
      }
    }
  } catch { /* stat failed — fall through and let postProcess decide */ }

  void postProcess(eventId, audioFile, status.title, status.accountId);
}

async function postProcess(
  eventId: string,
  audioFile: string,
  title: string,
  accountId: string | undefined,
  summaryOnly = false,
): Promise<void> {
  notify(summaryOnly ? 'yCal · re-summarizing' : 'yCal · transcribing', title);
  // Glossary runtime files (whisper prompt + transcript substitutions)
  // and the dynamic claude-prompt file all need cleanup AFTER the
  // script returns, regardless of success or failure. Stash here so
  // the finally block can hit them all.
  let glossaryRuntime: ReturnType<typeof buildRuntimeFiles> | null = null;
  let promptFile: string | undefined;
  try {
    // Resolve the effective glossary (global ∪ per-event) for this
    // recording and materialise the three sidecar files post-meet.sh
    // can consume. Empty glossary → buildRuntimeFiles returns nulls
    // and the script's env-gated paths short-circuit.
    const glossaryEntries = getEffectiveEntries(eventId);
    glossaryRuntime = buildRuntimeFiles(glossaryEntries);

    // Build the Claude summary prompt: user's custom template (or the
    // default), with a glossary block appended when entries exist.
    // Always write a prompt file when glossary entries exist, so the
    // post-meet.sh script picks up the augmented version — otherwise
    // its built-in heredoc would not include the glossary block.
    const customRaw = (getUiSettings().recordingSummaryPrompt ?? '').trim();
    const baseTemplate = customRaw || DEFAULT_SUMMARY_PROMPT;
    const finalPrompt = applyGlossaryToSummaryPrompt(baseTemplate, glossaryEntries);
    if (customRaw || glossaryEntries.length > 0) {
      promptFile = `${audioFile.replace(/\.m4a$/, '')}.summary.prompt.txt`;
      try {
        fs.writeFileSync(promptFile, finalPrompt);
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
    if (glossaryRuntime.whisperPromptFile) {
      envExtras.YCAL_WHISPER_PROMPT = glossaryRuntime.whisperPromptFile;
    }
    if (glossaryRuntime.filterFile) {
      envExtras.YCAL_TRANSCRIPT_FILTER = glossaryRuntime.filterFile;
    }
    if (summaryOnly) envExtras.YCAL_SUMMARY_ONLY = '1';
    // Speaker diarization toggle. When the user has enabled it in
    // Settings → Recording AND set their HF token AND the venv is
    // installed, hand post-meet.sh everything it needs to splice
    // [SPK1]/[SPK2]/… labels into the [Other] segments of the merged
    // transcript. Any missing piece → the env vars stay unset and
    // post-meet.sh falls back to the legacy [Me]/[Other] flow.
    const diarizeCfg = getUiSettings().recorderDiarize;
    if (diarizeCfg?.enabled && diarizeCfg.hfToken && isDiarizeVenvReady()) {
      envExtras.YCAL_DIARIZE_ENABLED = '1';
      envExtras.YCAL_HF_TOKEN = diarizeCfg.hfToken;
      envExtras.YCAL_DIARIZE_PY = DIARIZE_PY;
      envExtras.YCAL_DIARIZE_VENV_PY = getDiarizeVenvPython();
    }
    const stdout = await execScript([POST_SH, audioFile, title], {
      timeoutMs: 30 * 60_000,
      envExtras: Object.keys(envExtras).length > 0 ? envExtras : undefined,
    });
    const summary = stdout.trim() || audioFile.replace(/\.m4a$/, '.summary.md');
    const transcript = audioFile.replace(/\.m4a$/, '.transcript.txt');
    const status = recordings.get(eventId);
    if (status) {
      status.state = 'uploading';
      status.summaryFile = summary;
      if (fs.existsSync(transcript)) status.transcriptFile = transcript;
      pushStatus();
    }

    const uploadedKinds = await uploadArtifacts({
      eventId,
      title,
      accountId,
      audioFile,
      transcriptFile: fs.existsSync(transcript) ? transcript : null,
      summaryFile: fs.existsSync(summary) ? summary : null,
      startedAt: status?.startedAt ?? Date.now(),
      endsAt: status?.endsAt,
    });

    // Quiet-failure guard: if speaker separation was requested but the
    // transcript came back with no [SPKn] labels, diarization fell over
    // (revoked HF token, gated model, OOM, …) and post-meet.sh silently
    // kept [Me]/[Other]. The recording is still fine, so surface a warning
    // rather than a failure — otherwise the user just wonders why everyone
    // is "Other".
    let diarizeWarning: string | undefined;
    if (envExtras.YCAL_DIARIZE_ENABLED === '1' && fs.existsSync(transcript)) {
      try {
        if (!/\]\s*SPK\d/i.test(fs.readFileSync(transcript, 'utf-8'))) {
          diarizeWarning = 'Speaker separation produced no labels — diarization may have failed. Re-run “Setup Diarization” in Settings → Recording.';
        }
      } catch { /* ignore */ }
    }

    const finalStatus = recordings.get(eventId);
    if (finalStatus) {
      finalStatus.state = 'done';
      finalStatus.uploadedKinds = uploadedKinds;
      if (diarizeWarning) finalStatus.warning = diarizeWarning;
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
  } finally {
    if (glossaryRuntime) {
      try { glossaryRuntime.cleanup(); } catch { /* best-effort */ }
    }
    // Leave the summary.prompt.txt on disk so the user can inspect what
    // was sent to Claude when a summary looks wrong. Matches prior
    // behavior of the custom-prompt path.
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

// ── Recording health monitor ────────────────────────────────────────────
// Poll the in-flight m4a's size; compute byte-rate over a 60s rolling
// window; bubble silentSeconds onto the status row so the popover can
// show ⚠ while the recording is still salvageable (user can re-launch
// the meeting from a powered Mac, switch mic device, etc.). The
// notification fires once when we cross the 60s silent threshold —
// repeated firings would just be spam.
function startHealthMonitor(eventId: string): void {
  // Defensive: if a prior monitor wasn't cleared, drop it before
  // installing the new one so we don't leak timers across re-starts.
  stopHealthMonitor(eventId);
  healthSamples.set(eventId, []);
  let warnedOnce = false;
  const timer = setInterval(() => {
    const status = recordings.get(eventId);
    if (!status || status.state !== 'recording' || !status.audioFile) return;
    let size: number;
    try { size = fs.statSync(status.audioFile).size; }
    catch { return; }
    const now = Date.now();
    const samples = healthSamples.get(eventId) ?? [];
    samples.push({ atMs: now, size });
    // Drop samples older than the rolling window. Keep at least the
    // two latest so we always have a baseline + current for rate calc.
    while (samples.length > 2 && samples[0].atMs < now - HEALTH_WINDOW_MS) {
      samples.shift();
    }
    healthSamples.set(eventId, samples);
    if (samples.length < 2) return;
    const oldest = samples[0];
    const newest = samples[samples.length - 1];
    const elapsedMs = newest.atMs - oldest.atMs;
    if (elapsedMs < HEALTH_WINDOW_MS - HEALTH_TICK_MS) return; // not enough history yet
    const deltaBytes = Math.max(0, newest.size - oldest.size);
    const bytesPerSec = deltaBytes / (elapsedMs / 1000);
    if (bytesPerSec < SILENT_BPS_THRESHOLD) {
      status.silentSeconds = Math.round(elapsedMs / 1000);
      pushStatus();
      if (!warnedOnce) {
        warnedOnce = true;
        notify('yCal · recording may be silent',
          `${status.title || 'meeting'} — only ${Math.round(bytesPerSec)} B/s in last ${Math.round(elapsedMs / 1000)}s. Check mic / wake the Mac.`);
        rlog(`silentWarning(${eventId}) bytesPerSec=${Math.round(bytesPerSec)} windowSec=${Math.round(elapsedMs / 1000)}`);
      }
    } else if (status.silentSeconds) {
      // Audio resumed — clear the warning so the UI snaps back to ●.
      status.silentSeconds = undefined;
      pushStatus();
    }
  }, HEALTH_TICK_MS);
  // Allow the process to exit if this is the only timer left (unit
  // tests, CLI mode). Production yCal has many other timers so this
  // is a no-op in practice.
  if (typeof timer.unref === 'function') timer.unref();
  healthTimers.set(eventId, timer);
}

function stopHealthMonitor(eventId: string): void {
  const t = healthTimers.get(eventId);
  if (t) { clearInterval(t); healthTimers.delete(eventId); }
  healthSamples.delete(eventId);
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
    const bundledVpio = resolveBundled('native', 'voiceproc-mic');
    const env = {
      ...process.env,
      ...(bundledTap ? { YCAL_COREAUDIO_TAP: bundledTap } : {}),
      ...(bundledVpio ? { YCAL_VPIO_BIN: bundledVpio } : {}),
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

// Best-effort push of the {audio, transcript, summary} trio to the
// event-owning account's Drive appdata. Errors are logged but never
// rethrown — a finished recording with local files is still useful to
// the user even if Drive is down. Returns which kinds landed
// successfully so the status row in the popover can flag "✓ on Drive".
async function uploadArtifacts(input: {
  eventId: string;
  title: string;
  accountId: string | undefined;
  audioFile: string;
  transcriptFile: string | null;
  summaryFile: string | null;
  startedAt: number;
  endsAt: number | undefined;
}): Promise<Array<'audio' | 'transcript' | 'summary'>> {
  // Resolve which account's appdata to push to. Prefer the event's own
  // account when available; otherwise fall back to the first signed-in
  // account (typical: single-user → there's only one). When NO account
  // is signed in at all, skip the upload silently.
  let accountId = input.accountId;
  if (!accountId) {
    const accounts = listAccounts();
    if (accounts.length === 0) {
      console.log('[yCal recorder] no accounts signed in — skipping Drive upload');
      return [];
    }
    accountId = accounts[0].id;
    console.log(
      `[yCal recorder] event ${input.eventId} has no accountId — uploading to first account ${accounts[0].email}`,
    );
  }

  const ui = getUiSettings();
  const uploadAudio = ui.recordingUploadAudio ?? true;

  try {
    const res = await uploadMeetingArtifacts({
      eventId: input.eventId,
      title: input.title,
      accountId,
      startedAt: input.startedAt,
      endsAt: input.endsAt,
      audioFile: input.audioFile,
      transcriptFile: input.transcriptFile,
      summaryFile: input.summaryFile,
      uploadAudio,
    });
    // Push the structured note.json sidecar (the Notes view's source of
    // truth) alongside the trio when post-meet.sh emitted one. Best-effort
    // — a missing or unreadable note.json just means the Notes view falls
    // back to parsing summary.md on this + other Macs.
    const noteFile = input.audioFile.replace(/\.m4a$/, '.note.json');
    if (fs.existsSync(noteFile)) {
      try {
        await uploadMeetingNoteSidecar(input.eventId, accountId, fs.readFileSync(noteFile, 'utf-8'));
      } catch (e) {
        console.error('[yCal recorder] note.json sidecar upload failed', e);
      }
    }
    const uploaded = Object.keys(res.uploaded) as Array<'audio' | 'transcript' | 'summary'>;
    if (Object.keys(res.errors).length > 0) {
      console.error('[yCal recorder] Drive upload partial failure', res.errors);
    } else {
      console.log(
        `[yCal recorder] Drive upload ok (${uploaded.join(', ') || 'nothing'}) → ${accountId}`,
      );
    }
    return uploaded;
  } catch (e) {
    console.error('[yCal recorder] Drive upload failed', e);
    return [];
  }
}
