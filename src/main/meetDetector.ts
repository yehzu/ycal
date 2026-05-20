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
import type { RecorderMeetSignal } from '@shared/types';

const POLL_MS_IDLE = 20_000;
const POLL_MS_ACTIVE = 10_000;
const OFF_DEBOUNCE_MS = 90_000;

// Multi-source Meet detection AppleScript.
//
//   1. Visible process named "Meet" / "Google Meet" — Chrome / Arc PWA
//      windows that the user has installed Meet as. The user's screenshot
//      showed windows with the Meet icon and titles like "123" / "EPD
//      monthly afternoon tea" (just the meeting name); the only
//      reliable signal there is the owning process.
//   2. Bundle identifier containing "google.meet" — covers any PWA
//      built off Meet whose process name differs.
//   3. Window title starting "Meet - " — older Chrome tab format.
//   4. Window title containing "meet.google.com" — some browsers
//      surface the URL in the title.
//   5. Active tab URLs of Google Chrome (if running).
//   6. Active tab URLs of Arc (if running, Chrome-compatible scripting).
//
// Returns "yes:<source>:<detail>" on match, "no" otherwise. Source tag
// surfaces in the diagnostic UI so the user can see WHICH signal fired.
const APPLESCRIPT = `tell application "System Events"
  set procs to (processes whose visible is true)
  repeat with p in procs
    try
      set pname to (name of p) as string
      if pname is "Meet" or pname is "Google Meet" or pname is "Meet — Google Workspace" then
        return "yes:proc:" & pname
      end if
    end try
    try
      set bid to (bundle identifier of p) as string
      if bid contains "google.meet" then return "yes:bundle:" & bid
    end try
    try
      repeat with w in (every window of p)
        set wname to (name of w) as string
        if wname starts with "Meet - " then return "yes:title:" & wname
        if wname contains "meet.google.com" then return "yes:url:" & wname
      end repeat
    end try
  end repeat
end tell
try
  if application "Google Chrome" is running then
    tell application "Google Chrome"
      repeat with w in windows
        try
          set u to URL of active tab of w as string
          if u contains "meet.google.com/" then return "yes:chrome:" & u
        end try
      end repeat
    end tell
  end if
end try
try
  if application "Arc" is running then
    tell application "Arc"
      repeat with w in windows
        try
          set u to URL of active tab of w as string
          if u contains "meet.google.com/" then return "yes:arc:" & u
        end try
      end repeat
    end tell
  end if
end try
return "no"`;

// Diagnostic probe — three sections: visible processes (name + bundle
// id + window titles), Chrome's open tab URLs, and Arc's open tab URLs.
// Catches the case where the user's Meet window is owned by Chrome
// (not a separate "Meet" process) AND their browser permission isn't
// granted yet — the Chrome/Arc sections fail loudly with an error
// message the user can act on instead of silently returning "no".
const DIAGNOSE_APPLESCRIPT = `set output to ""
tell application "System Events"
  set procs to (processes whose visible is true)
  set output to output & "=== VISIBLE PROCESSES (" & (count of procs) & ") ===" & linefeed
  repeat with p in procs
    try
      set pname to (name of p) as string
      set bid to ""
      try
        set bid to (bundle identifier of p) as string
      end try
      set wins to {}
      try
        set wins to name of every window of p
      end try
      set winSummary to ""
      repeat with wn in wins
        if winSummary is not "" then set winSummary to winSummary & " | "
        set winSummary to winSummary & (wn as string)
      end repeat
      set output to output & pname & "  [" & bid & "]  -- " & winSummary & linefeed
    end try
  end repeat
end tell
set output to output & linefeed & "=== GOOGLE CHROME ===" & linefeed
try
  if application "Google Chrome" is running then
    tell application "Google Chrome"
      set tabCount to 0
      repeat with w in windows
        try
          set u to URL of active tab of w as string
          set output to output & "  active: " & u & linefeed
          set tabCount to tabCount + 1
        end try
        try
          repeat with t in tabs of w
            set tu to URL of t as string
            if tu contains "meet.google.com" then
              set output to output & "  tab: " & tu & linefeed
            end if
          end repeat
        end try
      end repeat
      if tabCount = 0 then set output to output & "  (no windows)" & linefeed
    end tell
  else
    set output to output & "  (not running)" & linefeed
  end if
on error errMsg
  set output to output & "  ERROR (likely needs Automation permission): " & errMsg & linefeed
end try
set output to output & linefeed & "=== ARC ===" & linefeed
try
  if application "Arc" is running then
    tell application "Arc"
      set tabCount to 0
      repeat with w in windows
        try
          set u to URL of active tab of w as string
          set output to output & "  active: " & u & linefeed
          set tabCount to tabCount + 1
        end try
      end repeat
      if tabCount = 0 then set output to output & "  (no windows)" & linefeed
    end tell
  else
    set output to output & "  (not running)" & linefeed
  end if
on error errMsg
  set output to output & "  ERROR (likely needs Automation permission): " & errMsg & linefeed
end try
return output`;

