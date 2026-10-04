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
  judgeActiveMeetPresence, isResumingMeet, resumeKeys,
  ACTIVE_MEET_IDLE_THRESHOLD_SECS: T, ACTIVE_MEET_RESUME_WINDOW_MS: W,
} = await import(
  'data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64')
);

const judge = (idleState, idleSecs, thresholdSecs) =>
  judgeActiveMeetPresence({ idleState, idleSecs }, { thresholdSecs });

// The whole gate as meetRecorder runs it: memory → verdict. `recorded`
// lists what this Mac recorded, as [roomCode, title, msAgo, source]; it is
// stored through resumeKeys() exactly as meetRecorder's rememberMeet()
// stores it. Titles here come from the detector's 'title' source unless a
// case says otherwise (signals default to it too).
const S = 'title';
const NOW = Date.parse('2026-10-05T10:00:00Z');
const HOUR = 60 * 60_000;
const memory = (recorded) => {
  const m = new Map();
  for (const [room, title, ago, source = S] of recorded) {
    for (const k of resumeKeys(room, title, source)) m.set(k, NOW - ago);
  }
  return m;
};
const gate = (signal, recorded, idleState, idleSecs) =>
  judgeActiveMeetPresence(
    { idleState, idleSecs },
    { resuming: isResumingMeet({ source: S, ...signal }, memory(recorded), NOW) },
  );
