// yCal — pure helpers for resolving the day rhythm in the renderer.
//
// We mirror the resolution logic from main/rhythm.ts so a frame can render
// instantly with whatever data the App holds in state, without bouncing
// off IPC. Mutations still go through IPC; this file is read-only.

import type { RhythmData } from '@shared/types';
import { fmtDate } from './dates';

export interface ResolvedRhythm {
  wakeMin: number;
  sleepMin: number;
  // True when this date carries an explicit per-day override on top of the
  // default. Drives the "overridden" badge + revert glyph in the UI.
  overridden: boolean;
}

const FALLBACK = { wakeMin: 390, sleepMin: 1380 };

export function resolveDefault(
  data: RhythmData | null,
  dateStr: string,
): { wakeMin: number; sleepMin: number } {
  if (!data || data.defaults.length === 0) return FALLBACK;
  let cur = data.defaults[0];
  for (const def of data.defaults) {
    if (def.fromDate <= dateStr) cur = def;
    else break;
  }
  return { wakeMin: cur.wakeMin, sleepMin: cur.sleepMin };
}

export function resolveRhythm(
  data: RhythmData | null,
  date: Date | string,
): ResolvedRhythm {
  const dateStr = typeof date === 'string' ? date : fmtDate(date);
  const base = resolveDefault(data, dateStr);
  const o = data?.overrides?.[dateStr];
  if (o && (o.wakeMin !== undefined || o.sleepMin !== undefined)) {
    return {
      wakeMin: o.wakeMin ?? base.wakeMin,
      sleepMin: o.sleepMin ?? base.sleepMin,
      overridden: true,
    };
  }
  return { wakeMin: base.wakeMin, sleepMin: base.sleepMin, overridden: false };
}

// "6:30a" / "11p" — matches the calendar's existing time formatting style.
export function formatRhythmTime(min: number): string {
  const m = ((min % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  const hr12 = ((h + 11) % 12) + 1;
  const ap = h < 12 ? 'a' : 'p';
  return mm === 0 ? `${hr12}${ap}` : `${hr12}:${String(mm).padStart(2, '0')}${ap}`;
}

// Snap a minute count to a 15-minute grid. Used by the line-drag handler.
export function snap15(min: number): number {
  return Math.max(0, Math.min(1440, Math.round(min / 15) * 15));
}
