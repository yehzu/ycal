import { useEffect, useMemo, useRef } from 'react';
import type { CalendarEvent } from '@shared/types';
import {
  DOW_SHORT, addDays, fmtDate, formatTime, getISOWeek, sameYMD,
} from '../dates';
import {
  eventTouchesDay, isEventStartDay, isMultiDayAllDay, layoutRangeRibbons,
  type RibbonPlacement,
} from '../multiday';
import { type CalRoles, isHolidayEvent } from '../calRoles';
import { dayHolidayInfo } from '../holidays';
import { isLocationEvent, locKindOf, locLabelOf } from '../locations';
import { rsvpClass } from '../rsvp';
import { LocationIcon } from './LocationIcon';
import { MergeBadge } from './MergeBadge';

interface Props {
  today: Date;
  days: Date[];
  events: CalendarEvent[];
  calRoles: CalRoles;
  onEventClick: (e: CalendarEvent, anchor: HTMLElement) => void;
  showWeekNums: boolean;
}

const HOUR_HEIGHT = 56;
const START_HOUR = 0;
const END_HOUR = 23;

interface Placed {
  item: CalendarEvent;
  col: number;
  cols: number;
  sMin: number;
  eMin: number;
}

// Sweep overlapping events into columns so 15-min slots don't crash into each other.
// Minutes are clipped to [0, 1440] within `day` so an event spanning midnight
// renders on both days with the right segment in each.
function layoutColumns(items: CalendarEvent[], day: Date): Placed[] {
  const dayStartMs = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
  const dayEndMs = dayStartMs + 24 * 60 * 60 * 1000;

  const clipped = items.map((e) => {
    const evS = new Date(e.start).getTime();
    const evE = new Date(e.end).getTime();
    const sMin = evS <= dayStartMs ? 0 : Math.round((evS - dayStartMs) / 60000);
    const eMin = evE >= dayEndMs ? 24 * 60 : Math.round((evE - dayStartMs) / 60000);
    return { item: e, sMin, eMin };
  });

  const sorted = clipped.slice().sort((a, b) => {
    if (a.sMin !== b.sMin) return a.sMin - b.sMin;
    return b.eMin - a.eMin;
  });

  const placed: Array<{ item: CalendarEvent; col: number; sMin: number; eMin: number }> = [];
  const clusterIds: number[] = [];
  const clusterCounts: number[] = [];
  let curCluster = -1;
  let curEnd = -Infinity;

  for (const c of sorted) {
    const { item: e, sMin, eMin } = c;
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
    placed.push({ item: e, col, sMin, eMin });
    clusterIds.push(curCluster);
    clusterCounts[curCluster] = Math.max(clusterCounts[curCluster] ?? 0, col + 1);
  }

  return placed.map((p, i) => ({
    item: p.item,
    col: p.col,
    sMin: p.sMin,
    eMin: p.eMin,
    cols: clusterCounts[clusterIds[i]],
  }));
}

