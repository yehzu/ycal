import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  CalendarEvent, CloudStorageInfo, DriveSyncStatus, LoadBands, LoadWindowSettings,
  MergeCriteria, RhythmData, TempUnits, ThemeMode, UiSettings,
} from '@shared/types';
import {
  DEFAULT_LOAD_BANDS, DEFAULT_LOAD_WINDOW, DEFAULT_MERGE_CRITERIA,
} from '@shared/types';
import { addDays, addMonths, startOfMonth, startOfWeek } from './dates';
import { useStore } from './store';
import { useTasks } from './tasks';
import type { CalRole, CalRoles } from './calRoles';
import { MacTitleBar } from './components/MacTitleBar';
import { AccountPicker } from './components/AccountPicker';
import { Sidebar, type SidebarSectionKey } from './components/Sidebar';
import { MainToolbar, type ViewMode } from './components/MainToolbar';
import { MonthGrid } from './components/MonthGrid';
import { TimeView } from './components/TimeView';
import { DayDetailPanel } from './components/DayDetailPanel';
import { EventPopover } from './components/EventPopover';
import { DayEventsModal } from './components/DayEventsModal';
import { SettingsModal } from './components/SettingsModal';
import { UpdateOverlay } from './components/UpdateOverlay';
import { TasksPanel, TasksEdgeTab } from './components/TasksPanel';
import { TaskSheet } from './components/TaskSheet';
import { SearchPalette } from './components/SearchPalette';
import { isFullyReadOnlyEvent, presentForVisibleCalendars } from './calRoles';

const DEFAULT_SECTION_ORDER: SidebarSectionKey[] = [
  'almanac', 'agenda', 'calendars',
];

const DEFAULT_UI: UiSettings = {
  accountsActive: {},
  calVisible: {},
  calRoles: {},
  sectionOrder: DEFAULT_SECTION_ORDER,
  mergeCriteria: DEFAULT_MERGE_CRITERIA,
  showWeekNums: true,
  showWeather: true,
  units: 'F',
};

// Boot waits for persisted UI settings to load before mounting AppShell so
// state initializers see the saved values, not defaults.
export function App() {
  const [initialUi, setInitialUi] = useState<UiSettings | null>(null);
  useEffect(() => {
    let cancelled = false;
    void window.ycal.getUiSettings().then((ui) => {
      if (cancelled) return;
      setInitialUi({ ...DEFAULT_UI, ...ui });
    });
    return () => { cancelled = true; };
  }, []);
  if (!initialUi) return null;
  return <AppShell initialUi={initialUi} />;
}

