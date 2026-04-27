import { useMemo, useState } from 'react';
import type {
  AccountSummary,
  CalendarEvent,
  CalendarSummary,
  WeatherDay,
} from '@shared/types';
import { DOW_LONG, MONTH_NAMES, formatTime, ordinal } from '../dates';
import { compareEventsByStart, eventTouchesDay, eventsTouchingDay } from '../multiday';
import { calKey } from '../store';
import {
  type CalRole, type CalRoles, ROLE_OPTIONS, isExcludedFromAgenda,
} from '../calRoles';
import { isLocationEvent, locKindOf, locLabelOf } from '../locations';
import { MergeBadge } from './MergeBadge';
import { MiniMonth } from './MiniMonth';
import { avatarBg, initials } from './MacTitleBar';
import { WeatherStrip } from './WeatherStrip';
import { LocationIcon } from './LocationIcon';
import { CalListPrefsMenu } from './CalListPrefsMenu';

export type SidebarSectionKey = 'almanac' | 'agenda' | 'calendars' | 'forecast';

interface Props {
  today: Date;
  anchor: Date;
  selected: Date;
  setAnchor: (d: Date) => void;
  setSelected: (d: Date) => void;
  accounts: AccountSummary[];
  accountsActive: Record<string, boolean>;
  calendars: CalendarSummary[];
  calVisible: Record<string, boolean>;
  toggleCal: (id: string) => void;
  calRoles: CalRoles;
  setCalRole: (key: string, role: CalRole) => void;
  sectionOrder: SidebarSectionKey[];
  setSectionOrder: (order: SidebarSectionKey[]) => void;
  events: CalendarEvent[];
  weatherUrl: string | null;
  weatherDays: WeatherDay[];
  weatherError: string | null;
  setWeatherUrl: (url: string | null) => Promise<void>;
  hideReadOnly: boolean;
  setHideReadOnly: (v: boolean) => void;
  hideDisabledCals: boolean;
  setHideDisabledCals: (v: boolean) => void;
}

