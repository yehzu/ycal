import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type {
  CalendarEvent, LoadBands, LoadWindowSettings, RhythmData, TaskItem, WeatherDay,
} from '@shared/types';
import {
  DOW_SHORT, MONTH_SHORT, addDays, fmtDate, formatTime, getISOWeek, sameYMD,
  startOfMonth, startOfWeek,
} from '../dates';
import {
  buildEventsByDay, compareEventsByStart, isMultiDayAllDay, layoutWeekRibbons,
  type RibbonPlacement,
} from '../multiday';
import { type CalRoles, isHolidayEvent } from '../calRoles';
import { dayHolidayInfo } from '../holidays';
import { isLocationEvent, locKindOf, locLabelOf } from '../locations';
import { rsvpClass } from '../rsvp';
import { LocationIcon } from './LocationIcon';
import { MergeBadge } from './MergeBadge';
import { WeatherChip } from './WeatherChip';
import { DayLoadGauge } from './DayLoad';
import { computeDayLoad } from '../dayLoad';

interface Props {
  today: Date;
  anchor: Date;
  selected: Date;
  setSelected: (d: Date) => void;
  setAnchor: (d: Date) => void;
  events: CalendarEvent[];
  calRoles: CalRoles;
  goToDayView: (d: Date) => void;
  onEventClick: (e: CalendarEvent, anchor: HTMLElement) => void;
  openDayModal: (d: Date) => void;
  showWeekNums: boolean;
  showWeather: boolean;
  units: 'F' | 'C';
  weatherDays: WeatherDay[];
  // Load gauge inputs — optional so older callers don't break.
  tasks?: TaskItem[];
  scheduledById?: Record<string, { date: string; start: string }>;
  rhythmData?: RhythmData | null;
  loadWindow?: LoadWindowSettings;
  loadBands?: LoadBands;
}

const DAY_HEAD_PX = 24;
const EVT_LINE_PX = 17;
const MORE_LINE_PX = 16;
const CELL_PADDING_PX = 10;
const RIBBON_LANE_PX = 18; // 17px row + 1px gap, must match CSS
const EMPTY_EVENTS: CalendarEvent[] = [];

function fitsForLanes(cellHeight: number, ribbonLanes: number): number {
  if (cellHeight <= 0) return 4;
  const ribbonReserve = ribbonLanes * RIBBON_LANE_PX;
  const usable = cellHeight - CELL_PADDING_PX - DAY_HEAD_PX - MORE_LINE_PX - ribbonReserve;
  return Math.max(1, Math.floor(usable / EVT_LINE_PX));
}

