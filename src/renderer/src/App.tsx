import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  CalendarEvent, MergeCriteria, TempUnits, UiSettings,
} from '@shared/types';
import { DEFAULT_MERGE_CRITERIA } from '@shared/types';
import { addDays, addMonths, startOfMonth, startOfWeek } from './dates';
import { useStore } from './store';
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
import { roleOfEvent } from './calRoles';

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
    { event: CalendarEvent; anchor: HTMLElement } | null
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
  const [hideDisabledCals, setHideDisabledCals] = useState(false);
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

  const setCalRole = useCallback((key: string, role: CalRole) => {
    setCalRoles((prev) => ({ ...prev, [key]: role }));
  }, []);

  const store = useStore(anchor, initialUi, mergeCriteria);

  // Effective event list — drop read-only/subscribed entries when the master
  // toggle is on. Other filters (account / calendar visibility) live in store.
  const visibleEvents = useMemo(() => {
    if (!hideReadOnly) return store.events;
    return store.events.filter((e) => roleOfEvent(e, calRoles) !== 'subscribed');
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
    });
  }, [
    store.accountsActive, store.calVisible, calRoles, sectionOrder,
    mergeCriteria, showWeekNums, showWeather, units,
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
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
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
      if (ev.key === 'ArrowLeft') {
        setAnchor((a) =>
          view === 'month' ? addMonths(a, -1)
          : view === 'week' ? addDays(a, -7)
          : addDays(a, -1),
        );
      } else if (ev.key === 'ArrowRight') {
        setAnchor((a) =>
          view === 'month' ? addMonths(a, 1)
          : view === 'week' ? addDays(a, 7)
          : addDays(a, 1),
        );
      } else if (ev.key === 'h') {
        ev.preventDefault();
        moveSelection(-1);
      } else if (ev.key === 'l') {
        ev.preventDefault();
        moveSelection(1);
      } else if (ev.key === 'j') {
        ev.preventDefault();
        moveSelection(7);
      } else if (ev.key === 'k') {
        ev.preventDefault();
        moveSelection(-7);
      } else if (ev.key === ' ' && target?.tagName !== 'BUTTON') {
        ev.preventDefault();
        goToToday();
      } else if (ev.key === 's') {
        ev.preventDefault();
        setView('month');
      } else if (ev.key === 'd') {
        ev.preventDefault();
        setView('week');
      } else if (ev.key === 'f') {
        ev.preventDefault();
        setView('day');
      } else if (ev.key.toLowerCase() === 't') {
        goToToday();
      } else if (ev.key === 'w') {
        ev.preventDefault();
        setHideReadOnly((v) => !v);
      } else if (ev.key === 'Escape') {
        setAcctPickerOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [view, popover, dayModal, settingsOpen, goToToday, moveSelection]);

  const onEventClick = useCallback((event: CalendarEvent, anchorEl: HTMLElement) => {
    setPopover({ event, anchor: anchorEl });
  }, []);

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
              />
            ) : view === 'week' ? (
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
              />
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
                />
                <DayDetailPanel
                  date={anchor}
                  events={visibleEvents}
                  accounts={store.accounts}
                  calendars={store.calendars}
                  calRoles={calRoles}
                  onEventClick={onEventClick}
                />
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
          anchor={popover.anchor}
          accounts={store.accounts}
          calendars={store.calendars}
          onClose={() => setPopover(null)}
        />
      )}

      {settingsOpen && (
        <SettingsModal
          onClose={() => setSettingsOpen(false)}
          showWeekNums={showWeekNums}
          setShowWeekNums={setShowWeekNums}
          mergeCriteria={mergeCriteria}
          setMergeCriteria={setMergeCriteria}
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
            setDayModal(null);
            setPopover({ event: e, anchor: el });
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
