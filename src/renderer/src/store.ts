import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AccountSummary,
  CalendarSummary,
  CalendarEvent,
  MergeCriteria,
  UiSettings,
  WeatherDay,
} from '@shared/types';
import { addDays, fmtDate, startOfMonth } from './dates';
import { dedupEvents } from '@shared/dedup';

// Calendar visibility is keyed per (account, calendar) because shared/public
// calendars (e.g. holiday calendars) carry the same Google calendarId across
// every account that subscribes to them — keying by id alone would force them
// to toggle in lockstep.
export const calKey = (accountId: string, calendarId: string): string =>
  `${accountId}|${calendarId}`;

export interface Store {
  configured: boolean | null; // null = unknown / loading
  accounts: AccountSummary[];
  calendars: CalendarSummary[];
  events: CalendarEvent[];
  loading: boolean;
  error: string | null;

  // Visibility toggles, keyed by id. Defaults to whatever Google says.
  accountsActive: Record<string, boolean>;
  calVisible: Record<string, boolean>;

  setAccountActive: (id: string, on: boolean) => void;
  // calVisible is keyed by calKey(accountId, calendarId).
  setCalVisible: (key: string, on: boolean) => void;
  toggleCal: (key: string) => void;
  toggleAccount: (id: string) => void;

  refreshAccounts: () => Promise<void>;
  refreshCalendars: () => Promise<void>;
  loadEventsForRange: (start: Date, end: Date) => Promise<void>;
  // Force-refetch the currently held events range, bypassing both the
  // renderer-side fetchedRangeRef cache and the main-side eventsCache.
  // No-op if no range has been fetched yet (caller should await initial load).
  refreshEvents: () => Promise<void>;
  signIn: () => Promise<{ ok: boolean; error?: string }>;
  signOut: (id: string) => Promise<void>;

  weatherUrl: string | null;
  weatherDays: WeatherDay[];
  weatherError: string | null;
  setWeatherUrl: (url: string | null) => Promise<void>;

  // Cross-device sync hooks. The App-level subscriber to SettingsChanged
  // calls these to imperatively replace the slices the store owns. They
  // do NOT round-trip back to disk (the data already came from disk via
  // the file watcher), and the auto-save effect upstream is content-
  // deduped at cloudStore so a no-op write would be skipped anyway.
  applyRemoteUi: (ui: UiSettings) => void;
  applyRemoteWeatherUrl: (url: string | null) => void;
}

// Visible range a given anchor needs (6-row month grid + buffer for
// week-view navigation within the anchor month).
function visibleRangeForAnchor(anchor: Date): { start: Date; end: Date } {
  const som = startOfMonth(anchor);
  const start = addDays(som, -7);
  const end = addDays(som, 7 * 7);
  return { start, end };
}

// What we actually fetch — much wider than visibleRange, so navigating
// ±2 months stays inside the already-loaded buffer.
function fetchRangeForAnchor(anchor: Date): { start: Date; end: Date } {
  const som = startOfMonth(anchor);
  const start = addDays(som, -7 * 12);
  const end = addDays(som, 7 * 20);
  return { start, end };
}

