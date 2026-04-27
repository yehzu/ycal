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
import { dedupEvents } from './dedup';

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
  signIn: () => Promise<{ ok: boolean; error?: string }>;
  signOut: (id: string) => Promise<void>;

  weatherUrl: string | null;
  weatherDays: WeatherDay[];
  weatherError: string | null;
  setWeatherUrl: (url: string | null) => Promise<void>;
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

  const loadEventsForRange = useCallback(async (start: Date, end: Date) => {
    const startTs = new Date(start.getFullYear(), start.getMonth(), start.getDate()).getTime();
    const endTs = new Date(end.getFullYear(), end.getMonth(), end.getDate()).getTime();
    const cached = fetchedRangeRef.current;
    if (cached && startTs >= cached.start && endTs <= cached.end) {
      return;
    }
    setLoading(true);
    try {
      const res = await window.ycal.listEvents({
        timeMin: new Date(startTs).toISOString(),
        timeMax: new Date(endTs).toISOString(),
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
    }
  }, []);

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
    signIn,
    signOut,
    weatherUrl,
    weatherDays,
    weatherError,
    setWeatherUrl: updateWeatherUrl,
  };
}
