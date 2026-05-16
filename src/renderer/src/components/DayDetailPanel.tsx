import type {
  CalendarEvent, AccountSummary, CalendarSummary, LoadBands, LoadWindowSettings,
  RhythmData, TaskItem,
} from '@shared/types';
import { DOW_LONG, MONTH_NAMES, formatTime, ordinal } from '../dates';
import { compareEventsByStart, eventsTouchingDay } from '../multiday';
import {
  type CalRoles, isHolidayEvent, isExcludedFromAgenda, roleOfEvent,
} from '../calRoles';
import { isLocationChip, locKindOf, locLabelOf } from '../locations';
import { rsvpClass } from '../rsvp';
import { LocationIcon } from './LocationIcon';
import { MergeBadge } from './MergeBadge';
import { DayLoadSummary } from './DayLoad';
import { computeDayLoad } from '../dayLoad';

interface Props {
  date: Date;
  events: CalendarEvent[];
  accounts: AccountSummary[];
  calendars: CalendarSummary[];
  calRoles: CalRoles;
  onEventClick: (e: CalendarEvent, anchor: HTMLElement) => void;
  tasks?: TaskItem[];
  scheduledById?: Record<string, { date: string; start: string }>;
  rhythmData?: RhythmData | null;
  loadWindow?: LoadWindowSettings;
  loadBands?: LoadBands;
}

export function DayDetailPanel({
  date, events, accounts, calendars, calRoles, onEventClick,
  tasks, scheduledById, rhythmData, loadWindow, loadBands,
}: Props) {
  const dayLoad = computeDayLoad({
    date, events, calRoles, tasks, scheduledById, rhythmData, loadWindow,
    loadBands,
  });
  const todays = eventsTouchingDay(events, date);

  // Holidays render as a margin note above the journal. Dedupe by title.
  const holidayEvts = todays.filter((e) => isHolidayEvent(e, calRoles));
  const seen = new Set<string>();
  const uniqHolidays = holidayEvts.filter((h) => {
    if (seen.has(h.title)) return false;
    seen.add(h.title);
    return true;
  });

  // Subscribed (read-only) calendars render in their own section so the
  // primary agenda stays focused on the user's own events.
  const subscribed = todays
    .filter((e) => roleOfEvent(e, calRoles) === 'subscribed')
    .slice()
    .sort(compareEventsByStart);
  const agenda = todays.filter(
    (e) => !isExcludedFromAgenda(e, calRoles) && !isLocationChip(e),
  );
  const allDay = agenda.filter((e) => e.allDay).slice().sort(compareEventsByStart);
  const timed = agenda.filter((e) => !e.allDay).slice().sort(compareEventsByStart);

  const seenLoc = new Set<string>();
  const locations = todays
    .filter((e) => isLocationChip(e))
    .filter((e) => {
      const k = locLabelOf(e).trim().toLowerCase();
      if (seenLoc.has(k)) return false;
      seenLoc.add(k);
      return true;
    });

  const acctOf = (accountId: string) => accounts.find((a) => a.id === accountId);
  const calOf = (calendarId: string) => calendars.find((c) => c.id === calendarId);

  const renderEv = (e: CalendarEvent, allDayMode: boolean) => {
    const acct = acctOf(e.accountId);
    const cal = calOf(e.calendarId);
    const rc = rsvpClass(e);
    return (
      <div
        key={e.id}
        className={'dd-event' + (rc ? ' ' + rc : '')}
        style={{ ['--cal' as never]: e.color }}
        onClick={(ev) => onEventClick(e, ev.currentTarget as HTMLElement)}
      >
        <span className="dt">
          {allDayMode ? (
            'all day'
          ) : (
            <>
              {formatTime(new Date(e.start))}
              <br />
              {formatTime(new Date(e.end))}
            </>
          )}
        </span>
        <span className="dn">
          {e.title}
          <MergeBadge event={e} />
          {cal && (
            <span className="acct-tag">— {cal.name}</span>
          )}
          {acct && !cal && (
            <span className="acct-tag">— {acct.email}</span>
          )}
          {e.location && <span className="dl">{e.location}</span>}
        </span>
      </div>
    );
  };

  return (
    <aside className="day-detail-panel">
      <div className="dd-date">
        {ordinal(date.getDate())} {MONTH_NAMES[date.getMonth()]}
        <small>
          {DOW_LONG[date.getDay()]} · A.D. {date.getFullYear()}
        </small>
      </div>
      <hr className="dd-rule" />

      {dayLoad && <DayLoadSummary load={dayLoad} />}

      {locations.length > 0 && (
        <div className="dd-locations">
          {locations.map((le) => (
            <button
              key={le.id}
              className="location-icon-chip dd-loc"
              style={{ ['--cal' as never]: le.color }}
              title={locLabelOf(le)}
              onClick={(ev) => onEventClick(le, ev.currentTarget as HTMLElement)}
            >
              <LocationIcon kind={locKindOf(le)} title={locLabelOf(le)} />
              <span className="loc-label">{locLabelOf(le)}</span>
            </button>
          ))}
        </div>
      )}

      {uniqHolidays.length > 0 && (
        <div className="dd-holidays">
          {uniqHolidays.map((he) => (
            <span key={he.id} style={{ color: he.color }}>· {he.title}</span>
          ))}
        </div>
      )}

      <div className="dd-section-h">All-day</div>
      {allDay.length === 0 && (
        <div className="dd-notes-empty" style={{ padding: '4px 0' }}>—</div>
      )}
      {allDay.map((e) => renderEv(e, true))}

      <div className="dd-section-h">Schedule</div>
      {timed.length === 0 && (
        <div className="dd-notes-empty" style={{ padding: '4px 0' }}>
          No appointments.
        </div>
      )}
      {timed.map((e) => renderEv(e, false))}

      {subscribed.length > 0 && (
        <>
          <div className="dd-section-h">Other calendars</div>
          {subscribed.map((e) => renderEv(e, e.allDay))}
        </>
      )}
    </aside>
  );
}
