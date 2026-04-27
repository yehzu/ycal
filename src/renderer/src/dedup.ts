import type {
  CalendarEvent, CalendarSummary, MergeCriteria,
} from '@shared/types';
import { DEFAULT_MERGE_CRITERIA } from '@shared/types';

// Collapse events that look identical across calendars into a single rendered
// event. Title (trimmed + lowercased) and the start moment always count;
// matchEnd / matchAllDay are user-configurable.
//
// Time fields are compared via Date.getTime() — Google can return the same
// wall-clock moment as either an offset ISO (`...T06:00:00+08:00`) or a UTC
// ISO (`...T22:00:00Z`), and a raw-string key would treat those as distinct.
//
// When merging, prefer the version on the user's primary calendar; fall back
// to the lexicographically smallest calendarId. The kept event's color wins;
// the others are stashed in mergedFrom so the popover can list them.
export function dedupEvents(
  events: CalendarEvent[],
  calendars: CalendarSummary[],
  criteria: MergeCriteria = DEFAULT_MERGE_CRITERIA,
): CalendarEvent[] {
  const calRank = new Map<string, number>();
  for (const c of calendars) calRank.set(c.id, c.primary ? 0 : 1);

  const groups = new Map<string, CalendarEvent[]>();
  for (const e of events) {
    const startMs = new Date(e.start).getTime();
    const parts = [e.title.trim().toLowerCase(), String(startMs)];
    if (criteria.matchEnd) parts.push(String(new Date(e.end).getTime()));
    if (criteria.matchAllDay) parts.push(e.allDay ? '1' : '0');
    const key = parts.join('|');
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
