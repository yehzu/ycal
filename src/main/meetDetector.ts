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

// Detection runs as THREE separate osascript invocations rather than
// one stitched-together script. Each per-browser block references
// terminology (like `active tab`) that only resolves when the matching
// app is installed; if Chrome isn't on the machine, AppleScript fails
// at COMPILE time with "Expected end of line but found property",
// killing the entire stitched script before any conditional runs.
// Splitting lets us catch the compile error per-browser and move on.
//
// Order: System Events first (always succeeds, catches the common
// cases — bundle id, process name, title patterns), then per-browser
// URL probes for cases where the Meet PWA window is owned by the
// browser itself.

// Pass 1: System Events. No browser terminology, always loads.
const SYSTEM_EVENTS_PROBE = `tell application "System Events"
  set procs to (processes whose visible is true)
  repeat with proc in procs
    try
      set pname to (name of proc) as text
      if pname is "Meet" or pname is "Google Meet" or pname is "Meet — Google Workspace" then
        return "yes:proc:" & pname
      end if
    end try
    try
      set bid to (bundle identifier of proc) as text
      if bid contains "google.meet" then return "yes:bundle:" & bid
    end try
    try
      repeat with winRef in (every window of proc)
        set wname to (name of winRef) as text
        if wname starts with "Meet - " then return "yes:title:" & wname
        if wname contains "meet.google.com" then return "yes:url:" & wname
      end repeat
    end try
  end repeat
  return "no"
end tell`;

// Pass 2: Google Chrome. Iterate every tab of every window — the
// active-tab-only version misses Meet sessions that the user has open
// in a background tab or a non-focused Arc/Chrome split-view pane.
// Active tab gets checked first so "I'm in the Meet right now" wins
// over "I left a Meet tab open in another window".
const CHROME_PROBE = `tell application "Google Chrome"
  if not running then return "no"
  repeat with winIdx from 1 to count of windows
    try
      set urlText to (URL of active tab of window winIdx) as text
      if urlText contains "meet.google.com" then return "yes:chrome:" & urlText
    end try
    try
      repeat with tabRef in tabs of window winIdx
        try
          set urlText to (URL of tabRef) as text
          if urlText contains "meet.google.com" then return "yes:chrome:" & urlText
        end try
      end repeat
    end try
  end repeat
  return "no"
end tell`;

// Pass 3: Arc. Same shape, with the same active-tab-first + all-tabs
// fallback. The user's Arc setup uses split-view (two tabs side-by-
// side per window); active-tab only returns the focused one, but the
// Meet tab can be the OTHER half of the split — so we have to walk
// the full tab list to catch it.
const ARC_PROBE = `tell application "Arc"
  if not running then return "no"
  repeat with winIdx from 1 to count of windows
    try
      set urlText to (URL of active tab of window winIdx) as text
      if urlText contains "meet.google.com" then return "yes:arc:" & urlText
    end try
    try
      repeat with tabRef in tabs of window winIdx
        try
          set urlText to (URL of tabRef) as text
          if urlText contains "meet.google.com" then return "yes:arc:" & urlText
        end try
      end repeat
    end try
  end repeat
  return "no"
end tell`;

// Diagnostic dumps. Three independent osascript invocations — each
// section is reported separately so a compile failure in one (browser
// not installed) doesn't void the others.
const DIAGNOSE_SYSTEM_EVENTS = `set output to ""
tell application "System Events"
  set procs to (processes whose visible is true)
  set output to output & "=== VISIBLE PROCESSES (" & (count of procs) & ") ===" & linefeed
  repeat with proc in procs
    try
      set pname to (name of proc) as text
      set bid to ""
      try
        set bid to (bundle identifier of proc) as text
      end try
      set winSummary to ""
      try
        set winNames to name of every window of proc
        repeat with winName in winNames
          if winSummary is not "" then set winSummary to winSummary & " | "
          set winSummary to winSummary & (winName as text)
        end repeat
      end try
      set output to output & pname & "  [" & bid & "]  -- " & winSummary & linefeed
    end try
  end repeat
end tell
return output`;