function AppShell({ initialUi }: { initialUi: UiSettings }) {
  // `today` keeps a stable reference across renders so prop equality holds for
  // memoized children. We refresh it every minute (and on day rollover the
  // value naturally advances) — cheap, but no longer churns every keystroke.
  const [today, setToday] = useState<Date>(() => new Date());
  useEffect(() => {
    const tick = () => {
      const next = new Date();
      setToday((prev) => (
        prev.getFullYear() === next.getFullYear()
          && prev.getMonth() === next.getMonth()
          && prev.getDate() === next.getDate()
          && prev.getHours() === next.getHours()
          && prev.getMinutes() === next.getMinutes()
          ? prev
          : next
      ));
    };
    const id = window.setInterval(tick, 60_000);
    return () => window.clearInterval(id);
  }, []);
  const [anchor, setAnchor] = useState<Date>(() => new Date());
  const [selected, setSelected] = useState<Date>(() => new Date());
  const [view, setView] = useState<ViewMode>('month');
  const [acctPickerOpen, setAcctPickerOpen] = useState(false);
  const [popover, setPopover] = useState<
    { event: CalendarEvent; rect: DOMRect } | null
  >(null);
  const [signInError, setSignInError] = useState<string | null>(null);
  const [calRoles, setCalRoles] = useState<CalRoles>(() => ({ ...initialUi.calRoles }));
  // Filter out the now-removed 'forecast' section from any older saved orders,
  // then top-up with the canonical defaults so newly added sections still appear.
  const [sectionOrder, setSectionOrder] = useState<SidebarSectionKey[]>(() => {
    const allowed = new Set<SidebarSectionKey>(DEFAULT_SECTION_ORDER);
    const cleaned = (initialUi.sectionOrder as SidebarSectionKey[])
      .filter((s) => allowed.has(s));
    for (const s of DEFAULT_SECTION_ORDER) {
      if (!cleaned.includes(s)) cleaned.push(s);
    }
    return cleaned.length === DEFAULT_SECTION_ORDER.length ? cleaned : DEFAULT_SECTION_ORDER;
  });
  const [hideReadOnly, setHideReadOnly] = useState(false);
  const [hideDisabledCals, setHideDisabledCals] = useState<boolean>(
    () => initialUi.hideDisabledCals ?? false,
  );
  const [dayModal, setDayModal] = useState<Date | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mergeCriteria, setMergeCriteria] = useState<MergeCriteria>(() => ({
    ...DEFAULT_MERGE_CRITERIA,
    ...(initialUi.mergeCriteria ?? {}),
  }));
  const [showWeekNums, setShowWeekNums] = useState<boolean>(
    () => initialUi.showWeekNums ?? true,
  );
  const [showWeather, setShowWeather] = useState<boolean>(
    () => initialUi.showWeather ?? true,
  );
  const [units, setUnits] = useState<TempUnits>(
    () => initialUi.units ?? 'F',
  );
  const [autoRolloverPastTasks, setAutoRolloverPastTasks] = useState<boolean>(
    () => initialUi.autoRolloverPastTasks ?? true,
  );
  const [loadWindow, setLoadWindow] = useState<LoadWindowSettings>(
    () => ({ ...DEFAULT_LOAD_WINDOW, ...(initialUi.loadWindow ?? {}) }),
  );
  const [loadBands, setLoadBands] = useState<LoadBands>(
    () => ({ ...DEFAULT_LOAD_BANDS, ...(initialUi.loadBands ?? {}) }),
  );
  const [customTagSuggestions, setCustomTagSuggestions] = useState<string[]>(
    () => initialUi.customTagSuggestions ?? [],
  );
  const [theme, setTheme] = useState<ThemeMode>(
    () => initialUi.theme ?? 'system',
  );

  // Resolve theme → data-theme attribute on <html>. 'system' tracks
  // prefers-color-scheme so the OS appearance leads.
  useEffect(() => {
    const root = document.documentElement;
    const apply = () => {
      const resolved = theme === 'system'
        ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
        : theme;
      root.setAttribute('data-theme', resolved);
    };
    apply();
    if (theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [theme]);

  const setCalRole = useCallback((key: string, role: CalRole) => {
    setCalRoles((prev) => ({ ...prev, [key]: role }));
  }, []);

  const store = useStore(anchor, initialUi, mergeCriteria);
  const tasks = useTasks(today, autoRolloverPastTasks);

  // ── Tasks panel + sheet state ─────────────────────────────────────
  const [tasksOpenWeek, setTasksOpenWeek] = useState(true);
  const [tasksOpenDay, setTasksOpenDay] = useState(false);
  const tasksOpen = view === 'day' ? tasksOpenDay : tasksOpenWeek;
  const setTasksOpen = useCallback((next: boolean | ((prev: boolean) => boolean)) => {
    if (view === 'day') {
      setTasksOpenDay((prev) => typeof next === 'function' ? next(prev) : next);
    } else {
      setTasksOpenWeek((prev) => typeof next === 'function' ? next(prev) : next);
    }
  }, [view]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const selectedTask = useMemo(
    () => tasks.tasks.find((t) => t.id === selectedTaskId) ?? null,
    [tasks.tasks, selectedTaskId],
  );
  const selectedSubtasks = useMemo(
    () => (selectedTask
      ? tasks.tasks.filter((t) => t.parentId === selectedTask.id)
      : []),
    [tasks.tasks, selectedTask],
  );

  // ── Day rhythm + cloud storage state ──────────────────────────────
  const [rhythmData, setRhythmData] = useState<RhythmData | null>(null);
  const [cloudStorage, setCloudStorageInfo] = useState<CloudStorageInfo | null>(null);
  const [driveSync, setDriveSync] = useState<DriveSyncStatus | null>(null);

  useEffect(() => {
    void window.ycal.rhythmGet().then(setRhythmData);
    void window.ycal.cloudGetStorageInfo().then(setCloudStorageInfo);
    void window.ycal.driveSyncGetStatus().then(setDriveSync);
  }, []);

  useEffect(() => {
    const off = window.ycal.onDriveSyncStatusChanged(setDriveSync);
    return off;
  }, []);

  // Cross-device sync: live-apply remote rhythm + settings edits. The
  // file watcher in main runs at ~1.5s polling — that's the worst-case
  // cross-Mac latency on top of iCloud Drive's own delivery window
  // (typically a few seconds while both Macs are awake).
  useEffect(() => {
    const off = window.ycal.onRhythmChanged((data) => setRhythmData(data));
    return off;
  }, []);
  useEffect(() => {
    const off = window.ycal.onSettingsChanged((next) => {
      // Apply every slice the renderer owns. The auto-save effect below
      // will fire from these state changes — that write is content-
      // deduped at cloudStore so it round-trips as a no-op rather than
      // looping us back through the watcher.
      const ui = { ...DEFAULT_UI, ...next.ui };
      setShowWeekNums(ui.showWeekNums ?? true);
      setShowWeather(ui.showWeather ?? true);
      setUnits(ui.units ?? 'F');
      setMergeCriteria({ ...DEFAULT_MERGE_CRITERIA, ...(ui.mergeCriteria ?? {}) });
      setCalRoles({ ...ui.calRoles });
      setSectionOrder((ui.sectionOrder as SidebarSectionKey[]) ?? DEFAULT_SECTION_ORDER);
      setHideDisabledCals(ui.hideDisabledCals ?? false);
      setAutoRolloverPastTasks(ui.autoRolloverPastTasks ?? true);
      setLoadWindow({ ...DEFAULT_LOAD_WINDOW, ...(ui.loadWindow ?? {}) });
      setLoadBands({ ...DEFAULT_LOAD_BANDS, ...(ui.loadBands ?? {}) });
      setCustomTagSuggestions(ui.customTagSuggestions ?? []);
      setTheme(ui.theme ?? 'system');
      // Slices owned by the events store (account / calendar visibility,
      // weather URL) need explicit imperative setters — they're not
      // react state in App.
      store.applyRemoteUi(ui);
      store.applyRemoteWeatherUrl(next.weatherIcsUrl);
    });
    return off;
  }, [store]);

  const setRhythmOverride = useCallback(async (
    dateStr: string, patch: { wakeMin?: number; sleepMin?: number },
  ) => {
    const res = await window.ycal.rhythmSetOverride(dateStr, patch);
    if (res.ok) setRhythmData(res.data);
  }, []);
  const clearRhythmOverride = useCallback(async (dateStr: string) => {
    const res = await window.ycal.rhythmClearOverride(dateStr);
    if (res.ok) setRhythmData(res.data);
  }, []);
  const setRhythmDefault = useCallback(async (
    fromDateStr: string, next: { wakeMin: number; sleepMin: number },
  ) => {
    const res = await window.ycal.rhythmSetDefault(fromDateStr, next);
    if (res.ok) setRhythmData(res.data);
  }, []);
  const setCloudStorage = useCallback(async (pref: 'icloud' | 'local') => {
    const res = await window.ycal.cloudSetStorage(pref);
    if (res.ok) {
      setCloudStorageInfo(res.info);
      // Files moved — re-read both rhythm and tasks-local from new location.
      const data = await window.ycal.rhythmGet();
      setRhythmData(data);
      // The tasks store internally re-fetches via its own hooks on next
      // refresh; trigger one so the panel reflects the move.
      void tasks.refresh();
    }
  }, []);

  // ── Drive sync action callbacks ────────────────────────────────────
  const setDriveSyncEnabled = useCallback(async (v: boolean) => {
    const next = await window.ycal.driveSyncSetEnabled(v);
    setDriveSync(next);
  }, []);
  const setDriveSyncAccount = useCallback(async (accountId: string | null) => {
    const next = await window.ycal.driveSyncSetAccount(accountId);
    setDriveSync(next);
  }, []);
  const driveSyncPushNow = useCallback(async () => {
    const res = await window.ycal.driveSyncPushNow();
    if (res.ok) setDriveSync(res.status);
  }, []);
  const driveSyncPullNow = useCallback(async () => {
    const res = await window.ycal.driveSyncPullNow();
    if (res.ok) {
      setDriveSync(res.status);
      // A successful pull may have rewritten rhythm.json / settings.json on
      // disk; the cloudStore watcher already broadcasts SettingsChanged /
      // RhythmChanged for those, but explicitly re-pull tasks-local since
      // its push channel is keyed off TasksLocalChanged.
      void tasks.refresh();
      const data = await window.ycal.rhythmGet();
      setRhythmData(data);
    }
  }, []);

  // Effective event list — drop read-only/subscribed entries when the master
  // toggle is on. Other filters (account / calendar visibility) live in store.
  // A merged event survives if any of its sources is on a non-read-only
  // calendar (dedup may have picked the read-only side as canonical); when it
  // does survive, we re-canonicalize against the visible writable source so it
  // doesn't render with the hidden read-only calendar's color/link.
  const visibleEvents = useMemo(() => {
    if (!hideReadOnly) return store.events;
    const out: CalendarEvent[] = [];
    for (const e of store.events) {
      if (isFullyReadOnlyEvent(e, calRoles)) continue;
      out.push(presentForVisibleCalendars(e, calRoles));
    }
    return out;
  }, [store.events, hideReadOnly, calRoles]);

  // Persist the four UI slices on change. Skip the initial render so we
  // don't redundantly write the just-loaded values back to disk.
  const firstSave = useRef(true);
  useEffect(() => {
    if (firstSave.current) { firstSave.current = false; return; }
    void window.ycal.setUiSettings({
      accountsActive: store.accountsActive,
      calVisible: store.calVisible,
      calRoles,
      sectionOrder,
      mergeCriteria,
      showWeekNums,
      showWeather,
      units,
      hideDisabledCals,
      autoRolloverPastTasks,
      loadWindow,
      loadBands,
      customTagSuggestions,
      theme,
    });
  }, [
    store.accountsActive, store.calVisible, calRoles, sectionOrder,
    mergeCriteria, showWeekNums, showWeather, units, hideDisabledCals,
    autoRolloverPastTasks, loadWindow, loadBands, customTagSuggestions, theme,
  ]);

  const goToDayView = useCallback((d: Date) => {
    setAnchor(d);
    setSelected(d);
    setView('day');
  }, []);

  const goToToday = useCallback(() => {
    const now = new Date();
    setAnchor(now);
    setSelected(now);
  }, []);

  // Pull fresh events when the user comes back to the window and on a slow
  // 5-minute poll. Without this, a Google Calendar edit made elsewhere never
  // appears in an open yCal session — the renderer's fetchedRangeRef thinks
  // the visible window is already covered and short-circuits.
  // A simple timestamp throttle prevents focus + visibilitychange + interval
  // from stacking redundant fetches when several fire in quick succession.
  const lastRefreshRef = useRef(0);
  const REFRESH_THROTTLE_MS = 30_000;
  const refreshEvents = store.refreshEvents;
  useEffect(() => {
    const tryRefresh = () => {
      const now = Date.now();
      if (now - lastRefreshRef.current < REFRESH_THROTTLE_MS) return;
      lastRefreshRef.current = now;
      void refreshEvents();
    };
    const onFocus = () => tryRefresh();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') tryRefresh();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    const id = window.setInterval(tryRefresh, 5 * 60_000);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
      window.clearInterval(id);
    };
  }, [refreshEvents]);

  // Browser-style back/forward across (anchor, selected, view) snapshots.
  // The effect below detects user-initiated changes and pushes the previous
  // snapshot onto `back`; navigateHistory itself flips a flag so its own
  // restore does not re-enter the stack.
  type NavSnap = { anchor: Date; selected: Date; view: ViewMode };
  const historyRef = useRef<{ back: NavSnap[]; forward: NavSnap[] }>({
    back: [], forward: [],
  });
  const lastSnapRef = useRef<NavSnap>({ anchor, selected, view });
  const navigatingRef = useRef(false);
  const sameSnap = (a: NavSnap, b: NavSnap) =>
    a.view === b.view
    && a.anchor.getTime() === b.anchor.getTime()
    && a.selected.getTime() === b.selected.getTime();

  useEffect(() => {
    const next: NavSnap = { anchor, selected, view };
    if (navigatingRef.current) {
      navigatingRef.current = false;
    } else if (!sameSnap(lastSnapRef.current, next)) {
      historyRef.current.back.push(lastSnapRef.current);
      if (historyRef.current.back.length > 100) historyRef.current.back.shift();
      historyRef.current.forward = [];
    }
    lastSnapRef.current = next;
  }, [anchor, selected, view]);

  const navigateHistory = useCallback((dir: -1 | 1) => {
    const h = historyRef.current;
    const stack = dir === -1 ? h.back : h.forward;
    if (stack.length === 0) return;
    const target = stack.pop()!;
    (dir === -1 ? h.forward : h.back).push(lastSnapRef.current);
    navigatingRef.current = true;
    setAnchor(target.anchor);
    setSelected(target.selected);
    setView(target.view);
  }, []);

  // Move the selected day by `dx` days; pull anchor along only when the new
  // selection leaves the current view's visible window (otherwise stay put so
  // the user can roam across an other-month cell without flipping the page).
  const moveSelection = useCallback((dx: number) => {
    setSelected((sel) => {
      const next = addDays(sel, dx);
      setAnchor((a) => {
        if (view === 'month') {
          const gridStart = startOfWeek(startOfMonth(a), 0);
          const gridEnd = addDays(gridStart, 42);
          if (next.getTime() < gridStart.getTime() || next.getTime() >= gridEnd.getTime()) {
            return next;
          }
          return a;
        }
        if (view === 'week') {
          const ws = startOfWeek(a, 0);
          const we = addDays(ws, 7);
          if (next.getTime() < ws.getTime() || next.getTime() >= we.getTime()) {
            return next;
          }
          return a;
        }
        return next;
      });
      return next;
    });
  }, [view]);

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const target = ev.target as HTMLElement | null;
      if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA') return;
      // Cmd/Ctrl+, opens Settings — handle before the modifier early-return.
      if ((ev.metaKey || ev.ctrlKey) && ev.key === ',' && !ev.altKey && !ev.shiftKey) {
        ev.preventDefault();
        setSettingsOpen(true);
        return;
      }
      // Cmd/Ctrl+K opens the search palette from anywhere — also handle
      // before the modifier guard. Toggles when already open.
      if ((ev.metaKey || ev.ctrlKey) && (ev.key === 'k' || ev.key === 'K')
          && !ev.altKey && !ev.shiftKey) {
        ev.preventDefault();
        setSearchOpen((o) => !o);
        return;
      }
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
      if (searchOpen) {
        // SearchPalette owns its own keyboard handling once focused; here we
        // just need to keep global shortcuts (j/k/l/Esc-the-popover) from
        // stealing keystrokes meant for the search input.
        return;
      }
      if (settingsOpen) {
        if (ev.key === 'Escape') setSettingsOpen(false);
        return;
      }
      if (popover) {
        if (ev.key === 'Escape') setPopover(null);
        return;
      }
      if (dayModal) {
        if (ev.key === 'Escape') setDayModal(null);
        return;
      }
      const stepAnchor = (dir: -1 | 1) => {
        setAnchor((a) =>
          view === 'month' ? addMonths(a, dir)
          : view === 'week' ? addDays(a, 7 * dir)
          : addDays(a, dir),
        );
      };
      // Treat single-character shortcuts as case-insensitive: pressing
      // Caps-Lock or holding Shift shouldn't break navigation. Multi-char
      // keys like 'Escape' / 'ArrowLeft' pass through unchanged.
      const k = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key;
      if (k === 'ArrowLeft' || k === 'u') {
        ev.preventDefault();
        stepAnchor(-1);
      } else if (k === 'ArrowRight' || k === 'i') {
        ev.preventDefault();
        stepAnchor(1);
      } else if (k === 'h') {
        ev.preventDefault();
        moveSelection(-1);
      } else if (k === 'l') {
        ev.preventDefault();
        moveSelection(1);
      } else if (k === 'j') {
        ev.preventDefault();
        moveSelection(7);
      } else if (k === 'k') {
        ev.preventDefault();
        moveSelection(-7);
      } else if (k === ' ' && target?.tagName !== 'BUTTON') {
        ev.preventDefault();
        setDayModal(selected);
      } else if (k === 's') {
        ev.preventDefault();
        setView('month');
      } else if (k === 'd') {
        ev.preventDefault();
        setView('week');
      } else if (k === 'f') {
        ev.preventDefault();
        setView('day');
      } else if (k === 't') {
        goToToday();
      } else if (ev.key === 'T') {
        // Capital T (Shift+T) toggles the tasks rail. We branch on raw key
        // here because the lower-cased `k` collapses Shift+T into "t" and
        // would steal the "go to today" binding above.
        if (view === 'week' || view === 'day') {
          ev.preventDefault();
          setTasksOpen((o) => !o);
        }
      } else if (k === 'w') {
        ev.preventDefault();
        setHideReadOnly((v) => !v);
      } else if (k === 'e') {
        ev.preventDefault();
        setHideDisabledCals((v) => !v);
      } else if (k === 'Escape') {
        setAcctPickerOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [view, popover, dayModal, settingsOpen, searchOpen, selected, goToToday, moveSelection, setTasksOpen]);

  // Mouse buttons 3 (XBUTTON1 / Back) and 4 (XBUTTON2 / Forward) navigate
  // the per-app history stack. Suppress on mousedown too — Electron would
  // otherwise propagate them as browser-style history events.
  useEffect(() => {
    const onMouseDown = (ev: MouseEvent) => {
      if (ev.button === 3) { ev.preventDefault(); navigateHistory(-1); }
      else if (ev.button === 4) { ev.preventDefault(); navigateHistory(1); }
    };
    const onMouseUp = (ev: MouseEvent) => {
      if (ev.button === 3 || ev.button === 4) ev.preventDefault();
    };
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [navigateHistory]);

  // Capture the anchor's viewport rect synchronously — by the time
  // EventPopover runs its layout effect, the anchor element may have
  // unmounted (e.g. when clicked inside DayEventsModal, which closes
  // first). A rect is positionally stable; an HTMLElement is not.
  const onEventClick = useCallback((event: CalendarEvent, anchorEl: HTMLElement) => {
    setPopover({ event, rect: anchorEl.getBoundingClientRect() });
  }, []);

  // Picking an event from the search palette doesn't have a real DOM
  // anchor (the row that triggered the pick is about to unmount with the
  // palette). Synthesise a small rect at the top-center of the window so
  // the popover lays itself out below it without flying offscreen.
  const onPickSearchEvent = useCallback((event: CalendarEvent) => {
    const dateOnly = event.start.slice(0, 10);
    const d = new Date(dateOnly + 'T00:00:00');
    if (!Number.isNaN(d.getTime())) {
      setAnchor(d);
      setSelected(d);
      if (view === 'month') setView('day');
    }
    const rect = new DOMRect(window.innerWidth / 2 - 1, 96, 2, 2);
    setPopover({ event, rect });
  }, [view]);

  const openDayModal = useCallback((d: Date) => setDayModal(d), []);

  const handleSignIn = async () => {
    setSignInError(null);
    const res = await store.signIn();
    if (!res.ok) setSignInError(res.error ?? 'Sign-in failed.');
    setAcctPickerOpen(false);
  };

  const weekDays = useMemo(() => {
    const ws = startOfWeek(anchor, 0);
    return Array.from({ length: 7 }, (_, i) => addDays(ws, i));
  }, [anchor.getFullYear(), anchor.getMonth(), anchor.getDate()]);

  const activeCount = Object.values(store.accountsActive).filter(Boolean).length;

  return (
    <div className="desktop">
      <div className="mac-window">
        <MacTitleBar
          today={today}
          accounts={store.accounts}
          accountsActive={store.accountsActive}
          onPickerOpen={() => setAcctPickerOpen((o) => !o)}
        />

        {store.configured === false && (
          <ConfigBanner />
        )}
        {signInError && (
          <div style={{
            padding: '8px 22px',
            fontFamily: 'var(--serif-body)',
            fontSize: 12,
            color: '#d50000',
            background: '#f4ede0',
            borderBottom: '0.5px solid var(--rule)',
          }}>
            Sign-in error: {signInError}
          </div>
        )}
        {store.error && (
          <div style={{
            padding: '8px 22px',
            fontFamily: 'var(--serif-body)',
            fontSize: 12,
            color: '#d50000',
            background: '#f4ede0',
            borderBottom: '0.5px solid var(--rule)',
          }}>
            {store.error}
          </div>
        )}

        <div className="app">
          <Sidebar
            today={today}
            anchor={anchor}
            selected={selected}
            setAnchor={setAnchor}
            setSelected={setSelected}
            accounts={store.accounts}
            accountsActive={store.accountsActive}
            calendars={store.calendars}
            calVisible={store.calVisible}
            toggleCal={store.toggleCal}
            calRoles={calRoles}
            setCalRole={setCalRole}
            sectionOrder={sectionOrder}
            setSectionOrder={setSectionOrder}
            events={visibleEvents}
            hideReadOnly={hideReadOnly}
            setHideReadOnly={setHideReadOnly}
            hideDisabledCals={hideDisabledCals}
            setHideDisabledCals={setHideDisabledCals}
            showWeekNums={showWeekNums}
          />

          <main className="main">
            <MainToolbar
              view={view}
              setView={setView}
              anchor={anchor}
              setAnchor={setAnchor}
              goToToday={goToToday}
              loading={store.loading}
              onOpenSettings={() => setSettingsOpen(true)}
              onOpenSearch={() => setSearchOpen(true)}
            />

            {store.accounts.length === 0 ? (
              <EmptyState onSignIn={handleSignIn} configured={store.configured ?? true} />
            ) : view === 'month' ? (
              <MonthGrid
                today={today}
                anchor={anchor}
                selected={selected}
                setSelected={setSelected}
                setAnchor={setAnchor}
                events={visibleEvents}
                calRoles={calRoles}
                goToDayView={goToDayView}
                onEventClick={onEventClick}
                openDayModal={openDayModal}
                showWeekNums={showWeekNums}
                showWeather={showWeather}
                units={units}
                weatherDays={store.weatherDays}
                tasks={tasks.tasks}
                scheduledById={tasks.scheduledById}
                rhythmData={rhythmData}
                loadWindow={loadWindow}
                loadBands={loadBands}
              />
            ) : view === 'week' ? (
              <div className="tv-with-tasks">
                <TimeView
                  today={today}
                  days={weekDays}
                  events={visibleEvents}
                  calRoles={calRoles}
                  onEventClick={onEventClick}
                  showWeekNums={showWeekNums}
                  showWeather={showWeather}
                  units={units}
                  weatherDays={store.weatherDays}
                  tasks={tasks.tasks}
                  scheduledById={tasks.scheduledById}
                  onScheduleTask={tasks.scheduleTask}
                  onToggleTaskDone={tasks.toggleDone}
                  onOpenTask={setSelectedTaskId}
                  rhythmData={rhythmData}
                  onSetRhythmOverride={(d, p) => void setRhythmOverride(d, p)}
                  onClearRhythmOverride={(d) => void clearRhythmOverride(d)}
                  loadWindow={loadWindow}
                  loadBands={loadBands}
                />
                <TasksPanel
                  open={tasksOpen}
                  today={today}
                  tasks={tasks.inboxTasks}
                  projectOrder={tasks.projectOrder}
                  projectColor={tasks.projectColor}
                  projects={tasks.projects}
                  doneTodayCount={tasks.doneTodayIds.size}
                  carryoverIds={tasks.carryoverIds}
                  onClose={() => setTasksOpen(false)}
                  onUnschedule={(id) => void tasks.unscheduleTask(id)}
                  onToggleDone={(id) => void tasks.toggleDone(id)}
                  onOpenTask={setSelectedTaskId}
                  apiKeySet={!!tasks.provider?.hasCredentials}
                  loading={tasks.loading}
                  errorMessage={tasks.error}
                />
                {!tasksOpen && <TasksEdgeTab onOpen={() => setTasksOpen(true)} />}
              </div>
            ) : (
              <div className="day-view-layout">
                <TimeView
                  today={today}
                  days={[anchor]}
                  events={visibleEvents}
                  calRoles={calRoles}
                  onEventClick={onEventClick}
                  showWeekNums={showWeekNums}
                  showWeather={showWeather}
                  units={units}
                  weatherDays={store.weatherDays}
                  tasks={tasks.tasks}
                  scheduledById={tasks.scheduledById}
                  onScheduleTask={tasks.scheduleTask}
                  onToggleTaskDone={tasks.toggleDone}
                  onOpenTask={setSelectedTaskId}
                  rhythmData={rhythmData}
                  onSetRhythmOverride={(d, p) => void setRhythmOverride(d, p)}
                  onClearRhythmOverride={(d) => void clearRhythmOverride(d)}
                  loadWindow={loadWindow}
                  loadBands={loadBands}
                />
                <DayDetailPanel
                  date={anchor}
                  events={visibleEvents}
                  accounts={store.accounts}
                  calendars={store.calendars}
                  calRoles={calRoles}
                  onEventClick={onEventClick}
                  tasks={tasks.tasks}
                  scheduledById={tasks.scheduledById}
                  rhythmData={rhythmData}
                  loadWindow={loadWindow}
                  loadBands={loadBands}
                />
                <TasksPanel
                  open={tasksOpen}
                  today={today}
                  tasks={tasks.inboxTasks}
                  projectOrder={tasks.projectOrder}
                  projectColor={tasks.projectColor}
                  projects={tasks.projects}
                  doneTodayCount={tasks.doneTodayIds.size}
                  carryoverIds={tasks.carryoverIds}
                  onClose={() => setTasksOpen(false)}
                  onUnschedule={(id) => void tasks.unscheduleTask(id)}
                  onToggleDone={(id) => void tasks.toggleDone(id)}
                  onOpenTask={setSelectedTaskId}
                  apiKeySet={!!tasks.provider?.hasCredentials}
                  loading={tasks.loading}
                  errorMessage={tasks.error}
                />
                {!tasksOpen && <TasksEdgeTab onOpen={() => setTasksOpen(true)} />}
              </div>
            )}
          </main>
        </div>

        <footer className="app-foot">
          <span>
            <span className="sync-dot" />
            {activeCount} of {store.accounts.length}{' '}
            {store.accounts.length === 1 ? 'account' : 'accounts'} ·{' '}
            {store.events.length} events visible
            {store.loading ? ' · syncing…' : ''}
          </span>
          <span>{today.toDateString()}</span>
        </footer>

        <AccountPicker
          open={acctPickerOpen}
          accounts={store.accounts}
          active={store.accountsActive}
          onClose={() => setAcctPickerOpen(false)}
          onToggle={store.toggleAccount}
          onAdd={handleSignIn}
          onRemove={store.signOut}
        />
      </div>

      {popover && (
        <EventPopover
          event={popover.event}
          anchorRect={popover.rect}
          accounts={store.accounts}
          calendars={store.calendars}
          onClose={() => setPopover(null)}
        />
      )}

      <SearchPalette
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        events={visibleEvents}
        calendars={store.calendars}
        tasks={tasks.tasks}
        today={today}
        onPickEvent={onPickSearchEvent}
        onPickTask={(id) => setSelectedTaskId(id)}
      />

      {settingsOpen && (
        <SettingsModal
          onClose={() => setSettingsOpen(false)}
          showWeekNums={showWeekNums}
          setShowWeekNums={setShowWeekNums}
          mergeCriteria={mergeCriteria}
          setMergeCriteria={setMergeCriteria}
          theme={theme}
          setTheme={setTheme}
          showWeather={showWeather}
          setShowWeather={setShowWeather}
          units={units}
          setUnits={setUnits}
          weatherUrl={store.weatherUrl}
          setWeatherUrl={store.setWeatherUrl}
          weatherError={store.weatherError}
          accounts={store.accounts}
          accountsActive={store.accountsActive}
          toggleAccount={store.toggleAccount}
          calendars={store.calendars}
          calVisible={store.calVisible}
          toggleCal={store.toggleCal}
          calRoles={calRoles}
          setCalRole={setCalRole}
          onAddAccount={handleSignIn}
          onRemoveAccount={store.signOut}
          taskProvider={tasks.provider}
          taskProviders={tasks.providers}
          setActiveTaskProvider={tasks.setActiveProvider}
          setTaskCredentials={tasks.setCredentials}
          refreshTasks={tasks.refresh}
          autoRolloverPastTasks={autoRolloverPastTasks}
          setAutoRolloverPastTasks={setAutoRolloverPastTasks}
          loadWindow={loadWindow}
          setLoadWindow={setLoadWindow}
          loadBands={loadBands}
          setLoadBands={setLoadBands}
          customTagSuggestions={customTagSuggestions}
          setCustomTagSuggestions={setCustomTagSuggestions}
          rhythmData={rhythmData}
          setRhythmDefault={setRhythmDefault}
          cloudStorage={cloudStorage}
          setCloudStorage={setCloudStorage}
          driveSync={driveSync}
          setDriveSyncEnabled={setDriveSyncEnabled}
          setDriveSyncAccount={setDriveSyncAccount}
          driveSyncPushNow={driveSyncPushNow}
          driveSyncPullNow={driveSyncPullNow}
        />
      )}

      {selectedTask && (
        <TaskSheet
          task={selectedTask}
          today={today}
          projColor={tasks.projectColor[selectedTask.project] ?? '#5b7a8e'}
          isDone={selectedTask.done}
          subtasks={selectedSubtasks}
          onClose={() => setSelectedTaskId(null)}
          onAddComment={tasks.addComment}
          onToggleDone={(id) => void tasks.toggleDone(id)}
          onOpenTask={setSelectedTaskId}
        />
      )}

      {dayModal && (
        <DayEventsModal
          date={dayModal}
          events={visibleEvents}
          calendars={store.calendars}
          calRoles={calRoles}
          onClose={() => setDayModal(null)}
          onEventClick={(e, el) => {
            const rect = el.getBoundingClientRect();
            setDayModal(null);
            setPopover({ event: e, rect });
          }}
          openDayView={() => {
            const d = dayModal;
            setAnchor(d);
            setSelected(d);
            setView('day');
            setDayModal(null);
          }}
        />
      )}

      <UpdateOverlay />
    </div>
  );
}

function ConfigBanner() {
  return (
    <div style={{
      padding: '10px 22px',
      fontFamily: 'var(--serif-body)',
      fontSize: 12.5,
      color: 'var(--ink)',
      background: '#f6e7c1',
      borderBottom: '0.5px solid var(--rule)',
    }}>
      <strong style={{ fontFamily: 'var(--serif-display)', fontStyle: 'italic' }}>
        OAuth not configured.
      </strong>{' '}
      Place <code>oauth-client.json</code> in your userData directory. See README for steps.
    </div>
  );
}

function EmptyState({ onSignIn, configured }: { onSignIn: () => void; configured: boolean }) {
  return (
    <div style={{
      flex: 1,
      display: 'grid',
      placeItems: 'center',
      background: 'var(--paper)',
    }}>
      <div style={{ textAlign: 'center', maxWidth: 360 }}>
        <div style={{
          fontFamily: 'var(--serif-display)',
          fontStyle: 'italic',
          fontSize: 36,
          fontWeight: 700,
          marginBottom: 8,
        }}>
          yCal
        </div>
        <div style={{
          fontFamily: 'var(--serif-body)',
          fontSize: 13,
          color: 'var(--ink-mute)',
          marginBottom: 18,
        }}>
          An almanac of your days. Sign in with a Google account to load your calendars.
        </div>
        <button
          className="tb-btn primary"
          onClick={onSignIn}
          disabled={!configured}
          style={{ padding: '8px 18px', fontSize: 13 }}
        >
          {configured ? 'Sign in with Google' : 'OAuth not configured'}
        </button>
      </div>
    </div>
  );
}
