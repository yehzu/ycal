import type { CalendarEvent } from '@shared/types';

export type LocKind = 'office' | 'home' | 'ooo' | 'other';

// True for Google "working location" or "out of office" events. Either may
// inform UI affordances (cell tinting, sidebar grouping) — but only the
// `isLocationChip` subset replaces an agenda row with a chip. Timed OOO
// blocks ("I'm out 2-5pm") render in the timeline like real committed time
// so the user can see the actual slot.
export function isLocationEvent(e: CalendarEvent): boolean {
  return e.eventType === 'workingLocation' || e.eventType === 'outOfOffice';
}

// True for events that should render as a date-adjacent location chip
// instead of an agenda row or timeline block. Working-location is always a
// chip (it has no time). OOO is a chip ONLY when it's all-day — a timed
// OOO event keeps its place in the agenda / timeline / day-load so the user
// sees the slot, not a tag at the date.
export function isLocationChip(e: CalendarEvent): boolean {
  if (e.eventType === 'workingLocation') return true;
  if (e.eventType === 'outOfOffice') return e.allDay;
  return false;
}

export function locKindOf(e: CalendarEvent): LocKind {
  if (e.workingLocation?.kind) return e.workingLocation.kind;
  const t = (e.title || '').toLowerCase();
  if (/(wfh|home|remote)/.test(t)) return 'home';
  if (/(office|hq)/.test(t)) return 'office';
  if (/(ooo|out|pto|vacation|travel|trip)/.test(t)) return 'ooo';
  return 'other';
}

export function locLabelOf(e: CalendarEvent): string {
  return e.workingLocation?.label ?? e.title;
}
