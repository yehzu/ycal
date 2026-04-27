import type { CalendarEvent } from '@shared/types';

export type LocKind = 'office' | 'home' | 'ooo' | 'other';

// True for Google "working location" or "out of office" events. They live on
// a primary calendar and get rendered as date-adjacent icon chips, never as
// agenda rows.
export function isLocationEvent(e: CalendarEvent): boolean {
  return e.eventType === 'workingLocation' || e.eventType === 'outOfOffice';
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
