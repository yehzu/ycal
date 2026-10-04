// Whether an activeMeet auto-start goes ahead on THIS Mac — framework-free,
// like tests/targets.
//
//   npm run test:presence
//
// judgeActiveMeetPresence is pure, so this needs no Electron: main samples
// powerMonitor and hands the numbers over. esbuild only supplies the
// `@shared/*` alias that tsconfig gives the app.
//
// The case that earns this file: Arc syncs a Meet tab to the other Mac, both
// Macs are on activeMeet (settings.json is cloud-synced), and the one nobody
// is using records an empty duplicate. Its way of being wrong in the other
// direction is worse — skipping a real meeting — so 'unknown' must start.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const built = await esbuild.build({
  entryPoints: [path.join(ROOT, 'src/shared/activeMeetPresence.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
  alias: { '@shared': path.join(ROOT, 'src/shared') },
});
const {
  judgeActiveMeetPresence, isResumingRoom,
  ACTIVE_MEET_IDLE_THRESHOLD_SECS: T, ACTIVE_MEET_RESUME_WINDOW_MS: W,
} = await import(
  'data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64')
);

const judge = (idleState, idleSecs, thresholdSecs) =>
  judgeActiveMeetPresence({ idleState, idleSecs }, { thresholdSecs });

// The whole gate as meetRecorder runs it: room memory → verdict.
const NOW = Date.parse('2026-10-05T10:00:00Z');
const HOUR = 60 * 60_000;
const gate = (room, recent, idleState, idleSecs) =>
  judgeActiveMeetPresence(
    { idleState, idleSecs },
    { resuming: isResumingRoom(room, new Map(Object.entries(recent)), NOW) },
  );

// The wiring, read from source. judgeActiveMeetPresence being right is no
// use if the call goes missing or moves off the one path it guards, and
// typecheck can't see that. A tripwire, not a parser: if a refactor trips
// it, re-read the gate's placement and update the anchors here.
const REC = fs.readFileSync(path.join(ROOT, 'src/main/meetRecorder.ts'), 'utf8');
const bodyOf = (signature) => {
  const at = REC.indexOf(signature);
  return at < 0 ? '' : REC.slice(at, REC.indexOf('\n}\n', at));
};
const HANDLE = bodyOf('async function handleMeetSignal(');
const IN_MEET = HANDLE.slice(0, HANDLE.indexOf('} else {'));

const CASES = [
  // The threshold itself — the Settings hint and the log line both quote it.
  ['the default threshold is 5 minutes',
    () => T, 300],

  // Somebody is at this Mac: the join was a click moments ago.
  ['active and just touched → start',
    () => judge('active', 3), { start: true, reason: 'active' }],
  ['active one second under the threshold → start',
    () => judge('active', T - 1), { start: true, reason: 'active' }],

  // The Mac that only received a synced tab.
  ['screen locked → skip, even if input was recent',
    () => judge('locked', 2), { start: false, reason: 'locked' }],
  ['screen locked and long idle → skip as locked',
    () => judge('locked', 3600), { start: false, reason: 'locked' }],
  ['idle for an hour → skip',
    () => judge('idle', 3600), { start: false, reason: 'idle' }],
  ['idle exactly at the threshold → skip',
    () => judge('idle', T), { start: false, reason: 'idle' }],
  ['active exactly at the threshold counts as idle → skip',
    () => judge('active', T), { start: false, reason: 'idle' }],
  // getSystemIdleState and getSystemIdleTime are two calls a moment apart;
  // if they straddle the boundary, either one saying idle wins.
  ["state says active but idle time is past the threshold → skip",
    () => judge('active', T + 1), { start: false, reason: 'idle' }],

  // Detection failed. Missing a real meeting is unrecoverable; a duplicate
  // empty file is a nuisance — so 'unknown' starts, whatever idleSecs says.
  ['unknown → start',
    () => judge('unknown', 0), { start: true, reason: 'unknown' }],
  ['unknown with a huge idle time still starts',
    () => judge('unknown', 99_999), { start: true, reason: 'unknown' }],
  ['unknown when the probe threw (idleSecs NaN) → start',
    () => judge('unknown', NaN), { start: true, reason: 'unknown' }],

  // Restarts. A recording that stops mid-meeting is retried only after
  // whisper + summary finish; a listener is hands-off (or locked, with
  // headphones on) by then. A room this Mac recorded recently must start.
  ['the resume window is 4 hours',
    () => W, 4 * HOUR],
  ['same room recorded here within the window, now idle → start (resume)',
    () => gate('abc-defg-hij', { 'abc-defg-hij': NOW - 20 * 60_000 }, 'idle', 1800),
    { start: true, reason: 'resume' }],
  ['same room recorded here within the window, now locked → start (resume)',
    () => gate('abc-defg-hij', { 'abc-defg-hij': NOW - 20 * 60_000 }, 'locked', 1800),
    { start: true, reason: 'resume' }],
  // Recurring meetings reuse their code, so last week's recording here must
  // not wave this week's synced tab through.
  ['same room but recorded exactly 4h ago → gated as usual (idle skips)',
    () => gate('abc-defg-hij', { 'abc-defg-hij': NOW - W }, 'idle', 1800),
    { start: false, reason: 'idle' }],
  ['same room recorded a week ago → gated as usual (locked skips)',
    () => gate('abc-defg-hij', { 'abc-defg-hij': NOW - 7 * 24 * HOUR }, 'locked', 5),
    { start: false, reason: 'locked' }],
  ['a different room than the one recorded here → gated as usual',
    () => gate('xyz-wxyz-xyz', { 'abc-defg-hij': NOW - 20 * 60_000 }, 'idle', 1800),
    { start: false, reason: 'idle' }],
  ['no room code on the signal → never a resume',
    () => gate(null, { 'abc-defg-hij': NOW - 60_000 }, 'idle', 1800),
    { start: false, reason: 'idle' }],
  ['a resume still starts when someone is active anyway',
    () => gate('abc-defg-hij', { 'abc-defg-hij': NOW - 60_000 }, 'active', 2),
    { start: true, reason: 'resume' }],

  // Wiring tripwires (source-level; see REC above).
  ['handleMeetSignal judges presence before it starts a recording',
    () => {
      const g = IN_MEET.indexOf('judgeActiveMeetPresence(');
      const st = IN_MEET.indexOf('startRecording(');
      return g >= 0 && st > g && /if \(!verdict\.start\)[\s\S]*?return;/.test(IN_MEET.slice(g, st));
    }, true],
  ['the gate is called on that one path only',
    () => REC.split('judgeActiveMeetPresence(').length - 1, 1],
  ['start and stop both record the room for resume',
    () => [
      bodyOf('async function startRecording(').includes('rememberRoom('),
      bodyOf('async function stopRecording(').includes('rememberRoom('),
    ], [true, true]],
  ['the inMeet=false branch never forgets rooms (a misread passes through it)',
    () => /recentRoomsOnThisMac\.(clear|delete)\(/.test(HANDLE), false],

  // The threshold is a parameter, not baked into the comparison.
  ['a custom threshold is honoured',
    () => [judge('active', 59, 60).start, judge('active', 60, 60).start], [true, false]],
];

let pass = 0, fail = 0;
for (const [name, run, want] of CASES) {
  const got = run();
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`ok       ${name}`); }
  else {
    fail++;
    console.error(`FAIL     ${name}\n  want ${JSON.stringify(want)}\n  got  ${JSON.stringify(got)}`);
  }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
