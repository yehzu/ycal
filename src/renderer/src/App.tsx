import { useCallback, useEffect, useRef, useState } from 'react';
import type { CalendarEvent, UiSettings } from '@shared/types';
import { addDays, addMonths, startOfWeek } from './dates';
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

const DEFAULT_SECTION_ORDER: SidebarSectionKey[] = [
  'almanac', 'agenda', 'calendars', 'forecast',
];

const DEFAULT_UI: UiSettings = {
  accountsActive: {},
  calVisible: {},
  calRoles: {},
  sectionOrder: DEFAULT_SECTION_ORDER,
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
  // `today` is recomputed on every render (cheap) so the Today button always
  // jumps to the current real day, not the day the app was launched on.
  const today = new Date();
  const [anchor, setAnchor] = useState<Date>(() => new Date());
  const [selected, setSelected] = useState<Date>(() => new Date());
  const [view, setView] = useState<ViewMode>('month');
  const [acctPickerOpen, setAcctPickerOpen] = useState(false);
  const [popover, setPopover] = useState<
    { event: CalendarEvent; anchor: HTMLElement } | null
  >(null);
  const [signInError, setSignInError] = useState<string | null>(null);
  const [calRoles, setCalRoles] = useState<CalRoles>(() => ({ ...initialUi.calRoles }));
  const [sectionOrder, setSectionOrder] = useState<SidebarSectionKey[]>(() =>
    initialUi.sectionOrder.length === DEFAULT_SECTION_ORDER.length
      ? (initialUi.sectionOrder as SidebarSectionKey[])
      : DEFAULT_SECTION_ORDER,
  );

  const setCalRole = useCallback((key: string, role: CalRole) => {
    setCalRoles((prev) => ({ ...prev, [key]: role }));
  }, []);

  const store = useStore(anchor, initialUi);

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
    });
  }, [store.accountsActive, store.calVisible, calRoles, sectionOrder]);

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

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const target = ev.target as HTMLElement | null;
      if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA') return;
      if (popover) {
        if (ev.key === 'Escape') setPopover(null);
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
      } else if (ev.key.toLowerCase() === 't') {
        goToToday();
      } else if (ev.key === 'Escape') {
        setAcctPickerOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [view, popover, goToToday]);

  const onEventClick = (event: CalendarEvent, anchorEl: HTMLElement) => {
    setPopover({ event, anchor: anchorEl });
  };

  const handleSignIn = async () => {
    setSignInError(null);
    const res = await store.signIn();
    if (!res.ok) setSignInError(res.error ?? 'Sign-in failed.');
    setAcctPickerOpen(false);
  };

  const weekStart = startOfWeek(anchor, 0);
  const weekDays = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));

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
            events={store.events}
            weatherUrl={store.weatherUrl}
            weatherDays={store.weatherDays}
            weatherError={store.weatherError}
            setWeatherUrl={store.setWeatherUrl}
          />

          <main className="main">
            <MainToolbar
              view={view}
              setView={setView}
              anchor={anchor}
              setAnchor={setAnchor}
              goToToday={goToToday}
              loading={store.loading}
            />

            {store.accounts.length === 0 ? (
              <EmptyState onSignIn={handleSignIn} configured={store.configured ?? true} />
            ) : view === 'month' ? (
              <MonthGrid
                today={today}
                anchor={anchor}
                selected={selected}
                setSelected={setSelected}
                events={store.events}
                calRoles={calRoles}
                goToDayView={goToDayView}
                onEventClick={onEventClick}
              />
            ) : view === 'week' ? (
              <TimeView
                today={today}
                days={weekDays}
                events={store.events}
                calRoles={calRoles}
                onEventClick={onEventClick}
              />
            ) : (
              <div className="day-view-layout">
                <TimeView
                  today={today}
                  days={[anchor]}
                  events={store.events}
                  calRoles={calRoles}
                  onEventClick={onEventClick}
                />
                <DayDetailPanel
                  date={anchor}
                  events={store.events}
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