export function MonthGrid({
  today, anchor, selected, setSelected, setAnchor, events, calRoles, goToDayView,
  onEventClick, openDayModal, showWeekNums, showWeather, units, weatherDays,
  tasks, scheduledById, rhythmData, loadWindow, loadBands,
}: Props) {
  const weeks = useMemo(() => {
    const gridStart = startOfWeek(startOfMonth(anchor), 0);
    return Array.from({ length: 6 }, (_, w) =>
      Array.from({ length: 7 }, (_, d) => addDays(gridStart, w * 7 + d)),
    );
  }, [anchor.getFullYear(), anchor.getMonth()]);

  // Multi-day ribbons skip holiday-role events and location indicators —
  // both render as date-adjacent chips, not as connected bars.
  const ribbonEvents = useMemo(
    () => events.filter((e) => !isHolidayEvent(e, calRoles) && !isLocationEvent(e)),
    [events, calRoles],
  );

  // One-pass bucket of events keyed by YYYY-MM-DD. Each Cell looks up its own
  // slice in O(1) instead of re-scanning the full event list.
  const flatDays = useMemo(() => weeks.flat(), [weeks]);
  const eventsByDay = useMemo(
    () => buildEventsByDay(events, flatDays),
    [events, flatDays],
  );

  const gridRef = useRef<HTMLDivElement | null>(null);
  // Track raw cell height (independent of ribbon lanes) so each WeekRow can
  // compute its own per-week event budget — weeks with many cd ribbons need
  // to surface "+N more" sooner, while empty weeks stay generous.
  const [cellHeight, setCellHeight] = useState(0);

  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const compute = () => {
      const cell = el.querySelector('.month-cell') as HTMLElement | null;
      if (!cell) return;
      setCellHeight(cell.clientHeight);
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div
      className={'month-grid' + (showWeekNums ? ' with-wk' : '')}
      ref={gridRef}
    >
      <div className="month-dow-header">
        {showWeekNums && <div className="month-wk-h">wk</div>}
        {DOW_SHORT.map((d) => (
          <div key={d} className="month-dow">{d}</div>
        ))}
      </div>
      {weeks.map((week) => (
        <WeekRow
          key={fmtDate(week[0])}
          week={week}
          anchor={anchor}
          today={today}
          selected={selected}
          setSelected={setSelected}
          setAnchor={setAnchor}
          eventsByDay={eventsByDay}
          ribbonEvents={ribbonEvents}
          calRoles={calRoles}
          cellHeight={cellHeight}
          goToDayView={goToDayView}
          onEventClick={onEventClick}
          openDayModal={openDayModal}
          showWeekNums={showWeekNums}
          showWeather={showWeather}
          units={units}
          weatherDays={weatherDays}
          allEvents={events}
          tasks={tasks}
          scheduledById={scheduledById}
          rhythmData={rhythmData}
          loadWindow={loadWindow}
          loadBands={loadBands}
        />
      ))}
    </div>
  );
}

interface WeekRowProps {
  week: Date[];
  anchor: Date;
  today: Date;
  selected: Date;
  setSelected: (d: Date) => void;
  setAnchor: (d: Date) => void;
  eventsByDay: Map<string, CalendarEvent[]>;
  ribbonEvents: CalendarEvent[];
  calRoles: CalRoles;
  cellHeight: number;
  goToDayView: (d: Date) => void;
  onEventClick: (e: CalendarEvent, anchor: HTMLElement) => void;
  openDayModal: (d: Date) => void;
  showWeekNums: boolean;
  showWeather: boolean;
  units: 'F' | 'C';
  weatherDays: WeatherDay[];
  allEvents: CalendarEvent[];
  tasks?: TaskItem[];
  scheduledById?: Record<string, { date: string; start: string }>;
  rhythmData?: RhythmData | null;
  loadWindow?: LoadWindowSettings;
  loadBands?: LoadBands;
}

const WeekRow = memo(function WeekRow({
  week, anchor, today, selected, setSelected, setAnchor, eventsByDay, ribbonEvents,
  calRoles, cellHeight, goToDayView, onEventClick, openDayModal, showWeekNums,
  showWeather, units, weatherDays, allEvents, tasks, scheduledById, rhythmData,
  loadWindow, loadBands,
}: WeekRowProps) {
  const ribbons = useMemo(
    () => layoutWeekRibbons(ribbonEvents, week[0]),
    [ribbonEvents, week[0].getTime()],
  );
  const ribbonLanes = ribbons.length === 0
    ? 0
    : Math.max(...ribbons.map((r) => r.lane)) + 1;
  const maxPerCell = fitsForLanes(cellHeight, ribbonLanes);

  // ISO-week is computed from the Thursday of the row so cross-year boundaries
  // resolve to the correct number.
  const wkNum = getISOWeek(addDays(week[0], 3));

  return (
    <div
      className="week-row"
      style={{ ['--ribbon-lanes' as never]: String(ribbonLanes) }}
    >
      {showWeekNums && (
        <div
          className="month-wk"
          title={`Week ${wkNum}`}
          onClick={() => { setAnchor(week[0]); setSelected(week[0]); }}
        >
          {wkNum}
        </div>
      )}
      {week.map((d) => {
        const k = fmtDate(d);
        return (
          <Cell
            key={k}
            day={d}
            inMonth={d.getMonth() === anchor.getMonth()}
            isToday={sameYMD(d, today)}
            isSelected={sameYMD(d, selected)}
            setSelected={setSelected}
            dayEvents={eventsByDay.get(k) ?? EMPTY_EVENTS}
            calRoles={calRoles}
            maxPerCell={maxPerCell}
            goToDayView={goToDayView}
            onEventClick={onEventClick}
            openDayModal={openDayModal}
            showWeather={showWeather}
            units={units}
            weatherDays={weatherDays}
            allEvents={allEvents}
            tasks={tasks}
            scheduledById={scheduledById}
            rhythmData={rhythmData}
            loadWindow={loadWindow}
            loadBands={loadBands}
          />
        );
      })}
      {ribbons.length > 0 && (
        <div className="week-ribbons">
          {ribbons.map((r) => (
            <Ribbon key={r.event.id + ':' + r.colStart} placement={r} onClick={onEventClick} />
          ))}
        </div>
      )}
    </div>
  );
});

