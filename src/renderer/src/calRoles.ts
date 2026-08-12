import type { CalendarEvent } from '@shared/types';
import { calKey } from './store';

export type CalRole = 'normal' | 'subscribed' | 'holiday' | 'teamOoo';
export type CalRoles = Record<string, CalRole>;

export const TEAM_OOO_START_HOUR = 9;
export const TEAM_OOO_END_HOUR = 18;

export const ROLE_OPTIONS: Array<[CalRole, string]> = [
  ['normal', 'Normal events'],
  ['subscribed', 'Read-only (hide from agenda)'],
  ['holiday', 'Holiday (beside date)'],
  ['teamOoo', 'Team OOO (other people)'],
];

export function roleOfEvent(e: CalendarEvent, calRoles: CalRoles): CalRole {
  return calRoles[calKey(e.accountId, e.calendarId)] ?? 'normal';
}

export function isHolidayEvent(e: CalendarEvent, calRoles: CalRoles): boolean {
  return roleOfEvent(e, calRoles) === 'holiday';
}

// Team OOO is a calendar-level display mode for shared people/HR feeds. It is
// deliberately separate from Google's native outOfOffice eventType: native
// OOO belongs to the current user and keeps the warm personal OOO treatment.
// A merged event counts as team OOO when any of its source calendars has this
// role, even if dedupEvents selected another source as canonical.
export function isTeamOooEvent(e: CalendarEvent, calRoles: CalRoles): boolean {
  const sources = e.mergedFrom && e.mergedFrom.length > 0
    ? e.mergedFrom
    : [{ accountId: e.accountId, calendarId: e.calendarId }];
  return sources.some(
    (s) => (calRoles[calKey(s.accountId, s.calendarId)] ?? 'normal') === 'teamOoo',
  );
}

// Team OOO is read-only in the same sense as a subscribed calendar: it stays
// on the grid when read-only calendars are shown, but does not enter the
// user's own agenda or capacity calculation.
export function isExcludedFromAgenda(
  e: CalendarEvent, calRoles: CalRoles,
): boolean {
  const r = roleOfEvent(e, calRoles);
  return r === 'holiday' || isReadOnlyRole(r);
}

export function isReadOnlyRole(role: CalRole | undefined): boolean {
  return role === 'subscribed' || role === 'teamOoo';
}

// True if the calendar (by account|calendar key) is specifically subscribed
// — kept for callers that need to distinguish the two read-only presentations.
export function isSubscribedRole(role: CalRole | undefined): boolean {
  return role === 'subscribed';
}

// True if every source of a (possibly merged) event is on a read-only calendar
// (subscribed or Team OOO). dedupEvents may pick one read-only calendar as the
// "kept" one — checking only the kept event would hide cross-merged duplicates
// that also live on a normal calendar, so we walk mergedFrom when present.
export function isFullyReadOnlyEvent(
  e: CalendarEvent, calRoles: CalRoles,
): boolean {
  const sources = e.mergedFrom && e.mergedFrom.length > 0
    ? e.mergedFrom
    : [{ accountId: e.accountId, calendarId: e.calendarId }];
  return sources.every(
    (s) => isReadOnlyRole(calRoles[calKey(s.accountId, s.calendarId)] ?? 'normal'),
  );
}

// When "Show read-only" is off but a merged event has both read-only and
// non-read-only sources, dedup may have made a read-only copy canonical
// (its color, htmlLink, ids leak through to the UI). Drop read-only sources
// from mergedFrom and re-canonicalize against a writable one so the event
// presents only as its visible-calendar copies — fixes both the leaked color
// and the popover's "also on <hidden cal>" / "×N includes hidden" rows.
export function presentForVisibleCalendars(
  e: CalendarEvent, calRoles: CalRoles,
): CalendarEvent {
  if (!e.mergedFrom || e.mergedFrom.length === 0) return e;
  const visible = e.mergedFrom.filter(
    (s) => !isReadOnlyRole(calRoles[calKey(s.accountId, s.calendarId)] ?? 'normal'),
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

// Google HR feeds often encode a person's full workday OOO as an all-day
// event. For the calendar grid that is more useful as one ordinary 09:00–18:00
// event per date: it occupies the actual workday slot, shows the person's
// title, and does not disappear into the all-day ribbon stack.
export function teamOooDailyEvent(e: CalendarEvent, day: Date): CalendarEvent {
  if (!e.allDay) return e;
  const dayKey = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
  const start = new Date(
    day.getFullYear(), day.getMonth(), day.getDate(), TEAM_OOO_START_HOUR, 0, 0, 0,
  );
  const end = new Date(
    day.getFullYear(), day.getMonth(), day.getDate(), TEAM_OOO_END_HOUR, 0, 0, 0,
  );
  return {
    ...e,
    id: `${e.id}:team-ooo:${dayKey}`,
    start: start.toISOString(),
    end: end.toISOString(),
    allDay: false,
    // Avoid routing the derived display copy back through the personal OOO
    // location-band renderer. The calendar role still identifies it as Team
    // OOO for styling and read-only filtering.
    eventType: 'default',
    workingLocation: undefined,
  };
}
