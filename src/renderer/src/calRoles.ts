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

// True if every source of a (possibly merged) event is on a read-only calendar.
// dedupEvents may pick a subscribed calendar as the "kept" one — checking only
// the kept event would hide cross-merged duplicates that also live on a normal
// calendar, so we walk mergedFrom when present.
export function isFullyReadOnlyEvent(
  e: CalendarEvent, calRoles: CalRoles,
): boolean {
  const sources = e.mergedFrom && e.mergedFrom.length > 0
    ? e.mergedFrom
    : [{ accountId: e.accountId, calendarId: e.calendarId }];
  return sources.every(
    (s) => (calRoles[calKey(s.accountId, s.calendarId)] ?? 'normal') === 'subscribed',
  );
}

// When "Show read-only" is off but a merged event has both read-only and
// non-read-only sources, dedup may have made the read-only copy canonical
// (its color, htmlLink, ids leak through to the UI). Drop subscribed sources
// from mergedFrom and re-canonicalize against a writable one so the event
// presents only as its visible-calendar copies — fixes both the leaked color
// and the popover's "also on <hidden cal>" / "×N includes hidden" rows.
export function presentForVisibleCalendars(
  e: CalendarEvent, calRoles: CalRoles,
): CalendarEvent {
  if (!e.mergedFrom || e.mergedFrom.length === 0) return e;
  const visible = e.mergedFrom.filter(
    (s) => (calRoles[calKey(s.accountId, s.calendarId)] ?? 'normal') !== 'subscribed',
  );
  if (visible.length === 0 || visible.length === e.mergedFrom.length) {
    // Either nothing visible (caller should have filtered already) or no
    // read-only sources to strip — either way, no swap needed.
    return e;
  }
  const head = visible[0];
  const keptVisible = visible.find(
    (s) => s.calendarId === e.calendarId && s.accountId === e.accountId,
  );
  const canonical = keptVisible ?? head;
  return {
    ...e,
    id: canonical.id,
    calendarId: canonical.calendarId,
    accountId: canonical.accountId,
    color: canonical.color,
    htmlLink: canonical.htmlLink,
    // Keep canonical at index 0 so popover's slice(1) skips it correctly.
    mergedFrom: [canonical, ...visible.filter((s) => s !== canonical)],
  };
}
