import type { CalendarEvent } from '@shared/types';

// Event "touches" day D iff [event.start, event.end) overlaps
// [00:00 of D, 00:00 of D+1).
//
// For all-day events Google reports an exclusive end (a single-day event has
// start=YYYY-MM-DD and end=YYYY-MM-DD+1). We convert both to local-midnight
// dates so the half-open math works the same for timed and all-day.
export function eventTouchesDay(event: CalendarEvent, day: Date): boolean {
  const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
  const dayEnd = dayStart + 24 * 60 * 60 * 1000;
  const evStart = new Date(event.start).getTime();
  const evEnd = new Date(event.end).getTime();
  return evStart < dayEnd && evEnd > dayStart;
}

export function eventsTouchingDay(events: CalendarEvent[], day: Date): CalendarEvent[] {
  return events.filter((e) => eventTouchesDay(e, day));
}

export function isEventStartDay(event: CalendarEvent, day: Date): boolean {
  const evStart = new Date(event.start);
  return (
    evStart.getFullYear() === day.getFullYear() &&
    evStart.getMonth() === day.getMonth() &&
    evStart.getDate() === day.getDate()
  );
}

// True for all-day events spanning more than one calendar day. Google reports
// the all-day end as exclusive, so a single-day event has end = start + 1 day.
export function isMultiDayAllDay(event: CalendarEvent): boolean {
  if (!event.allDay) return false;
  const start = new Date(event.start);
  const end = new Date(event.end);
  const oneDayLater = new Date(
    start.getFullYear(), start.getMonth(), start.getDate() + 1,
  );
  return end > oneDayLater;
}

export interface RibbonPlacement {
  event: CalendarEvent;
  colStart: number; // 0..6, the day-of-week column where this bar starts
  colEnd: number;   // 1..7 (exclusive)
  clippedLeft: boolean;  // event continues from a prior week
  clippedRight: boolean; // event continues into a later week
  lane: number;     // vertical stacking lane within this week
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// For a contiguous day-range starting at rangeStart and lasting `days` days,
// compute connected-bar placements for every multi-day all-day event that
// touches the range. Used for: a Sun..Sat week row in the month grid (days=7),
// and the all-day row in week/day view (days=7 or 1).
export function layoutRangeRibbons(
  events: CalendarEvent[],
  rangeStart: Date,
  days: number,
): RibbonPlacement[] {
  const rs = new Date(
    rangeStart.getFullYear(), rangeStart.getMonth(), rangeStart.getDate(),
  );
  const re = new Date(rs.getFullYear(), rs.getMonth(), rs.getDate() + days);

  const candidates = events.filter((e) => {
    if (!isMultiDayAllDay(e)) return false;
    const evStart = new Date(e.start);
    const evEnd = new Date(e.end);
    return evStart < re && evEnd > rs;
  });

  const raw = candidates.map<RibbonPlacement>((e) => {
    const evStart = new Date(e.start);
    const evEnd = new Date(e.end);
    const colStart = evStart > rs
      ? Math.floor((evStart.getTime() - rs.getTime()) / MS_PER_DAY)
      : 0;
    const colEnd = evEnd < re
      ? Math.ceil((evEnd.getTime() - rs.getTime()) / MS_PER_DAY)
      : days;
    return {
      event: e,
      colStart,
      colEnd,
      clippedLeft: evStart < rs,
      clippedRight: evEnd > re,
      lane: 0,
    };
  });

  raw.sort((a, b) => {
    if (a.colStart !== b.colStart) return a.colStart - b.colStart;
    return (b.colEnd - b.colStart) - (a.colEnd - a.colStart);
  });

  const laneEnds: number[] = [];
  for (const p of raw) {
    let placed = false;
    for (let i = 0; i < laneEnds.length; i++) {
      if (laneEnds[i] <= p.colStart) {
        laneEnds[i] = p.colEnd;
        p.lane = i;
        placed = true;
        break;
      }
    }
    if (!placed) {
      laneEnds.push(p.colEnd);
      p.lane = laneEnds.length - 1;
    }
  }

  return raw;
}

export function layoutWeekRibbons(
  events: CalendarEvent[],
  weekStart: Date,
): RibbonPlacement[] {
  return layoutRangeRibbons(events, weekStart, 7);
}