function Ribbon({
  placement, onClick,
}: {
  placement: RibbonPlacement;
  onClick: (e: CalendarEvent, anchor: HTMLElement) => void;
}) {
  const e = placement.event;
  const cn = ['ribbon'];
  if (placement.clippedLeft) cn.push('clip-l');
  if (placement.clippedRight) cn.push('clip-r');
  const rc = rsvpClass(e);
  if (rc) cn.push(rc);
  return (
    <button
      className={cn.join(' ')}
      style={{
        ['--cal' as never]: e.color,
        background: e.color,
        gridColumn: `${placement.colStart + 1} / ${placement.colEnd + 1}`,
        gridRow: placement.lane + 1,
      }}
      onClick={(ev) => {
        ev.stopPropagation();
        onClick(e, ev.currentTarget);
      }}
      title={e.title}
    >
      {placement.clippedLeft && <span className="ribbon-arrow">‹</span>}
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {e.title}
        <MergeBadge event={e} variant="compact" />
      </span>
      {placement.clippedRight && <span className="ribbon-arrow" style={{ marginLeft: 'auto' }}>›</span>}
    </button>
  );
}

interface CellProps {
  day: Date;
  inMonth: boolean;
  isToday: boolean;
  isSelected: boolean;
  setSelected: (d: Date) => void;
  dayEvents: CalendarEvent[];
  calRoles: CalRoles;
  maxPerCell: number;
  goToDayView: (d: Date) => void;
  onEventClick: (e: CalendarEvent, anchor: HTMLElement) => void;
  openDayModal: (d: Date) => void;
  showWeather: boolean;
  units: 'F' | 'C';
  weatherDays: WeatherDay[];
  allEvents: CalendarEvent[];
  tasks?: TaskItem[];
  scheduledById?: Record<string, { date: string; start: string }>;
  rhythmData?: RhythmData | null;
  loadWindow?: LoadWindowSettings;
  loadBands?: LoadBands;
}

