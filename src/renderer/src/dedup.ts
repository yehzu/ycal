import type { CalendarEvent, CalendarSummary } from '@shared/types';

// Collapse events that look identical across calendars into a single rendered
// event. Signature: lowercase-trimmed title + start ISO + end ISO + allDay flag.
//
// When merging, prefer the version on the user's primary calendar (it's most
// likely the canonical one); fall back to the lexicographically smallest
// calendarId. The kept event's color wins; the others are stashed in
// mergedFrom so the popover can list them.
export function dedupEvents(
  events: CalendarEvent[],
  calendars: CalendarSummary[],
): CalendarEvent[] {
  const calRank = new Map<string, number>();
  // Lower rank → preferred. Primary calendars get rank 0, others rank 1.
  for (const c of calendars) calRank.set(c.id, c.primary ? 0 : 1);

  const groups = new Map<string, CalendarEvent[]>();
  for (const e of events) {
    const key = `${e.title.trim().toLowerCase()}|${e.start}|${e.end}|${e.allDay ? '1' : '0'}`;
    const arr = groups.get(key);
    if (arr) arr.push(e);
    else groups.set(key, [e]);
  }

  const out: CalendarEvent[] = [];
  for (const arr of groups.values()) {
    if (arr.length === 1) {
      out.push(arr[0]);
      continue;
    }
    const sorted = arr.slice().sort((a, b) => {
      const ra = calRank.get(a.calendarId) ?? 2;
      const rb = calRank.get(b.calendarId) ?? 2;
      if (ra !== rb) return ra - rb;
      return a.calendarId.localeCompare(b.calendarId);
    });
    const kept = sorted[0];
    const mergedFrom = sorted.map((e) => ({
      id: e.id,
      calendarId: e.calendarId,
      accountId: e.accountId,
      color: e.color,
      htmlLink: e.htmlLink,
    }));
    out.push({ ...kept, mergedFrom });
  }
  return out;
}
