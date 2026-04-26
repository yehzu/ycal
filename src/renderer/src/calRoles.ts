import type { CalendarEvent } from '@shared/types';
import { calKey } from './store';

export type CalRole = 'normal' | 'subscribed' | 'holiday';
export type CalRoles = Record<string, CalRole>;

export const ROLE_OPTIONS: Array<[CalRole, string]> = [
  ['normal', 'Normal events'],
  ['subscribed', 'Read-only (hide from agenda)'],
  ['holiday', 'Holiday (beside date)'],
];

export function roleOfEvent(e: CalendarEvent, calRoles: CalRoles): CalRole {
  return calRoles[calKey(e.accountId, e.calendarId)] ?? 'normal';
}

export function isHolidayEvent(e: CalendarEvent, calRoles: CalRoles): boolean {
  return roleOfEvent(e, calRoles) === 'holiday';
}

// Holiday calendars are also kept out of the agenda — they render beside
// the date instead.
export function isExcludedFromAgenda(
  e: CalendarEvent, calRoles: CalRoles,
): boolean {
  const r = roleOfEvent(e, calRoles);
  return r === 'holiday' || r === 'subscribed';
}

// True if the calendar (by account|calendar key) is read-only / subscribed
// — its events still render on the grid but are split out of the agenda.
export function isSubscribedRole(role: CalRole | undefined): boolean {
  return role === 'subscribed';
}