function AgendaSummary({
  date, events, calRoles, onEventClick,
}: {
  date: Date;
  events: CalendarEvent[];
  calRoles: CalRoles;
  onEventClick?: (e: CalendarEvent, anchor: HTMLElement) => void;
}) {
  const touching = eventsTouchingDay(events, date);
  const todays = touching
    .filter((e) => !isExcludedFromAgenda(e, calRoles) && !isLocationEvent(e))
    .slice()
    .sort(compareEventsByStart);

  const seenLoc = new Set<string>();
  const locations = touching
    .filter((e) => isLocationEvent(e))
    .filter((e) => {
      const k = locLabelOf(e).trim().toLowerCase();
      if (seenLoc.has(k)) return false;
      seenLoc.add(k);
      return true;
    });
  return (
    <div>
      <div className="agenda-day-line">{DOW_LONG[date.getDay()]}</div>
      <div className="agenda-meta">
        {MONTH_NAMES[date.getMonth()]} {ordinal(date.getDate())} · {todays.length}{' '}
        {todays.length === 1 ? 'entry' : 'entries'}
      </div>
      {locations.length > 0 && (
        <div className="agenda-locations">
          {locations.map((le) => (
            <span
              key={le.id}
              className="location-icon-chip"
              style={{ ['--cal' as never]: le.color }}
              title={locLabelOf(le)}
              onClick={(ev) => onEventClick?.(le, ev.currentTarget)}
            >
              <LocationIcon kind={locKindOf(le)} title={locLabelOf(le)} />
            </span>
          ))}
        </div>
      )}
      <div className="agenda-list">
        {todays.map((e) => (
          <div key={e.id} className="agenda-row" style={{ ['--cal' as never]: e.color }}>
            <span className="t">{e.allDay ? 'all day' : formatTime(new Date(e.start))}</span>
            <span className="ttl">
              <span className="dot" /> {e.title}
              <MergeBadge event={e} />
            </span>
          </div>
        ))}
        {todays.length === 0 && (
          <div className="agenda-row">
            <span className="t">—</span>
            <span
              className="ttl"
              style={{ fontStyle: 'italic', color: 'var(--ink-faint)' }}
            >
              No entries today.
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function CalListByAccount({
  accounts, accountsActive, calendars, calVisible, toggleCal, calRoles, setCalRole,
  hideReadOnly, hideDisabledCals,
}: {
  accounts: AccountSummary[];
  accountsActive: Record<string, boolean>;
  calendars: CalendarSummary[];
  calVisible: Record<string, boolean>;
  toggleCal: (key: string) => void;
  calRoles: CalRoles;
  setCalRole: (key: string, role: CalRole) => void;
  hideReadOnly: boolean;
  hideDisabledCals: boolean;
}) {
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  return (
    <div onClick={() => setOpenMenu(null)}>
      {accounts.filter((a) => accountsActive[a.id]).map((a) => {
        const cals = calendars.filter((c) => c.accountId === a.id);
        const visibleCals = cals.filter((c) => {
          const k = calKey(c.accountId, c.id);
          if (hideDisabledCals && !calVisible[k]) return false;
          return true;
        });
        if (visibleCals.length === 0) return null;
        return (
          <div key={a.id} className="acct-block">
            <div className="acct-row">
              <span className="av" style={{ background: avatarBg(a.id) }}>
                {initials(a)}
              </span>
              <span className="em">{a.email}</span>
            </div>
            {visibleCals.map((c) => {
              const k = calKey(c.accountId, c.id);
              const on = calVisible[k];
              const role: CalRole = calRoles[k] ?? 'normal';
              const isOpen = openMenu === k;
              const dimmed = hideReadOnly && role === 'subscribed';
              return (
                <div key={k} className={'cal-row-wrap' + (dimmed ? ' dimmed' : '')}>
                  <button
                    className={'cal-item ' + (on ? '' : 'off')}
                    style={{ ['--cal' as never]: c.color }}
                    title={c.name + (dimmed ? ' (hidden by Show read-only)' : '')}
                    onClick={(ev) => { ev.stopPropagation(); toggleCal(k); }}
                  >
                    <span className="swatch" />
                    <span className="label">{c.name}</span>
                    {role === 'holiday' && <span className="role-tag">holiday</span>}
                    {role === 'subscribed' && <span className="role-tag">read-only</span>}
                    {c.primary && role === 'normal' && (
                      <span className="primary-tag">primary</span>
                    )}
                  </button>
                  <button
                    className="cal-gear"
                    title="Settings"
                    onClick={(ev) => {
                      ev.stopPropagation();
                      setOpenMenu(isOpen ? null : k);
                    }}
                  >
                    ⋯
                  </button>
                  {isOpen && (
                    <div className="cal-menu" onClick={(ev) => ev.stopPropagation()}>
                      <div className="cal-menu-h">Display as</div>
                      {ROLE_OPTIONS.map(([roleKey, label]) => (
                        <button
                          key={roleKey}
                          className={'cal-menu-item ' + (role === roleKey ? 'on' : '')}
                          onClick={() => {
                            setCalRole(k, roleKey);
                            setOpenMenu(null);
                          }}
                        >
                          <span className="check">{role === roleKey ? '✓' : ''}</span>
                          {label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

interface SectionDef {
  title: string;
  render: () => JSX.Element;
  headerExtra?: JSX.Element;
}

export function Sidebar(props: Props) {
  const hasEvents = useMemo(() => {
    return (key: string) => {
      // key is YYYY-MM-DD; reconstruct as a local date for the touch test.
      const [y, m, d] = key.split('-').map(Number);
      const day = new Date(y, m - 1, d);
      return props.events.some((e) => eventTouchesDay(e, day));
    };
  }, [props.events]);

  const SECTIONS: Record<SidebarSectionKey, SectionDef> = {
    almanac: {
      title: 'Almanac',
      render: () => (
        <MiniMonth
          today={props.today}
          anchor={props.anchor}
          selected={props.selected}
          setAnchor={props.setAnchor}
          setSelected={props.setSelected}
          hasEvents={hasEvents}
        />
      ),
    },
    agenda: {
      title: 'Bill of Fare',
      render: () => (
        <AgendaSummary
          date={props.selected}
          events={props.events}
          calRoles={props.calRoles}
        />
      ),
    },
    calendars: {
      title: 'Calendars',
      headerExtra: (
        <CalListPrefsMenu
          hideReadOnly={props.hideReadOnly}
          setHideReadOnly={props.setHideReadOnly}
          hideDisabledCals={props.hideDisabledCals}
          setHideDisabledCals={props.setHideDisabledCals}
          accountsActive={props.accountsActive}
          calendars={props.calendars}
          calVisible={props.calVisible}
          calRoles={props.calRoles}
        />
      ),
      render: () => (
        props.accounts.length === 0 ? (
          <div style={{
            fontFamily: 'var(--serif-body)',
            fontStyle: 'italic',
            fontSize: 12,
            color: 'var(--ink-mute)',
            padding: '4px 0',
          }}>
            Sign in with Google to load your calendars.
          </div>
        ) : (
          <CalListByAccount
            accounts={props.accounts}
            accountsActive={props.accountsActive}
            calendars={props.calendars}
            calVisible={props.calVisible}
            toggleCal={props.toggleCal}
            calRoles={props.calRoles}
            setCalRole={props.setCalRole}
            hideReadOnly={props.hideReadOnly}
            hideDisabledCals={props.hideDisabledCals}
          />
        )
      ),
    },
    forecast: {
      title: 'Forecast',
      render: () => (
        <WeatherStrip
          start={props.selected}
          url={props.weatherUrl}
          days={props.weatherDays}
          error={props.weatherError}
          onSetUrl={props.setWeatherUrl}
        />
      ),
    },
  };

  const moveSection = (idx: number, dir: -1 | 1) => {
    const next = props.sectionOrder.slice();
    const j = idx + dir;
    if (j < 0 || j >= next.length) return;
    [next[idx], next[j]] = [next[j], next[idx]];
    props.setSectionOrder(next);
  };

  return (
    <aside className="sidebar">
      {props.sectionOrder.map((key, idx) => {
        const s = SECTIONS[key];
        if (!s) return null;
        return (
          <div key={key} className="side-section">
            <h3>
              <span className="sec-title">{s.title}</span>
              {s.headerExtra}
              <span className="sec-reorder">
                <button
                  title="Move up"
                  disabled={idx === 0}
                  onClick={() => moveSection(idx, -1)}
                >
                  ↑
                </button>
                <button
                  title="Move down"
                  disabled={idx === props.sectionOrder.length - 1}
                  onClick={() => moveSection(idx, 1)}
                >
                  ↓
                </button>
              </span>
            </h3>
            {s.render()}
          </div>
        );
      })}
    </aside>
  );
}
