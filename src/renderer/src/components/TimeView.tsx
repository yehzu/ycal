import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  CalendarEvent, LoadBands, LoadWindowSettings, RhythmData, TaskItem, WeatherDay,
} from '@shared/types';
import {
  DOW_SHORT, addDays, fmtDate, formatTime, getISOWeek, sameYMD,
} from '../dates';
import {
  eventTouchesDay, isEventStartDay, isMultiDayAllDay, layoutRangeRibbons,
  type RibbonPlacement,
} from '../multiday';
import { type CalRoles, isHolidayEvent } from '../calRoles';
import { dayHolidayInfo, type DayHolidayInfo } from '../holidays';
import { isLocationChip, isLocationEvent, locKindOf, locLabelOf } from '../locations';
import { rsvpClass } from '../rsvp';
import { LocationIcon } from './LocationIcon';
import { MergeBadge } from './MergeBadge';
import { WeatherChip } from './WeatherChip';
import { useDragSource, useDragTarget } from '../dragController';
import { resolveRhythm, formatRhythmTime, snap15 } from '../rhythm';
import { formatDur } from './TasksPanel';
import { renderInlineCode } from '../inlineCode';
import { DayLoadGauge, DayLoadReadout } from './DayLoad';
import { computeDayLoad } from '../dayLoad';

interface Props {
  today: Date;
  days: Date[];
  events: CalendarEvent[];
  calRoles: CalRoles;
  onEventClick: (e: CalendarEvent, anchor: HTMLElement) => void;
  showWeekNums: boolean;
  showWeather: boolean;
  units: 'F' | 'C';
  weatherDays: WeatherDay[];
  // Tasks layer — optional so legacy callers (none currently) don't break.
  tasks?: TaskItem[];
  scheduledById?: Record<string, { date: string; start: string }>;
  onScheduleTask?: (taskId: string, date: string, start: string) => void;
  onToggleTaskDone?: (taskId: string) => void;
  onOpenTask?: (taskId: string) => void;
  // Day rhythm — wake / sleep lines per column.
  rhythmData?: RhythmData | null;
  onSetRhythmOverride?: (dateStr: string, patch: { wakeMin?: number; sleepMin?: number }) => void;
  onClearRhythmOverride?: (dateStr: string) => void;
  // Window for the day-load calculation (defaults to active hours).
  loadWindow?: LoadWindowSettings;
  loadBands?: LoadBands;
}

const HOUR_HEIGHT = 56;
const START_HOUR = 0;
const END_HOUR = 23;

type Block =
  | { kind: 'event'; event: CalendarEvent; sMin: number; eMin: number }
  | { kind: 'task'; task: TaskItem; start: string; sMin: number; eMin: number };

type PlacedBlock = Block & { col: number; cols: number };

// Lay events and scheduled tasks into shared columns. Tasks used to be
// laid out independently from events, so a 9–10 task and a 9–10 event
// would both take 100% width and the task (z-index: 1) would obscure the
// event. Treating them as one population means a task that overlaps an
// event gets its own column at width 1/N instead.
function layoutBlocks(
  events: CalendarEvent[],
  tasks: Array<{ task: TaskItem; start: string }>,
  day: Date,
): PlacedBlock[] {
  const dayStartMs = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
  const dayEndMs = dayStartMs + 24 * 60 * 60 * 1000;

  const blocks: Block[] = [];
  for (const e of events) {
    const evS = new Date(e.start).getTime();
    const evE = new Date(e.end).getTime();
    const sMin = evS <= dayStartMs ? 0 : Math.round((evS - dayStartMs) / 60000);
    const eMin = evE >= dayEndMs ? 24 * 60 : Math.round((evE - dayStartMs) / 60000);
    blocks.push({ kind: 'event', event: e, sMin, eMin });
  }
  for (const { task, start } of tasks) {
    const [h, m] = start.split(':').map((n) => parseInt(n, 10) || 0);
    const sMin = h * 60 + m;
    const dur = task.dur || 30;
    const eMin = Math.min(24 * 60, sMin + dur);
    blocks.push({ kind: 'task', task, start, sMin, eMin });
  }

  const sorted = blocks.slice().sort((a, b) => {
    if (a.sMin !== b.sMin) return a.sMin - b.sMin;
    return b.eMin - a.eMin;
  });

  const placed: Array<Block & { col: number }> = [];
  const clusterIds: number[] = [];
  const clusterCounts: number[] = [];
  let curCluster = -1;
  let curEnd = -Infinity;

  for (const b of sorted) {
    const { sMin, eMin } = b;
    if (sMin >= curEnd) {
      curCluster++;
      curEnd = eMin;
      clusterCounts[curCluster] = 0;
    } else {
      curEnd = Math.max(curEnd, eMin);
    }
    const usedCols = new Set<number>();
    for (let i = 0; i < placed.length; i++) {
      if (clusterIds[i] !== curCluster) continue;
      if (placed[i].eMin > sMin && placed[i].sMin < eMin) {
        usedCols.add(placed[i].col);
      }
    }
    let col = 0;
    while (usedCols.has(col)) col++;
    placed.push({ ...b, col });
    clusterIds.push(curCluster);
    clusterCounts[curCluster] = Math.max(clusterCounts[curCluster] ?? 0, col + 1);
  }

  return placed.map((p, i) => ({
    ...p,
    cols: clusterCounts[clusterIds[i]],
  }));
}