export function useStore(
  anchor: Date,
  initialUi: UiSettings,
  mergeCriteria: MergeCriteria,
): Store {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [accounts, setAccounts] = useState<AccountSummary[]>([]);
  const [calendars, setCalendars] = useState<CalendarSummary[]>([]);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [accountsActive, setAccountsActiveState] =
    useState<Record<string, boolean>>(() => ({ ...initialUi.accountsActive }));
  const [calVisible, setCalVisibleState] =
    useState<Record<string, boolean>>(() => ({ ...initialUi.calVisible }));
  const [weatherUrl, setWeatherUrlState] = useState<string | null>(null);
  const [weatherDays, setWeatherDays] = useState<WeatherDay[]>([]);
  const [weatherError, setWeatherError] = useState<string | null>(null);

  const setAccountActive = useCallback((id: string, on: boolean) => {
    setAccountsActiveState((prev) => ({ ...prev, [id]: on }));
  }, []);
  const setCalVisible = useCallback((id: string, on: boolean) => {
    setCalVisibleState((prev) => ({ ...prev, [id]: on }));
  }, []);
  const toggleCal = useCallback(
    (id: string) => setCalVisibleState((prev) => ({ ...prev, [id]: !prev[id] })),
    [],
  );
  const toggleAccount = useCallback(
    (id: string) => setAccountsActiveState((prev) => ({ ...prev, [id]: !prev[id] })),
    [],
  );

  const refreshAccounts = useCallback(async () => {
    const list = await window.ycal.listAccounts();
    setAccounts(list);
    setAccountsActiveState((prev) => {
      const next: Record<string, boolean> = {};
      for (const a of list) next[a.id] = prev[a.id] ?? true;
      return next;
    });
  }, []);

  const refreshCalendars = useCallback(async () => {
    setLoading(true);
    try {
      const res = await window.ycal.listCalendars();
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setCalendars(res.calendars);
      setCalVisibleState((prev) => {
        const next: Record<string, boolean> = {};
        for (const c of res.calendars) {
          const k = calKey(c.accountId, c.id);
          next[k] = prev[k] ?? c.selected;
        }
        return next;
      });
      setError(null);
    } finally {
      setLoading(false);
    }
  }, []);

  // Track the timestamp window currently held in `events` so we can skip the
  // network round-trip when the requested window is already covered.
  const fetchedRangeRef = useRef<{ start: number; end: number } | null>(null);

  const inFlightRef = useRef(false);

  const fetchRange = useCallback(async (
    startTs: number, endTs: number, force: boolean,
  ): Promise<void> => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setLoading(true);
    try {
      const res = await window.ycal.listEvents({
        timeMin: new Date(startTs).toISOString(),
        timeMax: new Date(endTs).toISOString(),
        force,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      fetchedRangeRef.current = { start: startTs, end: endTs };
      setEvents(res.events);
      setError(null);
    } finally {
      setLoading(false);
      inFlightRef.current = false;
    }
  }, []);

  const loadEventsForRange = useCallback(async (start: Date, end: Date) => {
    const startTs = new Date(start.getFullYear(), start.getMonth(), start.getDate()).getTime();
    const endTs = new Date(end.getFullYear(), end.getMonth(), end.getDate()).getTime();
    const cached = fetchedRangeRef.current;
    if (cached && startTs >= cached.start && endTs <= cached.end) {
      return;
    }
    await fetchRange(startTs, endTs, false);
  }, [fetchRange]);

  const refreshEvents = useCallback(async () => {
    const cached = fetchedRangeRef.current;
    if (!cached) return;
    await fetchRange(cached.start, cached.end, true);
  }, [fetchRange]);

  const signIn = useCallback(async () => {
    const res = await window.ycal.addAccount();
    if (!res.ok) return { ok: false, error: res.error };
    await refreshAccounts();
    await refreshCalendars();
    return { ok: true };
  }, [refreshAccounts, refreshCalendars]);

  const signOut = useCallback(async (id: string) => {
    await window.ycal.removeAccount(id);
    await refreshAccounts();
    await refreshCalendars();
  }, [refreshAccounts, refreshCalendars]);

  const refreshWeather = useCallback(async () => {
    const res = await window.ycal.getWeather();
    if (!res.ok) {
      setWeatherError(res.error);
      setWeatherDays([]);
      return;
    }
    setWeatherError(null);
    setWeatherDays(res.days);
  }, []);

  const updateWeatherUrl = useCallback(async (url: string | null) => {
    const res = await window.ycal.setWeatherUrl(url);
    if (!res.ok) {
      throw new Error(res.error);
    }
    setWeatherUrlState(url);
    if (url) {
      await refreshWeather();
    } else {
      setWeatherDays([]);
      setWeatherError(null);
    }
  }, [refreshWeather]);

  // Stable ref to the live accounts list so applyRemoteUi can sanity-check
  // the incoming payload without recreating the callback (which would
  // re-run App.tsx's onSettingsChanged subscription on every refreshAccounts).
  const accountsRef = useRef<AccountSummary[]>([]);
  useEffect(() => { accountsRef.current = accounts; }, [accounts]);

  const applyRemoteUi = useCallback((ui: UiSettings) => {
    // Defensive: if the incoming map is empty but the user has accounts
    // signed in, the remote payload is almost certainly the result of a
    // transient iCloud read failure (settings.json briefly unreadable
    // mid-sync — main falls back to empty defaults). Wholesale-replacing
    // would hide every event until next restart; ignore instead.
    const incomingAccounts = Object.keys(ui.accountsActive).length;
    if (incomingAccounts === 0 && accountsRef.current.length > 0) return;
    // Otherwise replace the visibility maps wholesale — Mac A's view of
    // which accounts/calendars are active is the truth, and a partial
    // merge would leave stale toggles around if Mac A explicitly turned
    // one off.
    setAccountsActiveState({ ...ui.accountsActive });
    setCalVisibleState({ ...ui.calVisible });
  }, []);

  const applyRemoteWeatherUrl = useCallback((url: string | null) => {
    setWeatherUrlState(url);
    // Don't refetch weather here — the App-level effect that watches
    // weatherUrl already does that, and it'd race with the upstream
    // refresh otherwise.
  }, []);

  // First-load: configured? then accounts → calendars → events.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const ok = await window.ycal.isConfigured();
      if (cancelled) return;
      setConfigured(ok);
      if (!ok) return;
      await refreshAccounts();
      await refreshCalendars();
      const url = await window.ycal.getWeatherUrl();
      if (cancelled) return;
      setWeatherUrlState(url);
      if (url) await refreshWeather();
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshAccounts, refreshCalendars, refreshWeather]);

  // Re-fetch events when the anchor moves outside the cached window or accounts
  // change. The cache check inside loadEventsForRange short-circuits when the
  // visible window is already covered, so consecutive month navs are free.
  useEffect(() => {
    if (configured === false) return;
    if (accounts.length === 0) {
      setEvents([]);
      fetchedRangeRef.current = null;
      return;
    }
    const visible = visibleRangeForAnchor(anchor);
    const visStart = new Date(visible.start.getFullYear(), visible.start.getMonth(), visible.start.getDate()).getTime();
    const visEnd = new Date(visible.end.getFullYear(), visible.end.getMonth(), visible.end.getDate()).getTime();
    const cached = fetchedRangeRef.current;
    if (cached && visStart >= cached.start && visEnd <= cached.end) {
      return;
    }
    const fetchRange = fetchRangeForAnchor(anchor);
    void loadEventsForRange(fetchRange.start, fetchRange.end);
  }, [
    configured,
    accounts.length,
    fmtDate(startOfMonth(anchor)),
    loadEventsForRange,
  ]);

  // Filter events by visibility, then collapse cross-calendar duplicates.
  const visibleEvents = useMemo(() => {
    const filtered = events.filter((e) => {
      if (!accountsActive[e.accountId]) return false;
      if (!calVisible[calKey(e.accountId, e.calendarId)]) return false;
      return true;
    });
    return dedupEvents(filtered, calendars, mergeCriteria);
  }, [events, accountsActive, calVisible, calendars, mergeCriteria]);

  return {
    configured,
    accounts,
    calendars,
    events: visibleEvents,
    loading,
    error,
    accountsActive,
    calVisible,
    setAccountActive,
    setCalVisible,
    toggleCal,
    toggleAccount,
    refreshAccounts,
    refreshCalendars,
    loadEventsForRange,
    refreshEvents,
    signIn,
    signOut,
    weatherUrl,
    weatherDays,
    weatherError,
    setWeatherUrl: updateWeatherUrl,
    applyRemoteUi,
    applyRemoteWeatherUrl,
  };
}