export function TimeView({
  today, days, events, calRoles, onEventClick, showWeekNums,
}: Props) {
  const hours = Array.from({ length: END_HOUR - START_HOUR + 1 }, (_, i) => i + START_HOUR);
  const colTemplate = `60px repeat(${days.length}, 1fr)`;
  const bodyRef = useRef<HTMLDivElement | null>(null);

  // Default scroll: park the visible window so "now" is roughly 90 minutes
  // below the top edge. Falls back to 6am for past days / overnight.
  useEffect(() => {
    if (!bodyRef.current) return;
    const showsToday = days.some((d) => sameYMD(d, today));
    const baseMin = showsToday
      ? today.getHours() * 60 + today.getMinutes() - 90
      : 6 * 60;
    const targetMin = Math.max(0, Math.min(baseMin, (END_HOUR - START_HOUR) * 60));
    bodyRef.current.scrollTop = (targetMin / 60) * HOUR_HEIGHT;
  // We intentionally re-scroll when the visible day-set or current time changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days[0]?.getTime(), days.length]);

  const nowMinutes = today.getHours() * 60 + today.getMinutes();
  const nowOffset = ((nowMinutes / 60) - START_HOUR) * HOUR_HEIGHT;

  // Single-day all-day events render inside their cell. Multi-day all-day
  // events render as connected ribbons. Location indicators are pulled out
  // of both — they show as date-adjacent chips.
  const allDayByDay = useMemo(() => {
    const m: Record<string, CalendarEvent[]> = {};
    for (const d of days) {
      m[fmtDate(d)] = events.filter(
        (e) => e.allDay
          && !isMultiDayAllDay(e)
          && !isLocationEvent(e)
          && eventTouchesDay(e, d),
      );
    }
    return m;
  }, [days, events]);

  const ribbons = useMemo<RibbonPlacement[]>(
    () => (days.length === 0
      ? []
      : layoutRangeRibbons(events.filter((e) => !isLocationEvent(e)), days[0], days.length)),
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
      if (isLocationEvent(e)) continue;
      // Cross-midnight events render in every day they touch, clipped per day
      // by layoutColumns. Bucketing only by start day would leave the tail
      // segment invisible on the next day.
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
        .filter((e) => isLocationEvent(e) && eventTouchesDay(e, d))
        .filter((e) => {
          const k = locLabelOf(e).trim().toLowerCase();
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
    }
    return m;
  }, [days, events]);

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
            const headCls = ['tv-col-head'];
            if (isToday) headCls.push('today');
            if (isWeekend && hInfo?.kind !== 'workday') headCls.push('weekend');
            if (hInfo) headCls.push('h-' + hInfo.kind);
            const locs = locationsByDay[fmtDate(d)] ?? [];
            return (
              <div
                key={fmtDate(d)}
                className={headCls.join(' ')}
                style={hInfo?.color ? ({ ['--h-color' as never]: hInfo.color }) : undefined}
                title={hInfo?.label || ''}
              >
                <div className="dow">{DOW_SHORT[d.getDay()]}</div>
                <div className="num">{d.getDate()}</div>
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
          <div
            style={{
              borderRight: '0.5px solid var(--rule)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-end',
              paddingRight: 6,
              fontFamily: 'var(--serif-body)',
              fontSize: 9.5,
              color: 'var(--ink-mute)',
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
            }}
          >
            all day
          </div>
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
                      style={{
                        ['--cal' as never]: e.color,
                        ...(holiday ? {} : { background: e.color }),
                      }}
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
                      ...(holiday ? {} : { background: e.color }),
                      // +2 because grid col 1 is the gutter "all day" label.
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
            const colCls = ['tv-col'];
            if (isToday) colCls.push('today-col');
            if (isWeekend && hInfo?.kind !== 'workday') colCls.push('weekend');
            if (hInfo) colCls.push('h-' + hInfo.kind);
            const dayTimed = timedByDay[fmtDate(d)] ?? [];
            const laid = layoutColumns(dayTimed, d);
            return (
              <div
                key={fmtDate(d)}
                className={colCls.join(' ')}
                style={hInfo?.color ? ({ ['--h-color' as never]: hInfo.color }) : undefined}
              >
                {hours.map((h) => (
                  <div
                    key={h}
                    className="tv-grid-row hour"
                    style={{ height: HOUR_HEIGHT }}
                  />
                ))}
                {laid.map(({ item: e, col, sMin, eMin, cols }) => {
                  const top = ((sMin / 60) - START_HOUR) * HOUR_HEIGHT;
                  const dur = eMin - sMin;
                  const height = (dur / 60) * HOUR_HEIGHT;
                  const widthPct = 100 / cols;
                  const leftPct = widthPct * col;
                  const startsHere = isEventStartDay(e, d);
                  const cn = ['tv-event'];
                  if (dur < 15) cn.push('tiny');
                  else if (dur <= 30) cn.push('short');
                  const rc = rsvpClass(e);
                  if (rc) cn.push(rc);
                  return (
                    <button
                      key={e.id}
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
                {isToday &&
                  nowOffset > 0 &&
                  nowOffset < (END_HOUR - START_HOUR + 1) * HOUR_HEIGHT && (
                    <div className="now-line" style={{ top: nowOffset }} />
                  )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
