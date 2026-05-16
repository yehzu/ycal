// Day load — the unifying number behind the capacity indicators on every view.
// Two metrics come out of one pass over a configurable "active window":
//
//   occupiedMin  — total time inside the window committed to timed events +
//                  scheduled tasks. RSVP-declined events don't count (you're
//                  not actually there); holiday / location events don't count
//                  (they aren't blocks of time you're working through). Events
//                  that overlap the edge are clipped to the window.
//   energyScore  — rough cost-of-day, expressed as "equivalent meeting hours."
//                  Meetings are 1.0×/h. Tasks are weighted by their declared
//                  energy: low 0.5×, mid 1.0×, high 1.5×. A 6-hour day of
//                  focus blocks reads similarly to 6h of meetings; a 6-hour
//                  day of hard creative work reads as ~9h.
//
// The window defaults to 9 AM – 6 PM ("active hours") so the gauge reflects
// work-day capacity rather than wake-to-sleep capacity — packed work days
// actually read as packed instead of looking 60% free.

import type {
  CalendarEvent, LoadBands, LoadWindowSettings, RhythmData, TaskItem,
} from '@shared/types';
import { DEFAULT_LOAD_BANDS } from '@shared/types';
import { type CalRoles, isExcludedFromAgenda } from './calRoles';
import { eventTouchesDay } from './multiday';
import { isLocationChip } from './locations';
import { resolveRhythm } from './rhythm';
import { fmtDate } from './dates';

export type LoadIntensity = 'calm' | 'steady' | 'full' | 'heavy';

export interface DayLoad {
  awakeMin: number;
  occupiedMin: number;
  freeMin: number;
  energyScore: number;
  fillPct: number;
  intensity: LoadIntensity;
  meetingCount: number;
  taskCount: number;
}

const ENERGY_W: Record<TaskItem['energy'], number> = {
  low: 0.5,
  mid: 1.0,
  high: 1.5,
};

interface ScheduledTaskRef {
  task: TaskItem;
  start: string;
}

interface ComputeArgs {
  date: Date;
  events: CalendarEvent[];
  calRoles: CalRoles;
  tasks?: TaskItem[];
  scheduledById?: Record<string, { date: string; start: string }>;
  rhythmData?: RhythmData | null;
  loadWindow?: LoadWindowSettings;
  loadBands?: LoadBands;
}

// Clip an event's [start, end] to the day-local window [winStart, winEnd]
// (both in minutes from midnight). Returns 0 when the event sits entirely
// outside the window — those don't count toward today's load.
function clippedDuration(
  e: CalendarEvent, day: Date, winStart: number, winEnd: number,
): number {
  const dayStartMs = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
  const dayEndMs = dayStartMs + 24 * 60 * 60 * 1000;
  const startMs = new Date(e.start).getTime();
  const endMs = new Date(e.end).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return 0;
  const sMin = startMs <= dayStartMs ? 0 : Math.round((startMs - dayStartMs) / 60000);
  const eMin = endMs >= dayEndMs ? 24 * 60 : Math.round((endMs - dayStartMs) / 60000);
  const lo = Math.max(sMin, winStart);
  const hi = Math.min(eMin, winEnd);
  return Math.max(0, hi - lo);
}

function clippedTaskDuration(
  startMin: number, durMin: number, winStart: number, winEnd: number,
): number {
  const lo = Math.max(startMin, winStart);
  const hi = Math.min(startMin + durMin, winEnd);
  return Math.max(0, hi - lo);
}

function resolveWindow(
  setting: LoadWindowSettings | undefined,
  rhythm: { wakeMin: number; sleepMin: number },
): { startMin: number; endMin: number } {
  if (!setting || setting.mode === 'rhythm') {
    return { startMin: rhythm.wakeMin, endMin: rhythm.sleepMin };
  }
  return {
    startMin: clampMin(setting.startMin, 0),
    endMin: clampMin(setting.endMin, setting.startMin + 60),
  };
}

function clampMin(m: number, min: number): number {
  return Math.max(min, Math.min(1440, Math.round(m)));
}

// Bands must be strictly increasing — a misconfigured pair (e.g. calmMax=8,
// steadyMax=4) would otherwise leave intermediate ranges unreachable. Snap
// each threshold up to at least its predecessor so the buckets remain sane.
function resolveBands(b: LoadBands | undefined): LoadBands {
  const src = b ?? DEFAULT_LOAD_BANDS;
  const calm = Math.max(0.1, src.calmMax);
  const steady = Math.max(calm + 0.1, src.steadyMax);
  const full = Math.max(steady + 0.1, src.fullMax);
  return { calmMax: calm, steadyMax: steady, fullMax: full };
}

export function computeDayLoad({
  date, events, calRoles, tasks, scheduledById, rhythmData, loadWindow,
  loadBands,
}: ComputeArgs): DayLoad | null {
  const ds = fmtDate(date);
  const r = resolveRhythm(rhythmData ?? null, ds);
  const win = resolveWindow(loadWindow, r);
  const windowMin = Math.max(60, win.endMin - win.startMin);

  let occupied = 0;
  let energy = 0;
  let meetingCount = 0;
  let taskCount = 0;

  for (const e of events) {
    if (e.allDay) continue;
    if (isLocationChip(e)) continue;
    if (isExcludedFromAgenda(e, calRoles)) continue;
    if (e.rsvp === 'declined') continue;
    if (!eventTouchesDay(e, date)) continue;
    const dur = clippedDuration(e, date, win.startMin, win.endMin);
    if (dur === 0) continue;
    occupied += dur;
    meetingCount += 1;
    energy += (dur / 60) * 1.0;
  }

  if (tasks && scheduledById) {
    const byId = new Map<string, TaskItem>();
    for (const t of tasks) byId.set(t.id, t);
    for (const [taskId, slot] of Object.entries(scheduledById)) {
      if (slot.date !== ds) continue;
      const t = byId.get(taskId);
      if (!t) continue;
      if (t.done) continue;
      const [hh, mm] = slot.start.split(':').map((n) => parseInt(n, 10) || 0);
      const startMin = hh * 60 + mm;
      const dur = clippedTaskDuration(startMin, t.dur || 30, win.startMin, win.endMin);
      if (dur === 0) continue;
      occupied += dur;
      taskCount += 1;
      energy += (dur / 60) * (ENERGY_W[t.energy] ?? 1.0);
    }
  }

  if (occupied === 0 && meetingCount === 0 && taskCount === 0) return null;

  const freeMin = Math.max(0, windowMin - occupied);
  const fillPct = Math.min(1, occupied / windowMin);
  // Intensity buckets are in equivalent-meeting-hours and stay absolute so
  // a 7-hour all-meeting day reads as "full" whether the window is 9h or 16h.
  const bands = resolveBands(loadBands);
  const intensity: LoadIntensity
    = energy <= bands.calmMax ? 'calm'
    : energy <= bands.steadyMax ? 'steady'
    : energy <= bands.fullMax ? 'full'
    : 'heavy';
  return {
    awakeMin: windowMin,
    occupiedMin: Math.round(occupied),
    freeMin: Math.round(freeMin),
    energyScore: Math.round(energy * 10) / 10,
    fillPct,
    intensity,
    meetingCount,
    taskCount,
  };
}

export function formatDur(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

// Suppress unused-export warnings while keeping the type exported for hooks.
export type { ScheduledTaskRef };