// Dump ALL tab URLs per window, not just the active one. That way the
// "google meet test" tab the user has open behind their split-view
// foreground will actually show up in the diagnostic and we can see
// whether the URL really is meet.google.com (vs. a Google search
// result for the string "google meet test").
const DIAGNOSE_CHROME = `tell application "Google Chrome"
  if not running then return "(not running)"
  set output to ""
  set winCount to count of windows
  if winCount is 0 then return "(no windows)"
  repeat with winIdx from 1 to winCount
    set output to output & "  window " & winIdx & ":" & linefeed
    try
      set urlText to (URL of active tab of window winIdx) as text
      set output to output & "    [active] " & urlText & linefeed
    end try
    try
      repeat with tabRef in tabs of window winIdx
        try
          set tabUrl to (URL of tabRef) as text
          set output to output & "    " & tabUrl & linefeed
        end try
      end repeat
    end try
  end repeat
  return output
end tell`;

const DIAGNOSE_ARC = `tell application "Arc"
  if not running then return "(not running)"
  set output to ""
  set winCount to count of windows
  if winCount is 0 then return "(no windows)"
  repeat with winIdx from 1 to winCount
    set output to output & "  window " & winIdx & ":" & linefeed
    try
      set urlText to (URL of active tab of window winIdx) as text
      set output to output & "    [active] " & urlText & linefeed
    end try
    try
      repeat with tabRef in tabs of window winIdx
        try
          set tabUrl to (URL of tabRef) as text
          set output to output & "    " & tabUrl & linefeed
        end try
      end repeat
    end try
  end repeat
  return output
end tell`;

// Re-export so the recorder module can still import MeetSignal from
// the same place. The structural type is owned by @shared/types so the
// renderer can show the same field-by-field detail in Settings.
export type MeetSignal = RecorderMeetSignal;

let pollTimer: NodeJS.Timeout | null = null;
let state: MeetSignal = { inMeet: false, title: null, source: null, lastProbedAt: 0 };
let outSince = 0;
const listeners = new Set<(s: MeetSignal) => void>();

function runScript(script: string, timeout = 5_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/osascript', ['-e', script], { timeout }, (err, stdout, stderr) => {
      if (err) {
        // Surface the AppleScript compile error so callers can decide
        // whether to swallow it (per-browser probe failing because the
        // app isn't installed) or surface it (real bug).
        const detail = String(stderr || err.message || '').trim();
        reject(new Error(detail));
        return;
      }
      resolve(String(stdout).trim());
    });
  });
}

