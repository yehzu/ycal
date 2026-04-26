import { useEffect, useState } from 'react';
import {
  DOW_NARROW, MONTH_NAMES, addDays, addMonths, fmtDate,
  sameYMD, startOfMonth, startOfWeek,
} from '../dates';

interface Props {
  today: Date;
  anchor: Date;
  selected: Date;
  setAnchor: (d: Date) => void;
  setSelected: (d: Date) => void;
  hasEvents: (dateKey: string) => boolean;
}

export function MiniMonth({ today, anchor, selected, setAnchor, setSelected, hasEvents }: Props) {
  const [shown, setShown] = useState<Date>(() => startOfMonth(anchor));

  useEffect(() => {
    setShown(startOfMonth(anchor));
  }, [anchor.getFullYear(), anchor.getMonth()]);

  const first = startOfMonth(shown);
  const gridStart = startOfWeek(first, 0);
  const cells = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));

  return (
    <div>
      <div className="mini-month-hd">
        <div className="m">{MONTH_NAMES[shown.getMonth()]} {shown.getFullYear()}</div>
        <div className="nav">
          <button onClick={() => setShown(addMonths(shown, -1))}>‹</button>
          <button onClick={() => setShown(addMonths(shown, 1))}>›</button>
        </div>
      </div>
      <div className="mini-grid">
        {DOW_NARROW.map((d, i) => (
          <div key={i} className="mini-dow">{d}</div>
        ))}
        {cells.map((d) => {
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
      </div>
    </div>
  );
}