export function TimeView({
  today, days, events, calRoles, onEventClick, showWeekNums,
  showWeather, units, weatherDays,
  tasks, scheduledById, onScheduleTask, onToggleTaskDone, onOpenTask,
  rhythmData, onSetRhythmOverride, onClearRhythmOverride,
  loadWindow, loadBands,
}: Props) {
  const hours = Array.from({ length: END_HOUR - START_HOUR + 1 }, (_, i) => i + START_HOUR);
  const colTemplate = `60px repeat(${days.length}, 1fr)`;
  const bodyRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!bodyRef.current) return;
    const showsToday = days.some((d) => sameYMD(d, today));
    const baseMin = showsToday
      ? today.getHours() * 60 + today.getMinutes() - 90
      : 6 * 60;
    const targetMin = Math.max(0, Math.min(baseMin, (END_HOUR - START_HOUR) * 60));
    bodyRef.current.scrollTop = (targetMin / 60) * HOUR_HEIGHT;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days[0]?.getTime(), days.length]);

  const nowMinutes = today.getHours() * 60 + today.getMinutes();
  const nowOffset = ((nowMinutes / 60) - START_HOUR) * HOUR_HEIGHT;

  const allDayByDay = useMemo(() => {
    const m: Record<string, CalendarEvent[]> = {};
    for (const d of days) {
      m[fmtDate(d)] = events.filter(
        (e) => e.allDay
          && !isMultiDayAllDay(e)
          && !isLocationChip(e)
          && eventTouchesDay(e, d),
      );
    }
    return m;
  }, [days, events]);

  const ribbons = useMemo<RibbonPlacement[]>(
    () => (days.length === 0
      ? []
      : layoutRangeRibbons(events.filter((e) => !isLocationChip(e)), days[0], days.length)),
    [days, events],
  );
  const ribbonLanes = ribbons.length === 0
    ? 0
    : Math.max(...ribbons.map((r) => r.lane)) + 1;

  const timedByDay = useMemo(() => {
    const m: Record<string, CalendarEvent[]> = {};
    for (const d of days) m[fmtDate(d)] = [];
    for (const e of events) {
      if (e.allDay) continue;
      // Drop every location-flagged event from the column-packed event
      // list — workingLocation goes to the date chips, and OOO (timed or
      // all-day) gets its own treatment so it doesn't fight real
      // meetings for column width.
      if (isLocationEvent(e)) continue;
      for (const d of days) {
        if (eventTouchesDay(e, d)) m[fmtDate(d)].push(e);
      }
    }
    return m;
  }, [days, events]);

  // Timed OOO events surface as a full-width, hatched background band
  // behind regular events — "I'm out 2-5pm" should mark that slot, not
  // shove a meeting at 3pm into a half-column. All-day OOO renders as a
  // date-adjacent chip via locationsByDay; this bucket is timed only.
  const oooByDay = useMemo(() => {
    const m: Record<string, CalendarEvent[]> = {};
    for (const d of days) m[fmtDate(d)] = [];
    for (const e of events) {
      if (e.allDay) continue;
      if (e.eventType !== 'outOfOffice') continue;
      for (const d of days) {
        if (eventTouchesDay(e, d)) m[fmtDate(d)].push(e);
      }
    }
    return m;
  }, [days, events]);

  const locationsByDay = useMemo(() => {
    const m: Record<string, CalendarEvent[]> = {};
    for (const d of days) {
      const seen = new Set<string>();
      m[fmtDate(d)] = events
        .filter((e) => isLocationChip(e) && eventTouchesDay(e, d))
        .filter((e) => {
          const k = locLabelOf(e).trim().toLowerCase();
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
    }
    return m;
  }, [days, events]);

  // Tasks bucketed by date for chip rendering.
  const tasksByDay = useMemo(() => {
    const m: Record<string, Array<{ task: TaskItem; start: string }>> = {};
    for (const d of days) m[fmtDate(d)] = [];
    if (!tasks || !scheduledById) return m;
    const byId = new Map<string, TaskItem>();
    for (const t of tasks) byId.set(t.id, t);
    for (const [taskId, slot] of Object.entries(scheduledById)) {
      const t = byId.get(taskId);
      if (!t) continue;
      if (!m[slot.date]) continue;
      m[slot.date].push({ task: t, start: slot.start });
    }
    // Sort within each day by start time so chips don't render in random order.
    for (const k of Object.keys(m)) {
      m[k].sort((a, b) => a.start.localeCompare(b.start));
    }
    return m;
  }, [days, tasks, scheduledById]);

  return (
    <div className="time-view">
      <div className="tv-header">
        <div style={{ display: 'grid', gridTemplateColumns: colTemplate }}>
          <div className="tv-corner">
            {showWeekNums && days.length > 0 && (
              <div className="tv-wk">
                <span className="tv-wk-label">wk</span>
                <span className="tv-wk-num">
                  {getISOWeek(addDays(days[0], days.length === 7 ? 3 : 0))}
                </span>
              </div>
            )}
          </div>
          {days.map((d) => {
            const isToday = sameYMD(d, today);
            const hInfo = dayHolidayInfo(d, events, calRoles);
            const isWeekend = d.getDay() === 0 || d.getDay() === 6;
            const locs = locationsByDay[fmtDate(d)] ?? [];
            const isOOO = locs.some((le) => locKindOf(le) === 'ooo');
            const headCls = ['tv-col-head'];
            if (isToday) headCls.push('today');
            if (isWeekend && hInfo?.kind !== 'workday') headCls.push('weekend');
            if (hInfo) headCls.push('h-' + hInfo.kind);
            if (isOOO) headCls.push('is-ooo');
            const dayLoad = computeDayLoad({
              date: d,
              events,
              calRoles,
              tasks,
              scheduledById,
              rhythmData,
              loadWindow,
              loadBands,
            });
            return (
              <div
                key={fmtDate(d)}
                className={headCls.join(' ')}
                style={hInfo?.color ? ({ ['--h-color' as never]: hInfo.color }) : undefined}
                title={hInfo?.label || ''}
              >
                <div className="dow">{DOW_SHORT[d.getDay()]}</div>
                <div className="num">{d.getDate()}</div>
                {showWeather && (
                  <div className="tv-weather-row">
                    <WeatherChip
                      date={d}
                      days={weatherDays}
                      units={units}
                      variant="header"
                    />
                  </div>
                )}
                {hInfo && hInfo.kind !== 'weekend' && (
                  <div
                    className="tv-h-label"
                    style={hInfo.color ? { color: hInfo.color } : undefined}
                  >
                    {hInfo.label}
                  </div>
                )}
                {locs.length > 0 && (
                  <div className="tv-loc-chips">
                    {locs.map((le) => (
                      <button
                        key={le.id}
                        className="location-icon-chip tv-loc"
                        style={{ ['--cal' as never]: le.color }}
                        title={locLabelOf(le)}
                        onClick={(ev) => onEventClick(le, ev.currentTarget)}
                      >
                        <LocationIcon kind={locKindOf(le)} title={locLabelOf(le)} />
                      </button>
                    ))}
                  </div>
                )}
                <DayLoadGauge load={dayLoad} variant="head" />
                <DayLoadReadout load={dayLoad} />
              </div>
            );
          })}
        </div>
        <div
          className="tv-allday-row"
          style={{
            display: 'grid',
            gridTemplateColumns: colTemplate,
            ['--ribbon-lanes' as never]: String(ribbonLanes),
          }}
        >
          <div className="tv-allday-gutter">all day</div>
          {days.map((d) => {
            const seen = new Set<string>();
            const dayAll = (allDayByDay[fmtDate(d)] ?? []).filter((e) => {
              if (seen.has(e.title)) return false;
              seen.add(e.title);
              return true;
            });
            return (
              <div key={fmtDate(d)} className="tv-allday-cell">
                {dayAll.map((e) => {
                  const holiday = isHolidayEvent(e, calRoles);
                  const cn = ['tv-allday-pill'];
                  if (holiday) cn.push('holiday-pill');
                  const rc = rsvpClass(e);
                  if (rc) cn.push(rc);
                  return (
                    <button
                      key={e.id}
                      className={cn.join(' ')}
                      style={{ ['--cal' as never]: e.color }}
                      onClick={(ev) => onEventClick(e, ev.currentTarget)}
                    >
                      {e.title}
                      <MergeBadge event={e} variant="compact" />
                    </button>
                  );
                })}
              </div>
            );
          })}
          {ribbons.length > 0 && (
            <div
              className="tv-allday-ribbons"
              style={{ gridTemplateColumns: colTemplate }}
            >
              {ribbons.map((r) => {
                const e = r.event;
                const holiday = isHolidayEvent(e, calRoles);
                const cn = ['ribbon'];
                if (r.clippedLeft) cn.push('clip-l');
                if (r.clippedRight) cn.push('clip-r');
                if (holiday) cn.push('holiday-ribbon');
                const rc = rsvpClass(e);
                if (rc) cn.push(rc);
                return (
                  <button
                    key={e.id + ':' + r.colStart}
                    className={cn.join(' ')}
                    style={{
                      ['--cal' as never]: e.color,
                      gridColumn: `${r.colStart + 2} / ${r.colEnd + 2}`,
                      gridRow: r.lane + 1,
                    }}
                    onClick={(ev) => onEventClick(e, ev.currentTarget)}
                    title={e.title}
                  >
                    {r.clippedLeft && <span className="ribbon-arrow">‹</span>}
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {e.title}
                      <MergeBadge event={e} variant="compact" />
                    </span>
                    {r.clippedRight && (
                      <span className="ribbon-arrow" style={{ marginLeft: 'auto' }}>›</span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <div className="tv-body" ref={bodyRef}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: colTemplate,
            position: 'relative',
            height: (END_HOUR - START_HOUR + 1) * HOUR_HEIGHT,
          }}
        >
          <div className="tv-gutter">
            {hours.map((h) => (
              <div key={h} style={{ height: HOUR_HEIGHT, position: 'relative' }}>
                <span className="tv-hour-label" style={{ top: 0 }}>
                  {formatTime(new Date(2000, 0, 1, h, 0))}
                </span>
              </div>
            ))}
          </div>
          {days.map((d) => {
            const isToday = sameYMD(d, today);
            const hInfo = dayHolidayInfo(d, events, calRoles);
            const isWeekend = d.getDay() === 0 || d.getDay() === 6;
            const dayTasks = tasksByDay[fmtDate(d)] ?? [];
            const dayLocs = locationsByDay[fmtDate(d)] ?? [];
            const isOOO = dayLocs.some((le) => locKindOf(le) === 'ooo');
            return (
              <DayColumn
                key={fmtDate(d)}
                day={d}
                isToday={isToday}
                isWeekend={isWeekend}
                isOOO={isOOO}
                hInfo={hInfo}
                events={timedByDay[fmtDate(d)] ?? []}
                ooos={oooByDay[fmtDate(d)] ?? []}
                onEventClick={onEventClick}
                nowOffset={nowOffset}
                tasks={dayTasks}
                onScheduleTask={onScheduleTask}
                onToggleTaskDone={onToggleTaskDone}
                onOpenTask={onOpenTask}
                rhythmData={rhythmData ?? null}
                onSetRhythmOverride={onSetRhythmOverride}
                onClearRhythmOverride={onClearRhythmOverride}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

interface DayColumnProps {
  day: Date;
  isToday: boolean;
  isWeekend: boolean;
  isOOO: boolean;
  hInfo: DayHolidayInfo | null;
  events: CalendarEvent[];
  ooos: CalendarEvent[];
  onEventClick: (e: CalendarEvent, anchor: HTMLElement) => void;
  nowOffset: number;
  tasks: Array<{ task: TaskItem; start: string }>;
  onScheduleTask?: (taskId: string, date: string, start: string) => void;
  onToggleTaskDone?: (taskId: string) => void;
  onOpenTask?: (taskId: string) => void;
  rhythmData: RhythmData | null;
  onSetRhythmOverride?: (dateStr: string, patch: { wakeMin?: number; sleepMin?: number }) => void;
  onClearRhythmOverride?: (dateStr: string) => void;
}

function DayColumn({
  day, isToday, isWeekend, isOOO, hInfo, events, ooos, onEventClick, nowOffset,
  tasks, onScheduleTask, onToggleTaskDone, onOpenTask,
  rhythmData, onSetRhythmOverride, onClearRhythmOverride,
}: DayColumnProps) {
  const colRef = useRef<HTMLDivElement | null>(null);
  const dateStr = fmtDate(day);
  const laid = layoutBlocks(events, tasks, day);

  const [dropPreview, setDropPreview] = useState<{ y: number; min: number } | null>(null);

  const yToMin = (y: number): number => {
    const m = Math.round(((y / HOUR_HEIGHT) + START_HOUR) * 60);
    return snap15(m);
  };

  useDragTarget(colRef as React.RefObject<HTMLElement>, {
    accept: 'task',
    onOver: ({ y, target }) => {
      const rect = (target as HTMLElement).getBoundingClientRect();
      const localY = y - rect.top;
      const min = yToMin(localY);
      const snappedY = ((min / 60) - START_HOUR) * HOUR_HEIGHT;
      setDropPreview({ y: snappedY, min });
    },
    onLeave: () => setDropPreview(null),
    onDrop: ({ y, payload, target }) => {
      const rect = (target as HTMLElement).getBoundingClientRect();
      const localY = y - rect.top;
      const min = yToMin(localY);
      const p = payload as { taskId: string };
      if (onScheduleTask) {
        const start = `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
        onScheduleTask(p.taskId, dateStr, start);
      }
      setDropPreview(null);
    },
  });

  const colCls = ['tv-col'];
  if (isToday) colCls.push('today-col');
  if (isWeekend && hInfo?.kind !== 'workday') colCls.push('weekend');
  if (hInfo) colCls.push('h-' + hInfo.kind);
  if (isOOO) colCls.push('is-ooo');
  if (dropPreview) colCls.push('drop-over');

  const rhythm = useMemo(() => resolveRhythm(rhythmData, dateStr), [rhythmData, dateStr]);
  const wakeY = ((rhythm.wakeMin / 60) - START_HOUR) * HOUR_HEIGHT;
  const sleepY = ((rhythm.sleepMin / 60) - START_HOUR) * HOUR_HEIGHT;

  return (
    <div
      ref={colRef}
      className={colCls.join(' ')}
      style={hInfo?.color ? ({ ['--h-color' as never]: hInfo.color }) : undefined}
    >
      {Array.from({ length: END_HOUR - START_HOUR + 1 }, (_, i) => i + START_HOUR).map((h) => (
        <div
          key={h}
          className="tv-grid-row hour"
          style={{ height: HOUR_HEIGHT }}
        />
      ))}

      {/* Timed OOO bands — hatched warm wash spanning the event's time
          range, full column width, sitting BEHIND regular events so a
          meeting that overlaps an OOO range still reads on top. */}
      {ooos.map((e) => {
        const dayStartMs = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
        const dayEndMs = dayStartMs + 24 * 60 * 60 * 1000;
        const evS = new Date(e.start).getTime();
        const evE = new Date(e.end).getTime();
        const sMin = evS <= dayStartMs ? 0 : Math.round((evS - dayStartMs) / 60000);
        const eMin = evE >= dayEndMs ? 24 * 60 : Math.round((evE - dayStartMs) / 60000);
        const top = ((sMin / 60) - START_HOUR) * HOUR_HEIGHT;
        const height = Math.max(16, ((eMin - sMin) / 60) * HOUR_HEIGHT);
        return (
          <button
            key={'ooo:' + e.id}
            className="tv-ooo-band"
            style={{ top, height }}
            onClick={(ev) => onEventClick(e, ev.currentTarget)}
            title={e.title}
          >
            <span className="tv-ooo-label">OOO</span>
          </button>
        );
      })}

      {/* Tasks and events share the same column layout so they don't cover
          each other when scheduled at the same time slot. */}
      {laid.map((b) => {
        if (b.kind === 'task') {
          return (
            <ScheduledTaskChip
              key={'t:' + b.task.id}
              task={b.task}
              dateStr={dateStr}
              start={b.start}
              col={b.col}
              cols={b.cols}
              onToggleDone={onToggleTaskDone}
              onOpen={onOpenTask}
            />
          );
        }
        const e = b.event;
        const { col, sMin, eMin, cols } = b;
        const top = ((sMin / 60) - START_HOUR) * HOUR_HEIGHT;
        const dur = eMin - sMin;
        const height = (dur / 60) * HOUR_HEIGHT;
        const widthPct = 100 / cols;
        const leftPct = widthPct * col;
        const startsHere = isEventStartDay(e, day);
        const cn = ['tv-event'];
        if (dur < 15) cn.push('tiny');
        else if (dur <= 30) cn.push('short');
        const rc = rsvpClass(e);
        if (rc) cn.push(rc);
        return (
          <button
            key={'e:' + e.id}
            className={cn.join(' ')}
            style={{
              ['--cal' as never]: e.color,
              top,
              height: Math.max(height, 14),
              left: `calc(${leftPct}% + 1px)`,
              width: `calc(${widthPct}% - 2px)`,
            }}
            onClick={(ev) => onEventClick(e, ev.currentTarget)}
          >
            {startsHere && (
              <span className="et">
                {formatTime(new Date(e.start))}
                {cols === 1 && dur > 30
                  ? `–${formatTime(new Date(e.end))}`
                  : ''}
              </span>
            )}
            <span className="en">
              {e.title}
              <MergeBadge event={e} variant="compact" />
            </span>
          </button>
        );
      })}

      {isToday
        && nowOffset > 0
        && nowOffset < (END_HOUR - START_HOUR + 1) * HOUR_HEIGHT && (
          <div className="now-line" style={{ top: nowOffset }} />
      )}

      <RhythmLine
        kind="wake"
        y={wakeY}
        min={rhythm.wakeMin}
        overridden={rhythm.overridden}
        dateStr={dateStr}
        onChange={onSetRhythmOverride}
        onReset={onClearRhythmOverride}
      />
      <RhythmLine
        kind="sleep"
        y={sleepY}
        min={rhythm.sleepMin}
        overridden={rhythm.overridden}
        dateStr={dateStr}
        onChange={onSetRhythmOverride}
        onReset={onClearRhythmOverride}
      />

      {dropPreview && (
        <div className="drop-preview-line" style={{ top: dropPreview.y }}>
          <span className="drop-preview-label">{minToLabel(dropPreview.min)}</span>
        </div>
      )}
    </div>
  );
}

function ScheduledTaskChip({
  task, dateStr, start, col, cols, onToggleDone, onOpen,
}: {
  task: TaskItem;
  dateStr: string;
  start: string;
  col: number;
  cols: number;
  onToggleDone?: (id: string) => void;
  onOpen?: (id: string) => void;
}) {
  const [h, m] = start.split(':').map((n) => parseInt(n, 10) || 0);
  const sMin = h * 60 + m;
  const dur = task.dur || 30;
  const top = ((sMin / 60) - START_HOUR) * HOUR_HEIGHT;
  const height = Math.max(20, (dur / 60) * HOUR_HEIGHT);
  const widthPct = 100 / cols;
  const leftPct = widthPct * col;

  const drag = useDragSource({
    type: 'task',
    payload: { taskId: task.id, source: 'scheduled' },
    makePreview: () => (
      <div className="drag-preview-task">
        <span className="drag-preview-glyph" />
        <span className="drag-preview-ttl">{task.title}</span>
        <span className="drag-preview-dur">{formatDur(dur)}</span>
      </div>
    ),
  });

  // Short chips can't fit the two-row body (time/dur subtitle + title) inside
  // their height. Mirror the event "short"/"tiny" treatment: drop the time
  // subtitle and lay the checkbox + title out in a single line.
  const cn = ['tv-task-chip'];
  if (task.done) cn.push('done');
  if (dur < 15) cn.push('tiny');
  else if (dur <= 30) cn.push('short');

  const compact = dur <= 30;

  return (
    <div
      className={cn.join(' ')}
      style={{
        top,
        height,
        left: `calc(${leftPct}% + 1px)`,
        width: `calc(${widthPct}% - 2px)`,
        ['--proj' as never]: '#5b7a8e',
      }}
      draggable={drag.draggable}
      onDragStart={drag.onDragStart}
      onPointerDown={drag.onPointerDown}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('.tv-task-tbox')) return;
        onOpen?.(task.id);
      }}
      title={`${task.title} · ${minToLabel(sMin)} · ${formatDur(dur)} — drag to reschedule, drag back to inbox to unschedule`}
      data-date={dateStr}
    >
      <button
        className="tv-task-tbox"
        onClick={(e) => { e.stopPropagation(); onToggleDone?.(task.id); }}
        aria-label="Mark done"
      />
      <div className="tv-task-body">
        {!compact && (
          <div className="tv-task-t">{minToLabel(sMin)} · {formatDur(dur)}</div>
        )}
        <div className="tv-task-ttl">{renderInlineCode(task.title)}</div>
      </div>
    </div>
  );
}

interface RhythmLineProps {
  kind: 'wake' | 'sleep';
  y: number;
  min: number;
  overridden: boolean;
  dateStr: string;
  onChange?: (dateStr: string, patch: { wakeMin?: number; sleepMin?: number }) => void;
  onReset?: (dateStr: string) => void;
}

function RhythmLine({
  kind, y, min, overridden, dateStr, onChange, onReset,
}: RhythmLineProps) {
  const [active, setActive] = useState(false);
  const [hover, setHover] = useState(min);

  // Drag the line vertically — emit override on pointerup. We use raw
  // pointer events directly here (no shared drag controller) because the
  // rhythm line is its own little draggable widget, not a drop source.
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('.tv-rhythm-reset')) return;
    e.preventDefault();
    setActive(true);
    const lineEl = e.currentTarget;
    const colEl = lineEl.parentElement as HTMLElement;
    const colRect = colEl.getBoundingClientRect();
    let lastMin = min;
    const onMove = (m: PointerEvent) => {
      const localY = m.clientY - colRect.top;
      const mins = snap15(Math.round(((localY / HOUR_HEIGHT) + START_HOUR) * 60));
      lastMin = mins;
      setHover(mins);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      setActive(false);
      if (lastMin !== min && onChange) {
        const patch = kind === 'wake'
          ? { wakeMin: lastMin }
          : { sleepMin: lastMin };
        onChange(dateStr, patch);
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const displayY = active
    ? ((hover / 60) - START_HOUR) * HOUR_HEIGHT
    : y;
  const displayMin = active ? hover : min;

  const cls = ['tv-rhythm-line', kind];
  if (active) cls.push('active');
  if (overridden) cls.push('overridden');

  return (
    <div
      className={cls.join(' ')}
      style={{ top: displayY }}
      onPointerDown={onPointerDown}
      title={kind === 'wake' ? 'Wake — drag to adjust this day' : 'Sleep — drag to adjust this day'}
    >
      <span className="tv-rhythm-label">
        <span className="tv-rhythm-glyph">{kind === 'wake' ? '☀' : '☾'}</span>
        {kind} · {formatRhythmTime(displayMin)}
        {overridden && onReset && (
          <button
            type="button"
            className="tv-rhythm-reset"
            title="Revert to default"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onReset(dateStr); }}
          >↺</button>
        )}
      </span>
    </div>
  );
}

function minToLabel(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  const fake = new Date(2000, 0, 1, h, m);
  return formatTime(fake);
}
