// The Notes correction overlay's per-key merge — framework-free, like
// tests/presence.
//
//   npm run test:notes-overlay
//
// meeting-notes.json rides two whole-file last-writer-wins channels (iCloud
// Drive + Drive appdata), and the renderer used to ship each note's whole
// overlay. Its way of being wrong is silent: an edit made on one Mac quietly
// reverted by the other Mac's older copy. @shared/notesOverlayMerge is pure,
// so esbuild only supplies the `@shared/*` alias.
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const built = await esbuild.build({
  entryPoints: [path.join(ROOT, 'src/shared/notesOverlayMerge.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
  alias: { '@shared': path.join(ROOT, 'src/shared') },
});
const {
  mergeNotesOverlay, applyNoteOverlayOps, tombstoneNote, diffNoteOverlay,
  NOTE_TOMBSTONE_RETAIN_MS,
} = await import(
  'data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64')
);

const EV = 'evt1';
const empty = () => ({ version: 1, notes: {}, updatedAt: 0 });
// Both Macs start from the same synced file, then each edits on its own.
const edit = (file, ops, at) => applyNoteOverlayOps(file, EV, ops, at);
const note = (file) => {
  const n = file.notes[EV];
  if (!n) return null;
  const { clocks, updatedAt, ...content } = n;   // compare content only
  return content;
};
const both = (a, b) => [note(mergeNotesOverlay(a, b)), note(mergeNotesOverlay(b, a))];

const shared = edit(empty(), [{ field: 'title', value: 'Weekly' }], 1000);

const CASES = [
  // Two Macs, two different fields of the same note.
  ['concurrent edits to different fields both survive (either merge order)',
    () => both(
      edit(shared, [{ field: 'status', value: 'corrected' }], 2000),
      edit(shared, [{ field: 'summary', value: ['ship it'] }], 2100),
    ),
    [{ title: 'Weekly', status: 'corrected', summary: ['ship it'] },
     { title: 'Weekly', status: 'corrected', summary: ['ship it'] }]],
  ['concurrent edits to different transcript segments both survive',
    () => both(
      edit(shared, [{ field: 'segHtml', key: 's1', value: 'one' }], 2000),
      edit(shared, [{ field: 'segHtml', key: 's2', value: 'two' }], 2100),
    ),
    [{ title: 'Weekly', segHtml: { s1: 'one', s2: 'two' } },
     { title: 'Weekly', segHtml: { s1: 'one', s2: 'two' } }]],
  ['the same field edited on both Macs: the later edit wins',
    () => both(
      edit(shared, [{ field: 'title', value: 'Mac A' }], 2000),
      edit(shared, [{ field: 'title', value: 'Mac B' }], 3000),
    ),
    [{ title: 'Mac B' }, { title: 'Mac B' }]],
  ['the stale Mac re-sending its untouched copy changes nothing',
    () => note(mergeNotesOverlay(edit(shared, [{ field: 'title', value: 'New' }], 2000), shared)),
    { title: 'New' }],

  // Deletes: a field removed, and a whole note deleted.
  ['a field delete beats an older edit',
    () => both(
      edit(shared, [{ field: 'status', value: 'review' }], 2000),
      edit(edit(shared, [{ field: 'status', value: 'raw' }], 1500), [{ field: 'status', remove: true }], 3000),
    ),
    [{ title: 'Weekly' }, { title: 'Weekly' }]],
  ['a field delete loses to a newer edit',
    () => both(
      edit(shared, [{ field: 'status', value: 'review' }], 4000),
      edit(edit(shared, [{ field: 'status', value: 'raw' }], 1500), [{ field: 'status', remove: true }], 3000),
    ),
    [{ title: 'Weekly', status: 'review' }, { title: 'Weekly', status: 'review' }]],
  ['a deleted note stays deleted against a peer holding the old copy',
    () => both(tombstoneNote(shared, EV, 5000), shared),
    [null, null]],
  ['a note deleted, then edited again later (re-record) comes back with only the new edit',
    () => both(
      tombstoneNote(shared, EV, 5000),
      edit(shared, [{ field: 'status', value: 'raw' }], 6000),
    ),
    [{ status: 'raw' }, { status: 'raw' }]],
  ['a tombstone older than the retention window is pruned',
    () => {
      const t = tombstoneNote(shared, EV, 5000);
      return Object.keys(mergeNotesOverlay(t, empty(), 5000 + NOTE_TOMBSTONE_RETAIN_MS + 1).tombstones ?? {});
    },
    []],

  // An older yCal build: plain objects, no clocks, whole-note writes.
  ['a legacy clockless body merges without losing either side',
    () => {
      const legacy = { version: 1, updatedAt: 1500, notes: {
        [EV]: { title: 'Weekly', decisions: ['old build decision'], updatedAt: 1500 },
        legacyOnly: { status: 'corrected', updatedAt: 1500 },
      } };
      const ours = edit(shared, [{ field: 'summary', value: ['new build summary'] }], 2000);
      const m = mergeNotesOverlay(ours, legacy);
      return [note(m), m.notes.legacyOnly.status];
    },
    [{ title: 'Weekly', decisions: ['old build decision'], summary: ['new build summary'] }, 'corrected']],
  ['a legacy edit (clock 0, later updatedAt) lands over an equal-clock value',
    () => note(mergeNotesOverlay(
      { version: 1, updatedAt: 0, notes: { [EV]: { title: 'Weekly', updatedAt: 1 } } },
      { version: 1, updatedAt: 9, notes: { [EV]: { title: 'Renamed on old build', updatedAt: 9 } } },
    )),
    { title: 'Renamed on old build' }],
  ['a legacy value loses to any stamped change',
    () => note(mergeNotesOverlay(
      edit(shared, [{ field: 'title', value: 'Stamped' }], 2000),
      { version: 1, updatedAt: 99_999, notes: { [EV]: { title: 'Old build copy', updatedAt: 99_999 } } },
    )),
    { title: 'Stamped' }],
  ['garbage on disk does not crash the merge',
    () => note(mergeNotesOverlay(shared, { notes: null, updatedAt: 'x' })),
    { title: 'Weekly' }],

  // Main is the sole stamper; the renderer only diffs.
  ['a fresh edit lands after a peer clock that runs ahead',
    () => {
      const ahead = edit(shared, [{ field: 'title', value: 'Peer' }], 50_000);
      const mine = edit(ahead, [{ field: 'title', value: 'Mine' }], 3000);
      return [mine.notes[EV].clocks.title > 50_000, note(mergeNotesOverlay(mine, ahead)).title];
    },
    [true, 'Mine']],
  ['the renderer diff sends only the keys it changed',
    () => diffNoteOverlay(
      { title: 'Weekly', segHtml: { s1: 'a', s2: 'b' }, clocks: { title: 1 } },
      { title: 'Weekly', segHtml: { s1: 'a', s2: 'B' }, status: 'raw', clocks: { title: 1 } },
    ),
    [{ field: 'segHtml', key: 's2', value: 'B' }, { field: 'status', value: 'raw' }]],
  ['a cleared field and a dropped segment become removes',
    () => diffNoteOverlay(
      { transcriptTouchedAt: 5, segHtml: { s1: 'a' } },
      { transcriptTouchedAt: undefined, segHtml: {} },
    ),
    [{ field: 'transcriptTouchedAt', remove: true }, { field: 'segHtml', key: 's1', remove: true }]],
  ['a whole-map write is clocked per entry (drops removed keys)',
    () => note(edit(
      edit(shared, [{ field: 'speakerNames', key: 'spk1', value: 'Ann' }], 2000),
      [{ field: 'speakerNames', value: { spk2: 'Bo' } }], 3000,
    )),
    { title: 'Weekly', speakerNames: { spk2: 'Bo' } }],
];

// Key order is not content: two merge orders may build objects differently.
const canon = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));

let pass = 0, fail = 0;
for (const [name, run, want] of CASES) {
  const got = run();
  const ok = canon(got) === canon(want);
  if (ok) { pass++; console.log(`ok       ${name}`); }
  else {
    fail++;
    console.error(`FAIL     ${name}\n  want ${JSON.stringify(want)}\n  got  ${JSON.stringify(got)}`);
  }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
