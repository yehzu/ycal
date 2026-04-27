import { useEffect } from 'react';
import type { CalendarEvent, CalendarSummary } from '@shared/types';
import { DOW_LONG, MONTH_NAMES, formatTime, ordinal } from '../dates';
import { eventsTouchingDay } from '../multiday';
import { type CalRoles, isHolidayEvent, isExcludedFromAgenda, roleOfEvent } from '../calRoles';
import { isLocationEvent, locKindOf, locLabelOf } from '../locations';
import { LocationIcon } from './LocationIcon';

interface Props {
  date: Date;
  events: CalendarEvent[];
  calendars: CalendarSummary[];
  calRoles: CalRoles;
  onClose: () => void;
  onEventClick: (e: CalendarEvent, anchor: HTMLElement) => void;
  openDayView: () => void;
}

export function DayEventsModal({
  date, events, calendars, calRoles, onClose, onEventClick, openDayView,
}: Props) {
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const occurs = eventsTouchingDay(events, date);

  const seenH = new Set<string>();
  const holidays = occurs
    .filter((e) => isHolidayEvent(e, calRoles))
    .filter((e) => {
      if (seenH.has(e.title)) return false;
      seenH.add(e.title);
      return true;
    });

  const seenL = new Set<string>();
  const locations = occurs
    .filter((e) => isLocationEvent(e))
    .filter((e) => {
      const k = locLabelOf(e).trim().toLowerCase();
      if (seenL.has(k)) return false;
      seenL.add(k);
      return true;
    });

  const byStart = (a: CalendarEvent, b: CalendarEvent) =>
    a.start.localeCompare(b.start);

  const rest = occurs.filter(
    (e) =>
      !isHolidayEvent(e, calRoles) &&
      !isLocationEvent(e) &&
      !isExcludedFromAgenda(e, calRoles),
  );
  const allDay = rest.filter((e) => e.allDay).slice().sort(byStart);
  const timed = rest.filter((e) => !e.allDay).slice().sort(byStart);
  const subscribed = occurs
    .filter((e) => roleOfEvent(e, calRoles) === 'subscribed')
    .slice()
    .sort(byStart);

  const calOf = (id: string) => calendars.find((c) => c.id === id);

  const renderEv = (e: CalendarEvent, isAllDay: boolean) => {
    const cal = calOf(e.calendarId);
    return (
      <button
        key={e.id}
        className="dem-row"
        style={{ ['--cal' as never]: e.color }}
        onClick={(ev) => onEventClick(e, ev.currentTarget)}
      >
        <span className="dem-time">
          {isAllDay ? (
            <span className="dem-allday">all-day</span>
          ) : (
            <>
              <span className="dem-t">{formatTime(new Date(e.start))}</span>
              <span className="dem-dash">—</span>
              <span className="dem-t">{formatTime(new Date(e.end))}</span>
            </>
          )}
        </span>
        <span className="dem-body">
          <span className="dem-title">{e.title}</span>
          {e.location && <span className="dem-loc">{e.location}</span>}
        </span>
        <span className="dem-cal">
          <span className="dem-swatch" />
          <span className="dem-calname">{cal ? cal.name : ''}</span>
        </span>
      </button>
    );
  };

  const dow = DOW_LONG[date.getDay()];
  const m = MONTH_NAMES[date.getMonth()];

  return (
    <>
      <div className="popover-backdrop" onClick={onClose} />
      <div className="day-modal" role="dialog" aria-label={`Events on ${m} ${date.getDate()}`}>
        <header className="dem-head">
          <div className="dem-eyebrow">All entries</div>
          <h2 className="dem-title-h">
            <em>{dow},</em> {m} <span className="dem-num">{ordinal(date.getDate())}</span>
            <span className="dem-year">{date.getFullYear()}</span>
          </h2>
          <button className="dem-close" onClick={onClose} title="Close (Esc)">×</button>
        </header>
        <div className="dem-body-scroll">
          {locations.length > 0 && (
            <section className="dem-section">
              <h3 className="dem-h">Where</h3>
              <div className="dem-locs">
                {locations.map((le) => (
                  <button
                    key={le.id}
                    className="location-icon-chip dd-loc"
                    style={{ ['--cal' as never]: le.color }}
                    title={locLabelOf(le)}
                    onClick={(ev) => onEventClick(le, ev.currentTarget)}
                  >
                    <LocationIcon kind={locKindOf(le)} title={locLabelOf(le)} />
                    <span className="loc-label">{locLabelOf(le)}</span>
                  </button>
                ))}
              </div>
            </section>
          )}
          {holidays.length > 0 && (
            <section className="dem-section">
              <h3 className="dem-h">Observed</h3>
              {holidays.map((h) => (
                <button
                  key={h.id}
                  className="dem-row dem-holiday"
                  style={{ ['--cal' as never]: h.color }}
                  onClick={(ev) => onEventClick(h, ev.currentTarget)}
                >
                  <span className="dem-time"><span className="dem-allday">holiday</span></span>
                  <span className="dem-body"><span className="dem-title">{h.title}</span></span>
                </button>
              ))}
            </section>
          )}
          {allDay.length > 0 && (
            <section className="dem-section">
              <h3 className="dem-h">All-day</h3>
              {allDay.map((e) => renderEv(e, true))}
            </section>
          )}
          <section className="dem-section">
            <h3 className="dem-h">Schedule</h3>
            {timed.length === 0 ? (
              <div className="dem-empty">No appointments.</div>
            ) : (
              timed.map((e) => renderEv(e, false))
            )}
          </section>
          {subscribed.length > 0 && (
            <section className="dem-section">
              <h3 className="dem-h">Other calendars</h3>
              {subscribed.map((e) => renderEv(e, e.allDay))}
            </section>
          )}
        </div>
        <footer className="dem-foot">
          <button className="dem-link" onClick={openDayView}>
            Open full day view →
          </button>
          <span className="dem-hint">Esc to close</span>
        </footer>
      </div>
    </>
  );
}
