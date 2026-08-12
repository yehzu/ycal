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

function localDateTime(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T00:00:00`;
}

function localDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

// Department/HR feeds commonly encode a full-day absence as a timed 09:00–
// 18:00 event. Only that exact full-workday shape is promoted to an all-day
// display event; partial absences stay timed so the user can tell the
// difference. The display copy never changes the source event.
export function isTeamOooFullWorkday(e: CalendarEvent): boolean {
  if (e.allDay) return true;
  const start = new Date(e.start);
  const end = new Date(e.end);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return false;
  const startMinutes = start.getHours() * 60 + start.getMinutes();
  const endMinutes = end.getHours() * 60 + end.getMinutes();
  return end.getTime() > start.getTime()
    && startMinutes === TEAM_OOO_START_HOUR * 60
    && endMinutes === TEAM_OOO_END_HOUR * 60;
}

export function teamOooAllDayEvent(e: CalendarEvent): CalendarEvent {
  if (!isTeamOooFullWorkday(e)) return e;
  if (e.allDay) {
    return { ...e, eventType: 'default', workingLocation: undefined };
  }

  const start = new Date(e.start);
  const end = new Date(e.end);
  const startDay = localDay(start);
  const endMidnight = localDay(end);
  const endDay = end.getTime() > endMidnight.getTime()
    ? new Date(endMidnight.getFullYear(), endMidnight.getMonth(), endMidnight.getDate() + 1)
    : endMidnight;
  if (endDay.getTime() <= startDay.getTime()) {
    endDay.setDate(startDay.getDate() + 1);
  }

  return {
    ...e,
    id: `${e.id}:team-ooo:all-day`,
    start: localDateTime(startDay),
    end: localDateTime(endDay),
    allDay: true,
    // Keep Team OOO out of the personal OOO/location-chip renderer. The
    // calendar role still supplies its slate ribbon styling and read-only
    // filtering.
    eventType: 'default',
    workingLocation: undefined,
  };
}

// If a feed emits one 09:00–18:00 event per date, join adjacent entries with
// the same calendar/title into one all-day range. That preserves the visual
// continuity of a multi-day absence instead of producing a row of detached
// daily pills. Gaps remain separate absences.
export function teamOooAllDayEvents(
  events: CalendarEvent[], calRoles: CalRoles,
): CalendarEvent[] {
  const normal: CalendarEvent[] = [];
  const byKey = new Map<string, CalendarEvent[]>();
  for (const e of events) {
    if (!isTeamOooEvent(e, calRoles)) {
      normal.push(e);
      continue;
    }
    const shown = teamOooAllDayEvent(e);
    if (shown === e) {
      // A partial-day Team OOO remains a normal timed event. It must not be
      // grouped with the full-workday all-day range for the same person.
      normal.push(e);
      continue;
    }
    const key = [
      shown.accountId,
      shown.calendarId,
      shown.title.trim().toLocaleLowerCase(),
    ].join('|');
    const group = byKey.get(key);
    if (group) group.push(shown);
    else byKey.set(key, [shown]);
  }

  const team: CalendarEvent[] = [];
  for (const group of byKey.values()) {
    group.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
    let range = group[0];
    for (let i = 1; i < group.length; i++) {
      const next = group[i];
      if (new Date(next.start).getTime() > new Date(range.end).getTime()) {
        team.push(range);
        range = next;
        continue;
      }
      if (new Date(next.end).getTime() > new Date(range.end).getTime()) {
        range = {
          ...range,
          end: next.end,
          id: `${range.id}:${next.id}`,
        };
      }
    }
    team.push(range);
  }
  return [...normal, ...team];
}
