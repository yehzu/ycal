// meetDetector — polls macOS for "is the user currently in a Google
// Meet". Used by the recorder's "active Meet" trigger mode (the
// reality-detecting option from the design discussion): instead of
// starting/stopping recordings off calendar event.start/event.end times,
// we follow the actual Meet tab so meetings that delay or overrun are
// captured fully.
//
// Signal: any visible window whose title contains "Meet - " (the format
// Google Meet uses for its tab title) or the literal "meet.google.com"
// URL. AppleScript queries System Events; macOS prompts for Automation
// permission on first run (NSAppleEventsUsageDescription is already in
// our Info.plist, and the same osascript path is used elsewhere in the
// app so the user may have granted it already).
//
// Polling cadence: 20s while the OS isn't in a Meet, 10s while it is —
// faster cadence in-session so we react to the user tabbing away (i.e.
// meeting ending) within ~30s after the debounce.
//
// Debounce: a single negative probe doesn't stop the recording. Users
// briefly tab to another app during meetings (Slack, Notion, browser
// other tabs); without debounce we'd flicker the recording state.
// 90s sustained "no Meet" tips us into the stopped state.

import { execFile } from 'node:child_process';

const POLL_MS_IDLE = 20_000;
const POLL_MS_ACTIVE = 10_000;
const OFF_DEBOUNCE_MS = 90_000;

const APPLESCRIPT = `tell application "System Events"
  repeat with p in (processes whose visible is true)
    try
      repeat with w in (every window of p)
        set wname to name of w
        if wname contains "Meet - " then return "yes:" & wname
        if wname contains "meet.google.com" then return "yes:" & wname
      end repeat
    end try
  end repeat
  return "no"
end tell`;

export interface MeetSignal {
  inMeet: boolean;
  title: string | null;
}

let pollTimer: NodeJS.Timeout | null = null;
let state: MeetSignal = { inMeet: false, title: null };
let outSince = 0;
const listeners = new Set<(s: MeetSignal) => void>();

function probe(): Promise<MeetSignal> {
  return new Promise((resolve) => {
    execFile('/usr/bin/osascript', ['-e', APPLESCRIPT], { timeout: 5_000 }, (err, stdout) => {
      if (err) { resolve({ inMeet: false, title: null }); return; }
      const out = String(stdout).trim();
      if (out.startsWith('yes:')) resolve({ inMeet: true, title: out.slice(4).trim() });
      else resolve({ inMeet: false, title: null });
    });
  });
}

function reschedule(): void {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  const ms = state.inMeet ? POLL_MS_ACTIVE : POLL_MS_IDLE;
  pollTimer = setInterval(() => { void tick(); }, ms);
}

async function tick(): Promise<void> {
  const next = await probe();
  const now = Date.now();
  if (next.inMeet) {
    outSince = 0;
    const changed = !state.inMeet || state.title !== next.title;
    state = next;
    if (changed) {
      reschedule();   // switch to active cadence
      for (const fn of listeners) fn(state);
    }
  } else {
    if (!state.inMeet) return;
    if (outSince === 0) outSince = now;
    if (now - outSince >= OFF_DEBOUNCE_MS) {
      state = { inMeet: false, title: null };
      outSince = 0;
      reschedule();   // back to idle cadence
      for (const fn of listeners) fn(state);
    }
  }
}

export function startMeetDetector(): void {
  if (process.platform !== 'darwin') return;
  if (pollTimer) return;
  reschedule();
  setTimeout(() => { void tick(); }, 2_000);
}

export function stopMeetDetector(): void {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  state = { inMeet: false, title: null };
  outSince = 0;
}

export function getMeetSignal(): MeetSignal { return state; }

export function onMeetChange(fn: (s: MeetSignal) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
