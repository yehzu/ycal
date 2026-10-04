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
const { judgeActiveMeetPresence, ACTIVE_MEET_IDLE_THRESHOLD_SECS: T } = await import(
  'data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64')
);

const judge = (idleState, idleSecs, threshold) =>
  judgeActiveMeetPresence({ idleState, idleSecs }, threshold);

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
