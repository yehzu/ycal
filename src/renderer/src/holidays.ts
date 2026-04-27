import type { CalendarEvent } from '@shared/types';
import { eventTouchesDay } from './multiday';
import { type CalRoles, isHolidayEvent } from './calRoles';

export type DayKind = 'holiday' | 'workday' | 'weekend';

export interface DayHolidayInfo {
  kind: DayKind;
  label: string;
  color: string | null;
}

// What kind of day is this — used to tint cells / columns.
//   'workday'  — a 補班-style override that promotes a weekend INTO a workday
//   'holiday'  — a holiday-cal entry sits on this day
//   'weekend'  — Saturday or Sunday with nothing on it
//   null       — regular weekday
export function dayHolidayInfo(
  date: Date,
  events: CalendarEvent[],
  calRoles: CalRoles,
): DayHolidayInfo | null {
  const onDay = events.filter(
    (e) => isHolidayEvent(e, calRoles) && eventTouchesDay(e, date),
  );
  const workOverride = onDay.find((e) => isWorkdayOverride(e));
  if (workOverride) {
    return { kind: 'workday', label: workOverride.title, color: workOverride.color };
  }
  const holiday = onDay.find((e) => !isWorkdayOverride(e));
  if (holiday) {
    return { kind: 'holiday', label: holiday.title, color: holiday.color };
  }
  const dow = date.getDay();
  if (dow === 0 || dow === 6) return { kind: 'weekend', label: '', color: null };
  return null;
}

// 補班 days are flagged in title text by holiday calendars (e.g. Taiwan).
// Google has no formal field for this so we look for explicit markers.
function isWorkdayOverride(e: CalendarEvent): boolean {
  const t = e.title.toLowerCase();
  return /(make-?up workday|補班|makeup work day|workday \(makeup\))/.test(t);
}
