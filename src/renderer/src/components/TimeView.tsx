import { useEffect, useMemo, useRef } from 'react';
import type { CalendarEvent } from '@shared/types';
import {
  DOW_SHORT, fmtDate, formatTime, minutesOfDate, sameYMD,
} from '../dates';
import {
  eventTouchesDay, isMultiDayAllDay, layoutRangeRibbons,
  type RibbonPlacement,
} from '../multiday';
import { type CalRoles, isHolidayEvent } from '../calRoles';

interface Props {
  today: Date;
  days: Date[];
  events: CalendarEvent[];
  calRoles: CalRoles;
  onEventClick: (e: CalendarEvent, anchor: HTMLElement) => void;
}

const HOUR_HEIGHT = 56;
const START_HOUR = 6;
const END_HOUR = 23;

interface Placed {
  item: CalendarEvent;
  col: number;
  cols: number;
  sMin: number;
  eMin: number;
}

// Sweep overlapping events into columns so 15-min slots don't crash into each other.
function layoutColumns(items: CalendarEvent[]): Placed[] {
  const sorted = items.slice().sort((a, b) => {
    const sa = minutesOfDate(new Date(a.start));
    const sb = minutesOfDate(new Date(b.start));
    if (sa !== sb) return sa - sb;
    return minutesOfDate(new Date(b.end)) - minutesOfDate(new Date(a.end));
  });

  const placed: Array<{ item: CalendarEvent; col: number; sMin: number; eMin: number }> = [];
  const clusterIds: number[] = [];
  const clusterCounts: number[] = [];
  let curCluster = -1;
  let curEnd = -Infinity;

  for (const e of sorted) {
    const sMin = minutesOfDate(new Date(e.start));
    const eMin = minutesOfDate(new Date(e.end));
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

export function TimeView({ today, days, events, calRoles, onEventClick }: Props) {
  const hours = Array.from({ length: END_HOUR - START_HOUR + 1 }, (_, i) => i + START_HOUR);
  const colTemplate = `60px repeat(${days.length}, 1fr)`;
  const bodyRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = HOUR_HEIGHT * 1;
  }, []);

  const nowMinutes = today.getHours() * 60 + today.getMinutes();
  const nowOffset = ((nowMinutes / 60) - START_HOUR) * HOUR_HEIGHT;

  // Single-day all-day events render inside their cell. Multi-day all-day
  // events render as connected ribbons in the overlay below.
  const allDayByDay = useMemo(() => {
    const m: Record<string, CalendarEvent[]> = {};
    for (const d of days) {
      m[fmtDate(d)] = events.filter(
        (e) => e.allDay && !isMultiDayAllDay(e) && eventTouchesDay(e, d),
      );
    }
    return m;
  }, [days, events]);

  const ribbons = useMemo<RibbonPlacement[]>(
    () => (days.length === 0 ? [] : layoutRangeRibbons(events, days[0], days.length)),
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
      const key = fmtDate(new Date(e.start));
      if (m[key]) m[key].push(e);
    }
    return m;
  }, [days, events]);

  return (
    <div className="time-view">
      <div className="tv-header">
        <div style={{ display: 'grid', gridTemplateColumns: colTemplate }}>
          <div style={{ borderRight: '0.5px solid var(--rule)' }} />
          {days.map((d) => {
            const isToday = sameYMD(d, today);
            return (
              <div
                key={fmtDate(d)}
                className={'tv-col-head ' + (isToday ? 'today' : '')}
              >
                <div className="dow">{DOW_SHORT[d.getDay()]}</div>
                <div className="num">{d.getDate()}</div>
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
            // Dedupe single-day all-day events by title within the cell so
            // duplicate holiday entries from multiple calendars don't double up.
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
                      {e.mergedFrom && e.mergedFrom.length > 1 && (
                        <span className="dup-badge">×{e.mergedFrom.length}</span>
                      )}
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
                      {e.mergedFrom && e.mergedFrom.length > 1 && (
                        <span className="dup-badge">×{e.mergedFrom.length}</span>
                      )}
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
            const dayTimed = timedByDay[fmtDate(d)] ?? [];
            const laid = layoutColumns(dayTimed);
            return (
              <div
                key={fmtDate(d)}
                className={'tv-col ' + (isToday ? 'today-col' : '')}
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
                  const cn = ['tv-event'];
                  if (dur < 15) cn.push('tiny');
                  else if (dur <= 30) cn.push('short');
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
                      <span className="et">
                        {formatTime(new Date(e.start))}
                        {cols === 1 && dur > 30
                          ? `–${formatTime(new Date(e.end))}`
                          : ''}
                      </span>
                      <span className="en">
                        {e.title}
                        {e.mergedFrom && e.mergedFrom.length > 1 && (
                          <span className="dup-badge">×{e.mergedFrom.length}</span>
                        )}
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
