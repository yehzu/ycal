// yCal — wake/sleep rhythm storage.
//
// Stores two things in a single `rhythm.json`:
//   1. A time-ordered list of `defaults` (wake/sleep minutes-from-midnight).
//      Each entry has a `fromDate` and applies to dates >= fromDate.
//      Changing the default appends a new entry — the historical entries
//      are preserved so older days resolve to whatever the user had set
//      back then.
//   2. A map of per-day `overrides`. Drag a wake/sleep line in the week or
//      day view and the dragged value lands here.
//
// File path is resolved through cloudStore so the user's iCloud preference
// (Settings → Sync) controls whether rhythm.json mirrors across Macs.

import type { RhythmData, RhythmDefault, RhythmOverride } from '@shared/types';
import { readJsonStrict, writeJson } from './cloudStore';

const FILE = 'rhythm.json';

const BASELINE: RhythmDefault = {
  fromDate: '0000-01-01',
  wakeMin: 390,   // 06:30
  sleepMin: 1380, // 23:00
};

function emptyRhythm(): RhythmData {
  return { defaults: [{ ...BASELINE }], overrides: {} };
}

// `corrupt` is true when the file existed but parse failed (transient
// iCloud read). Setters refuse to write in that state — otherwise they
// merge fresh defaults into a corrupt-read view and clobber the user's
// real on-disk overrides + default history.
function readRhythm(): { data: RhythmData; corrupt: boolean } {
  const result = readJsonStrict<Partial<RhythmData>>(FILE);
  if (result.status === 'missing' || !result.data) {
    return { data: emptyRhythm(), corrupt: result.status === 'corrupt' };
  }
  const raw = result.data;
  const defaults = Array.isArray(raw.defaults) && raw.defaults.length > 0
    ? raw.defaults
      .filter((d): d is RhythmDefault =>
        !!d
        && typeof d.fromDate === 'string'
        && Number.isFinite(d.wakeMin)
        && Number.isFinite(d.sleepMin),
      )
      .slice()
      .sort((a, b) => a.fromDate.localeCompare(b.fromDate))
    : [{ ...BASELINE }];
  const overrides = (raw.overrides && typeof raw.overrides === 'object')
    ? raw.overrides as Record<string, RhythmOverride>
    : {};
  if (defaults[0].fromDate !== BASELINE.fromDate) {
    defaults.unshift({ ...BASELINE });
  }
  return { data: { defaults, overrides }, corrupt: false };
}

function abortIfCorrupt(corrupt: boolean, op: string): boolean {
  if (!corrupt) return false;
  console.warn(
    `[yCal] ${op} aborted — rhythm.json unreadable right now ` +
    '(iCloud may be syncing). Keeping current on-disk state.',
  );
  return true;
}

export function getRhythm(): RhythmData {
  return readRhythm().data;
}

export function setOverride(
  dateStr: string,
  patch: { wakeMin?: number; sleepMin?: number },
): RhythmData {
  const { data, corrupt } = readRhythm();
  if (abortIfCorrupt(corrupt, 'setOverride')) return data;
  const cur = data.overrides[dateStr] ?? {};
  const next: RhythmOverride = { ...cur };
  if (patch.wakeMin !== undefined) next.wakeMin = clampMin(patch.wakeMin);
  if (patch.sleepMin !== undefined) next.sleepMin = clampMin(patch.sleepMin);
  const eff = resolveEffective(data, dateStr);
  const wake = next.wakeMin ?? eff.wakeMin;
  const sleep = next.sleepMin ?? eff.sleepMin;
  if (wake >= sleep) return data;
  data.overrides[dateStr] = next;
  writeJson(FILE, data);
  return data;
}

export function clearOverride(dateStr: string): RhythmData {
  const { data, corrupt } = readRhythm();
  if (abortIfCorrupt(corrupt, 'clearOverride')) return data;
  if (dateStr in data.overrides) {
    delete data.overrides[dateStr];
    writeJson(FILE, data);
  }
  return data;
}

export function setDefault(
  fromDateStr: string,
  next: { wakeMin: number; sleepMin: number },
): RhythmData {
  const { data, corrupt } = readRhythm();
  if (abortIfCorrupt(corrupt, 'setDefault')) return data;
  const wake = clampMin(next.wakeMin);
  const sleep = clampMin(next.sleepMin);
  if (wake >= sleep) return data;
  const existing = data.defaults.findIndex((d) => d.fromDate === fromDateStr);
  if (existing >= 0) {
    data.defaults[existing] = { fromDate: fromDateStr, wakeMin: wake, sleepMin: sleep };
  } else {
    data.defaults.push({ fromDate: fromDateStr, wakeMin: wake, sleepMin: sleep });
    data.defaults.sort((a, b) => a.fromDate.localeCompare(b.fromDate));
  }
  writeJson(FILE, data);
  return data;
}

function clampMin(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1440, Math.round(n)));
}

export function resolveDefault(
  data: RhythmData, dateStr: string,
): { wakeMin: number; sleepMin: number } {
  let cur = data.defaults[0];
  for (const def of data.defaults) {
    if (def.fromDate <= dateStr) cur = def;
    else break;
  }
  return { wakeMin: cur.wakeMin, sleepMin: cur.sleepMin };
}

export function resolveEffective(
  data: RhythmData, dateStr: string,
): { wakeMin: number; sleepMin: number } {
  const base = resolveDefault(data, dateStr);
  const o = data.overrides[dateStr];
  return {
    wakeMin: o?.wakeMin ?? base.wakeMin,
    sleepMin: o?.sleepMin ?? base.sleepMin,
  };
}