// Re-export so the recorder module can still import MeetSignal from
// the same place. The structural type is owned by @shared/types so the
// renderer can show the same field-by-field detail in Settings.
export type MeetSignal = RecorderMeetSignal;

let pollTimer: NodeJS.Timeout | null = null;
let state: MeetSignal = { inMeet: false, title: null, source: null, lastProbedAt: 0 };
let outSince = 0;
const listeners = new Set<(s: MeetSignal) => void>();

function probe(): Promise<MeetSignal> {
  return new Promise((resolve) => {
    execFile('/usr/bin/osascript', ['-e', APPLESCRIPT], { timeout: 5_000 }, (err, stdout) => {
      const now = Date.now();
      if (err) {
        resolve({ inMeet: false, title: null, source: null, lastProbedAt: now });
        return;
      }
      const out = String(stdout).trim();
      // Format: "yes:<source>:<detail>" — parse the two colons-separated
      // segments after the "yes" tag. Source is one of proc/bundle/title/
      // url/chrome/arc; detail is the matched string.
      if (out.startsWith('yes:')) {
        const rest = out.slice(4);
        const colonIdx = rest.indexOf(':');
        if (colonIdx > 0) {
          resolve({
            inMeet: true,
            source: rest.slice(0, colonIdx),
            title: rest.slice(colonIdx + 1).trim(),
            lastProbedAt: now,
          });
        } else {
          resolve({ inMeet: true, source: 'unknown', title: rest, lastProbedAt: now });
        }
      } else {
        resolve({ inMeet: false, title: null, source: null, lastProbedAt: now });
      }
    });
  });
}

// Called by the "Diagnose detection" button in Settings → Recording.
// Returns a free-text dump of visible processes + their bundle IDs +
// window titles so the user can paste it back if detection fails to
// fire and we need to learn a new app's signature.
export function diagnoseDetection(): Promise<string> {
  return new Promise((resolve) => {
    execFile('/usr/bin/osascript', ['-e', DIAGNOSE_APPLESCRIPT], { timeout: 10_000 }, (err, stdout) => {
      if (err) { resolve(`error: ${err.message}`); return; }
      resolve(String(stdout));
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
    // Always notify listeners (Settings UI wants the lastProbedAt
    // timestamp to refresh even when nothing changed). Recorder
    // wiring is idempotent on repeated "still in Meet" signals.
    for (const fn of listeners) fn(state);
    if (changed) reschedule();
  } else {
    if (!state.inMeet) {
      // Idle → idle: just update the timestamp so the UI sees we
      // probed recently.
      state = { ...state, lastProbedAt: now };
      for (const fn of listeners) fn(state);
      return;
    }
    if (outSince === 0) outSince = now;
    if (now - outSince >= OFF_DEBOUNCE_MS) {
      state = { inMeet: false, title: null, source: null, lastProbedAt: now };
      outSince = 0;
      reschedule();
      for (const fn of listeners) fn(state);
    } else {
      // Pending off-transition: surface so UI can show "wrapping up".
      state = { ...state, lastProbedAt: now };
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
  state = { inMeet: false, title: null, source: null, lastProbedAt: 0 };
  outSince = 0;
}

export function getMeetSignal(): MeetSignal { return state; }

export function onMeetChange(fn: (s: MeetSignal) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