const Cell = memo(function Cell({
  day, inMonth, isToday, isSelected, setSelected, dayEvents, calRoles, maxPerCell,
  goToDayView, onEventClick, openDayModal, showWeather, units, weatherDays,
  allEvents, tasks, scheduledById, rhythmData, loadWindow, loadBands,
}: CellProps) {
  const isWeekend = day.getDay() === 0 || day.getDay() === 6;
  const hInfo = dayHolidayInfo(day, dayEvents, calRoles);
  const isOOO = dayEvents.some((e) => isLocationEvent(e) && locKindOf(e) === 'ooo');
  const dayLoad = computeDayLoad({
    date: day,
    events: allEvents,
    calRoles,
    tasks,
    scheduledById,
    rhythmData,
    loadWindow,
    loadBands,
  });

  const touching = dayEvents;
  const holidayEvents = touching.filter((e) => isHolidayEvent(e, calRoles));
  // Dedupe holidays by title — multiple holiday calendars often carry the
  // same entry (e.g. Earth Day appears in both system and family holidays).
  const seenHolidays = new Set<string>();
  const uniqHolidays = holidayEvents.filter((h) => {
    if (seenHolidays.has(h.title)) return false;
    seenHolidays.add(h.title);
    return true;
  });

  const seenLoc = new Set<string>();
  const locationEvents = touching
    .filter((e) => isLocationEvent(e))
    .filter((e) => {
      const k = locLabelOf(e).trim().toLowerCase();
      if (seenLoc.has(k)) return false;
      seenLoc.add(k);
      return true;
    });

  // Holiday-role events render beside the date, not as event rows.
  // Multi-day all-day events render in the ribbon overlay only.
  // Location indicators render as small chips beside the date.
  const ordered = touching
    .filter((e) => !isMultiDayAllDay(e)
      && !isHolidayEvent(e, calRoles)
      && !isLocationEvent(e))
    .slice()
    .sort(compareEventsByStart);
  const shown = ordered.slice(0, maxPerCell);
  const hidden = ordered.length - shown.length;

  const cls = ['month-cell'];
  if (!inMonth) cls.push('other-month');
  if (isToday) cls.push('today');
  if (isSelected) cls.push('selected');
  // 補班 promotes a weekend INTO a workday — don't apply weekend tint.
  if (isWeekend && hInfo?.kind !== 'workday') cls.push('weekend');
  if (hInfo) cls.push('h-' + hInfo.kind);
  if (isOOO) cls.push('is-ooo');

  return (
    <div
      className={cls.join(' ')}
      style={hInfo?.color ? ({ ['--h-color' as never]: hInfo.color }) : undefined}
      onClick={() => setSelected(day)}
      onDoubleClick={() => goToDayView(day)}
      title={hInfo?.label || 'Double-click to open day view'}
    >
      <div className="day-head">
        <div className="day-num">{day.getDate()}</div>
        {showWeather && (
          <WeatherChip date={day} days={weatherDays} units={units} variant="compact" />
        )}
        <div className="day-meta">
          {day.getDate() === 1 && <span>{MONTH_SHORT[day.getMonth()]}</span>}
          {uniqHolidays.map((he) => (
            <span
              key={he.id}
              className="holiday"
              style={{ color: he.color }}
              onClick={(ev) => {
                ev.stopPropagation();
                onEventClick(he, ev.currentTarget);
              }}
            >
              {he.title}
            </span>
          ))}
          {locationEvents.map((le) => (
            <span
              key={le.id}
              className="location-icon-chip"
              style={{ ['--cal' as never]: le.color }}
              title={locLabelOf(le)}
              onClick={(ev) => {
                ev.stopPropagation();
                onEventClick(le, ev.currentTarget);
              }}
            >
              <LocationIcon kind={locKindOf(le)} title={locLabelOf(le)} />
            </span>
          ))}
        </div>
      </div>
      <DayLoadGauge load={dayLoad} variant="compact" />
      <div className="day-events">
        {shown.map((e) => {
          const cn = ['evt'];
          if (e.allDay) cn.push('all-day');
          const rc = rsvpClass(e);
          if (rc) cn.push(rc);
          return (
            <button
              key={e.id}
              className={cn.join(' ')}
              style={{ ['--cal' as never]: e.color }}
              onClick={(ev) => {
                ev.stopPropagation();
                onEventClick(e, ev.currentTarget);
              }}
            >
              {!e.allDay && (
                <span className="evt-t">
                  {formatTime(new Date(e.start))}
                </span>
              )}
              <span className="evt-ttl">{e.title}</span>
              <MergeBadge event={e} variant="compact" />
            </button>
          );
        })}
        {hidden > 0 && (
          <button
            className="evt-more"
            onClick={(ev) => {
              ev.stopPropagation();
              openDayModal(day);
            }}
          >
            + {hidden} more…
          </button>
        )}
      </div>
    </div>
  );
});
