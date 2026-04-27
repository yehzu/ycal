import { Fragment, useEffect, useState } from 'react';
import {
  DOW_NARROW, MONTH_NAMES, addDays, addMonths, fmtDate,
  getISOWeek, sameYMD, startOfMonth, startOfWeek,
} from '../dates';

interface Props {
  today: Date;
  anchor: Date;
  selected: Date;
  setAnchor: (d: Date) => void;
  setSelected: (d: Date) => void;
  hasEvents: (dateKey: string) => boolean;
  showWeekNums: boolean;
}

export function MiniMonth({
  today, anchor, selected, setAnchor, setSelected, hasEvents, showWeekNums,
}: Props) {
  const [shown, setShown] = useState<Date>(() => startOfMonth(anchor));

  useEffect(() => {
    setShown(startOfMonth(anchor));
  }, [anchor.getFullYear(), anchor.getMonth()]);

  const first = startOfMonth(shown);
  const gridStart = startOfWeek(first, 0);
  // Six week-rows; render row-by-row so the optional wk-column stays aligned
  // with the seven day cells beside it.
  const weekStarts = Array.from({ length: 6 }, (_, w) => addDays(gridStart, w * 7));

  return (
    <div>
      <div className="mini-month-hd">
        <div className="m">{MONTH_NAMES[shown.getMonth()]} {shown.getFullYear()}</div>
        <div className="nav">
          <button onClick={() => setShown(addMonths(shown, -1))}>‹</button>
          <button onClick={() => setShown(addMonths(shown, 1))}>›</button>
        </div>
      </div>
      <div className={'mini-grid' + (showWeekNums ? ' with-wk' : '')}>
        {showWeekNums && <div className="mini-wk-h">wk</div>}
        {DOW_NARROW.map((d, i) => (
          <div key={i} className="mini-dow">{d}</div>
        ))}
        {weekStarts.map((wkStart) => (
          <Fragment key={fmtDate(wkStart)}>
            {showWeekNums && (
              <div className="mini-wk">{getISOWeek(addDays(wkStart, 3))}</div>
            )}
            {Array.from({ length: 7 }, (_, di) => {
              const d = addDays(wkStart, di);
              const inMonth = d.getMonth() === shown.getMonth();
              const isToday = sameYMD(d, today);
              const isSel = sameYMD(d, selected);
              const has = hasEvents(fmtDate(d));
              const cls = ['mini-day'];
              if (!inMonth) cls.push('other');
              if (isToday) cls.push('today');
              if (isSel) cls.push('selected');
              if (has) cls.push('has-events');
              return (
                <button
                  key={fmtDate(d)}
                  className={cls.join(' ')}
                  onClick={() => { setSelected(d); setAnchor(d); }}
                >
                  {d.getDate()}
                </button>
              );
            })}
          </Fragment>
        ))}
      </div>
    </div>
  );
}