const ROOM = 'abc-defg-hij';
const TITLE = 'Meet - abc-defg-hij';

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
const LEFT_MEET = HANDLE.slice(HANDLE.indexOf('} else {'));
// The resume memory is whatever rememberMeet() writes to, found by what the
// code does rather than by the variable's name, so a rename can't blind
// the inMeet=false check. Any function that clears or deletes from it,
// other than rememberMeet's own TTL prune, counts as a way to forget.
const REMEMBER = bodyOf('function rememberMeet(');
const MEM = /for \(const k of keys\) (\w+)\.set\(/.exec(REMEMBER)?.[1] ?? null;
const forgetsIn = (code) => MEM !== null
  && new RegExp(`\\b${MEM}\\s*(\\.\\s*(clear|delete)\\s*\\(|=(?!=))`).test(code);
const FORGETTERS = MEM === null ? [] : [...REC.matchAll(/function (\w+)\(/g)]
  .map((m) => m[1])
  .filter((name) => name !== 'rememberMeet' && forgetsIn(bodyOf(`function ${name}(`)));
// The activeMeet start's keys (title included) and the per-recording map
// they're parked in for the stop — again found by what the code does.
const START_KEYS = /const (\w+) = resumeKeys\(\s*\w+,\s*signal\.title,\s*signal\.source\s*\)/.exec(IN_MEET)?.[1] ?? null;
const KEYS_MAP = START_KEYS === null ? null
  : new RegExp(`(\\w+)\\.set\\(event\\.id,\\s*${START_KEYS}\\)`).exec(IN_MEET)?.[1] ?? null;
const STOP = bodyOf('async function stopRecording(');

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
  // headphones on) by then. A meeting this Mac recorded recently must start.
  ['the resume window is 4 hours',
    () => W, 4 * HOUR],
  ['same room recorded here within the window, now idle → start (resume)',
    () => gate({ roomCode: ROOM }, [[ROOM, null, 20 * 60_000]], 'idle', 1800),
    { start: true, reason: 'resume' }],
  ['same room recorded here within the window, now locked → start (resume)',
    () => gate({ roomCode: ROOM }, [[ROOM, null, 20 * 60_000]], 'locked', 1800),
    { start: true, reason: 'resume' }],
  // Recurring meetings reuse their code, so last week's recording here must
  // not wave this week's synced tab through.
  ['same room but recorded exactly 4h ago → gated as usual (idle skips)',
    () => gate({ roomCode: ROOM }, [[ROOM, null, W]], 'idle', 1800),
    { start: false, reason: 'idle' }],
  ['same room recorded a week ago → gated as usual (locked skips)',
    () => gate({ roomCode: ROOM }, [[ROOM, null, 7 * 24 * HOUR]], 'locked', 5),
    { start: false, reason: 'locked' }],
  ['a different room than the one recorded here → gated as usual',
    () => gate({ roomCode: 'xyz-wxyz-xyz' }, [[ROOM, null, 20 * 60_000]], 'idle', 1800),
    { start: false, reason: 'idle' }],
  ['no room code and no title on the signal → never a resume',
    () => gate({}, [[ROOM, TITLE, 60_000]], 'idle', 1800),
    { start: false, reason: 'idle' }],
  ['a resume still starts when someone is active anyway',
    () => gate({ roomCode: ROOM }, [[ROOM, null, 60_000]], 'active', 2),
    { start: true, reason: 'resume' }],

  // Title-only signals: the System Events pass reports "Meet - …" with no
  // URL whenever the Meet tab is in front, so the title is often all a
  // restart can be matched by.
  ['title-only restart of a title recorded here, now idle → start (resume)',
    () => gate({ title: TITLE }, [[null, TITLE, 30 * 60_000]], 'idle', 2400),
    { start: true, reason: 'resume' }],
  ['title-only restart of a title recorded here, now locked → start (resume)',
    () => gate({ title: TITLE }, [[null, TITLE, 30 * 60_000]], 'locked', 2400),
    { start: true, reason: 'resume' }],
  ['title recorded here exactly 4h ago → gated as usual',
    () => gate({ title: TITLE }, [[null, TITLE, W]], 'idle', 1800),
    { start: false, reason: 'idle' }],
  ['a different title than the one recorded here → gated as usual',
    () => gate({ title: 'Meet - Weekly sync' }, [[null, TITLE, 30 * 60_000]], 'locked', 5),
    { start: false, reason: 'locked' }],
  ['the synced Mac: same title arrives, but it recorded nothing → gated',
    () => gate({ title: TITLE }, [], 'idle', 3600),
    { start: false, reason: 'idle' }],
  ['a title never matches a room key, or the reverse',
    () => [
      gate({ title: ROOM }, [[ROOM, null, 60_000]], 'idle', 1800).start,
      gate({ roomCode: TITLE }, [[null, TITLE, 60_000]], 'idle', 1800).start,
    ], [false, false]],
  // The Meet PWA: its "title" is the app name or bundle id, identical for
  // every meeting. One PWA recording must not wave every PWA meeting
  // through for 4 h — so it is neither remembered nor matched.
  ['a PWA "title" (proc / bundle source) is not remembered',
    () => [resumeKeys(null, 'Google Meet', 'proc'), resumeKeys(null, 'com.google.meet', 'bundle')],
    [[], []]],
  ['a "Meet - …" title from the title source is remembered',
    () => resumeKeys(null, TITLE, 'title'), [`title:${TITLE}`]],
  ['a PWA signal never resumes by title, even with that title in memory',
    () => gate({ title: 'Google Meet', source: 'proc' },
      [[null, 'Google Meet', 10 * 60_000, 'title']], 'idle', 1800),
    { start: false, reason: 'idle' }],
  ['a PWA recording followed by another PWA meeting → gated as usual',
    () => gate({ title: 'Google Meet', source: 'proc' },
      [[null, 'Google Meet', 10 * 60_000, 'proc']], 'locked', 5),
    { start: false, reason: 'locked' }],
  ['a URL-source signal resumes by its room code, not its URL "title"',
    () => gate({ roomCode: ROOM, title: `https://meet.google.com/${ROOM}`, source: 'arc' },
      [[ROOM, null, 10 * 60_000]], 'idle', 1800),
    { start: true, reason: 'resume' }],
  ['either key hitting is enough (stale title, fresh room)',
    () => gate({ roomCode: ROOM, title: TITLE },
      [[null, TITLE, 5 * HOUR], [ROOM, null, 10 * 60_000]], 'idle', 1800),
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
  ['no calendar lookup before the gate (it runs every tick on the idle Mac)',
    () => {
      const g = IN_MEET.indexOf('judgeActiveMeetPresence(');
      const head = IN_MEET.slice(0, g);
      return g >= 0 && !/pickEventForActiveMeet\(|fetchCandidates\(|listEvents\(/.test(head);
    }, true],
  ['the gate matches the signal with its source (or titles could never resume)',
    () => /isResumingMeet\(\s*\{[^}]*title:\s*signal\.title,\s*source:\s*signal\.source/.test(IN_MEET),
    true],
  ['activeMeet start remembers the signal title (via its source); startRecording the room',
    () => [
      START_KEYS !== null && IN_MEET.includes(`rememberMeet(${START_KEYS})`),
      bodyOf('async function startRecording(').includes('rememberMeet('),
    ], [true, true]],
  // Without this, a meeting running past 4 h from its start loses the title
  // key exactly when a late restart needs it.
  ['stop refreshes the start\'s keys, title included, not just the room',
    () => KEYS_MAP !== null
      && new RegExp(`rememberMeet\\([^;]*${KEYS_MAP}\\.get\\(eventId\\)`).test(STOP),
    true],
  ['the resume memory is found in rememberMeet (by behaviour, not by name)',
    () => MEM !== null, true],
  ['the inMeet=false branch never forgets meetings (a misread passes through it)',
    () => forgetsIn(LEFT_MEET) || FORGETTERS.some((f) => LEFT_MEET.includes(`${f}(`)),
    false],

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
