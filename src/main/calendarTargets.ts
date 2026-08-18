// Which (account, calendar) pairs a query should read from.
//
// Extracted from cli.ts so `ycal watch` resolves exactly the same set as
// `ycal events` and the GUI agenda. If the watcher watched a different set
// from the one the user sees, every toggle in the sidebar would look to a
// consumer like a batch of events appearing or disappearing.
import type { CalendarSummary, CalRolePersisted, UiSettings } from '@shared/types';

// Mirrors the renderer's `calKey` (src/renderer/src/store.ts) EXACTLY: these
// strings index the persisted UiSettings.calVisible / calRoles maps, so a
// different separator here silently reads every calendar as un-configured.
// Not imported from @renderer/* because that would pull React into main.
export function calKey(accountId: string, calendarId: string): string {
  return `${accountId}|${calendarId}`;
}

/** Role for a calendar key, defaulting to 'normal' (matches the renderer). */
export function roleOf(
  ui: UiSettings,
  accountId: string,
  calendarId: string,
): CalRolePersisted {
  return ui.calRoles[calKey(accountId, calendarId)] ?? 'normal';
}

export interface TargetFilter {
  // Explicit list always wins — the caller is being deliberate.
  calendarIds?: string[] | null;
  accountIds?: string[] | null;
  // Bypass every UI filter; still respects Google's own `selected` flag.
  allCalendars?: boolean;
  includeReadOnly?: boolean;
  includeHolidays?: boolean;
}

export interface ResolvedTargets {
  // (accountId, calendarId) pairs, which is the honest unit: the same shared
  // calendar can be visible on account A and hidden on account B.
  pairs: Array<{ accountId: string; calendarId: string }>;
  // Deduped calendar ids, which is what the Google fetch is keyed by.
  calendarIds: string[];
  // Pair keys for post-filtering the fetch result back down to the pairs.
  pairKeys: Set<string>;
}

export class UnknownCalendarError extends Error {}

export function resolveTargets(
  allCalendars: CalendarSummary[],
  ui: UiSettings,
  filter: TargetFilter,
): ResolvedTargets {
  let targets = allCalendars;
  if (filter.accountIds) {
    const set = new Set(filter.accountIds);
    targets = targets.filter((c) => set.has(c.accountId));
  }

  let pairs: Array<{ accountId: string; calendarId: string }>;
  if (filter.calendarIds && filter.calendarIds.length > 0) {
    const allowed = new Set(targets.map((c) => c.id));
    const bad = filter.calendarIds.filter((id) => !allowed.has(id));
    if (bad.length > 0) {
      throw new UnknownCalendarError(`unknown calendar id(s): ${bad.join(', ')}`);
    }
    const wanted = new Set(filter.calendarIds);
    pairs = targets
      .filter((c) => wanted.has(c.id))
      .map((c) => ({ accountId: c.accountId, calendarId: c.id }));
  } else if (filter.allCalendars) {
    // Still respect Google's `selected` so we don't pull from calendars the
    // user has hidden in Google Calendar itself.
    pairs = targets
      .filter((c) => c.selected)
      .map((c) => ({ accountId: c.accountId, calendarId: c.id }));
  } else {
    pairs = targets
      .filter((c) => {
        // accountsActive: missing key defaults to true (matches store.ts).
        if (ui.accountsActive[c.accountId] === false) return false;
        // calVisible: missing key defaults to Google's `selected` flag
        // (matches refreshCalendars in store.ts).
        const visible = ui.calVisible[calKey(c.accountId, c.id)] ?? c.selected;
        if (!visible) return false;
        const role = roleOf(ui, c.accountId, c.id);
        if (role === 'subscribed' && !filter.includeReadOnly) return false;
        if (role === 'holiday' && !filter.includeHolidays) return false;
        return true;
      })
      .map((c) => ({ accountId: c.accountId, calendarId: c.id }));
  }

  return {
    pairs,
    calendarIds: Array.from(new Set(pairs.map((p) => p.calendarId))),
    pairKeys: new Set(pairs.map((p) => calKey(p.accountId, p.calendarId))),
  };
}
