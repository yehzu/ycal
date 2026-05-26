// Recorder-specific append-only file log. Lives at
// ~/Library/Logs/yCal/recorder.log so it survives across yCal launches.
// Captures the [yCal recorder] console.log lines plus an explicit
// rtrace() that writes a stack frame — useful for diagnosing "who
// stopped my recording" after the fact.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const LOG_DIR = path.join(os.homedir(), 'Library', 'Logs', 'yCal');
const LOG_FILE = path.join(LOG_DIR, 'recorder.log');

let stream: fs.WriteStream | null = null;

function ensureStream(): fs.WriteStream | null {
  if (stream) return stream;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    stream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
    stream.on('error', () => { stream = null; });
    return stream;
  } catch {
    return null;
  }
}

function write(line: string): void {
  const s = ensureStream();
  if (!s) return;
  try { s.write(line); } catch { /* */ }
}

function fmt(args: unknown[]): string {
  return args.map((a) => {
    if (a instanceof Error) return a.stack || a.message;
    if (typeof a === 'string') return a;
    try { return JSON.stringify(a); } catch { return String(a); }
  }).join(' ');
}

export function rlog(...args: unknown[]): void {
  const ts = new Date().toISOString();
  write(`${ts} ${fmt(args)}\n`);
}

// Like rlog but also captures the JS stack so we can see who called us.
// Used at stopRecording's entry to identify which path triggered an
// auto-stop (manual click vs tick vs handleMeetSignal vs suspend).
export function rtrace(...args: unknown[]): void {
  const ts = new Date().toISOString();
  const stack = new Error().stack?.split('\n').slice(2).join('\n') ?? '(no stack)';
  write(`${ts} ${fmt(args)}\n${stack}\n`);
}