// Meeting-room URLs follow the shape meet.google.com/<aaa-bbbb-ccc>
// (three lowercase-letter groups, 3-4 chars each, separated by dashes).
// Non-meeting paths like /landing, /new, /lookup, /about don't match,
// and the bare https://meet.google.com homepage has no path at all.
// Returning false for those keeps the recorder from spinning up while
// the user is just idling on the Meet home page.
function looksLikeMeetingUrl(text: string): boolean {
  const m = /meet\.google\.com\/([^\s?#]+)/i.exec(text);
  if (!m) return false;
  const first = m[1].toLowerCase().replace(/^\/+/, '').split('/')[0];
  if (!first) return false;
  return /^[a-z]{3,4}-[a-z]{3,4}-[a-z]{3,4}$/.test(first);
}

// "Meet - <something>" tab title — real meetings render the meeting
// subject or code here, while the PWA on its landing page shows
// "Meet - Google Workspace". Filter that one explicitly.
function isMeetingTitle(title: string): boolean {
  const m = /^Meet\s*-\s*(.+?)\s*$/.exec(title);
  if (!m) return false;
  const subject = m[1].trim();
  return !/^google workspace$/i.test(subject);
}

function parseYes(raw: string, lastProbedAt: number): MeetSignal | null {
  // Format: "yes:<source>:<detail>" — parse the two colon-separated
  // segments. Source is one of proc/bundle/title/url/chrome/arc.
  const rest = raw.slice(4);
  const colonIdx = rest.indexOf(':');
  const source = colonIdx > 0 ? rest.slice(0, colonIdx) : 'unknown';
  const title = colonIdx > 0 ? rest.slice(colonIdx + 1).trim() : rest;

  // URL-based sources: must look like a real meeting room. Without
  // this check, every visit to meet.google.com (landing, new, lookup,
  // homepage) flips the detector to "in meet" and the recorder spins
  // up against the user's intent. Returning null lets probe() fall
  // through to the next pass.
  if (source === 'chrome' || source === 'arc' || source === 'url') {
    if (!looksLikeMeetingUrl(title)) return null;
  }
  // Browser tab-title source: same idea, reject "Meet - Google
  // Workspace" (PWA landing page chrome).
  if (source === 'title') {
    if (!isMeetingTitle(title)) return null;
  }

  return { inMeet: true, source, title, lastProbedAt };
}

async function probe(): Promise<MeetSignal> {
  const now = Date.now();
  // Each pass may return a "yes" that parseYes vetoes (e.g. user is on
  // the Meet landing page) — we fall through to the next pass in that
  // case so a real meeting open in another browser still gets caught.
  try {
    const out = await runScript(SYSTEM_EVENTS_PROBE);
    if (out.startsWith('yes:')) {
      const sig = parseYes(out, now);
      if (sig) return sig;
    }
  } catch (e) {
    console.error('[meetDetector] System Events probe failed:', (e as Error).message);
  }
  try {
    const out = await runScript(CHROME_PROBE);
    if (out.startsWith('yes:')) {
      const sig = parseYes(out, now);
      if (sig) return sig;
    }
  } catch { /* Chrome not available */ }
  try {
    const out = await runScript(ARC_PROBE);
    if (out.startsWith('yes:')) {
      const sig = parseYes(out, now);
      if (sig) return sig;
    }
  } catch { /* Arc not available */ }
  return { inMeet: false, title: null, source: null, lastProbedAt: now };
}

// Called by the "Diagnose detection" button in Settings → Recording.
// Three independent osascript invocations: System Events (always),
// Chrome (catch + report compile errors), Arc (same). The dump labels
// each section so the user can see immediately which probe(s) worked.
export async function diagnoseDetection(): Promise<string> {
  let output = '';
  try {
    output += (await runScript(DIAGNOSE_SYSTEM_EVENTS, 10_000)) + '\n';
  } catch (e) {
    output += `=== SYSTEM EVENTS — ERROR ===\n  ${(e as Error).message}\n\n`;
  }
  output += '=== GOOGLE CHROME ===\n';
  try {
    const r = await runScript(DIAGNOSE_CHROME, 8_000);
    output += r ? `${r}\n` : '(empty)\n';
  } catch (e) {
    const msg = (e as Error).message;
    if (/can.?t get/i.test(msg) || /found property/i.test(msg) || /Application is.?n.?t running/i.test(msg)) {
      output += '(not installed or terminology unavailable)\n';
    } else {
      output += `ERROR: ${msg}\n`;
    }
  }
  output += '\n=== ARC ===\n';
  try {
    const r = await runScript(DIAGNOSE_ARC, 8_000);
    output += r ? `${r}\n` : '(empty)\n';
  } catch (e) {
    const msg = (e as Error).message;
    if (/can.?t get/i.test(msg) || /found property/i.test(msg) || /Application is.?n.?t running/i.test(msg)) {
      output += '(not installed or terminology unavailable)\n';
    } else {
      output += `ERROR: ${msg}\n`;
    }
  }
  return output;
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
