// Which calendars a query reads from — framework-free, like tests/watch.
//
//   npm run test:targets
//
// resolveTargets is pure, so this needs no Electron, no Google and no disk.
// esbuild only supplies the `@shared/*` alias that tsconfig gives the app.
//
// The case that earns this file: `teamOoo` is a read-only role in the
// renderer's agenda and in the Apple mirror, but resolveTargets used to test
// `role === 'subscribed'` alone and kept polling colleagues' OOO feeds. The
// watcher watching a wider set than the user sees is the one divergence the
// whole module exists to prevent.
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const built = await esbuild.build({
  entryPoints: [path.join(ROOT, 'src/main/calendarTargets.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
  alias: { '@shared': path.join(ROOT, 'src/shared') },
});
const { resolveTargets, UnknownCalendarError } = await import(
  'data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64')
);

// One account, one calendar per role, plus the two `selected` states.
const CALS = [
  { accountId: 'a', id: 'mine', name: 'Mine', selected: true, accessRole: 'owner' },
  { accountId: 'a', id: 'sub', name: 'Subscribed', selected: true, accessRole: 'reader' },
  { accountId: 'a', id: 'ooo', name: 'Team OOO', selected: true, accessRole: 'reader' },
  { accountId: 'a', id: 'hol', name: 'Holidays', selected: true, accessRole: 'reader' },
  { accountId: 'a', id: 'unsel', name: 'Unselected in Google', selected: false, accessRole: 'owner' },
  { accountId: 'b', id: 'other', name: 'Other account', selected: true, accessRole: 'owner' },
];

const UI = {
  accountsActive: {},
  calVisible: {},
  calRoles: { 'a|sub': 'subscribed', 'a|ooo': 'teamOoo', 'a|hol': 'holiday' },
};

const ui = (over = {}) => ({
  ...UI, ...over,
  accountsActive: { ...UI.accountsActive, ...(over.accountsActive ?? {}) },
  calVisible: { ...UI.calVisible, ...(over.calVisible ?? {}) },
  calRoles: { ...UI.calRoles, ...(over.calRoles ?? {}) },
});

const ids = (filter, over) =>
  resolveTargets(CALS, ui(over), filter).pairs.map((p) => p.calendarId).sort();

const CASES = [
  // The regression this file was added for.
  ['team OOO is read-only, so the default set drops it',
    () => ids({}), ['mine', 'other']],
  ['--include-read-only takes subscribed AND team OOO',
    () => ids({ includeReadOnly: true }), ['mine', 'ooo', 'other', 'sub']],
  ['--include-holidays does not smuggle in the read-only roles',
    () => ids({ includeHolidays: true }), ['hol', 'mine', 'other']],
  // Visibility, which the roles sit on top of.
  ['an unticked calendar is out whatever its role',
    () => ids({}, { calVisible: { 'a|mine': false } }), ['other']],
  ["calVisible falls back to Google's `selected` when unset",
    () => ids({ includeReadOnly: true, includeHolidays: true }),
    ['hol', 'mine', 'ooo', 'other', 'sub']],
  ['ticking a Google-unselected calendar in yCal brings it back',
    () => ids({}, { calVisible: { 'a|unsel': true } }), ['mine', 'other', 'unsel']],
  ['a deactivated account takes all of its calendars with it',
    () => ids({}, { accountsActive: { a: false } }), ['other']],
  ['--account narrows before anything else runs',
    () => ids({ accountIds: ['a'] }), ['mine']],
  // Deliberate overrides.
  ["--all-calendars ignores roles but still obeys Google's `selected`",
    () => ids({ allCalendars: true }), ['hol', 'mine', 'ooo', 'other', 'sub']],
  ['an explicit --calendar wins over role and visibility both',
    () => ids({ calendarIds: ['ooo'] }, { calVisible: { 'a|ooo': false } }), ['ooo']],
  ['an unknown --calendar is refused, not silently ignored',
    () => {
      try { ids({ calendarIds: ['nope'] }); return 'no throw'; }
      catch (e) { return e instanceof UnknownCalendarError ? 'UnknownCalendarError' : String(e); }
    }, 'UnknownCalendarError'],
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
