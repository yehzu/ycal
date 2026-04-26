import {
  DOW_LONG, MONTH_NAMES, MONTH_SHORT, addDays, addMonths, ordinal, startOfWeek,
} from '../dates';

export type ViewMode = 'month' | 'week' | 'day';

interface Props {
  view: ViewMode;
  setView: (v: ViewMode) => void;
  anchor: Date;
  setAnchor: (d: Date) => void;
  goToToday: () => void;
  loading: boolean;
}

export function MainToolbar({
  view, setView, anchor, setAnchor, goToToday, loading,
}: Props) {
  const monthName = MONTH_NAMES[anchor.getMonth()];
  const yr = anchor.getFullYear();

  let title: React.ReactNode;
  if (view === 'month') {
    title = (
      <>
        <span style={{ fontStyle: 'italic' }}>{monthName}</span>
        <span className="yr">{yr}</span>
      </>
    );
  } else if (view === 'week') {
    const ws = startOfWeek(anchor, 0);
    const we = addDays(ws, 6);
    const sameMo = ws.getMonth() === we.getMonth();
    title = (
      <>
        <span style={{ fontStyle: 'italic' }}>
          {MONTH_SHORT[ws.getMonth()]} {ws.getDate()}
          {sameMo
            ? `–${we.getDate()}`
            : ` – ${MONTH_SHORT[we.getMonth()]} ${we.getDate()}`}
        </span>
        <span className="yr">{yr}</span>
      </>
    );
  } else {
    title = (
      <>
        <span style={{ fontStyle: 'italic' }}>
          {DOW_LONG[anchor.getDay()]}, {monthName} {ordinal(anchor.getDate())}
        </span>
        <span className="yr">{yr}</span>
      </>
    );
  }

  const stepBack = () => {
    if (view === 'month') setAnchor(addMonths(anchor, -1));
    else if (view === 'week') setAnchor(addDays(anchor, -7));
    else setAnchor(addDays(anchor, -1));
  };
  const stepFwd = () => {
    if (view === 'month') setAnchor(addMonths(anchor, 1));
    else if (view === 'week') setAnchor(addDays(anchor, 7));
    else setAnchor(addDays(anchor, 1));
  };

  return (
    <div className="main-toolbar">
      <div className="main-title">{title}</div>
      <div className="main-toolbar-r">
        {loading && <span className="sync-hint">syncing…</span>}
        <button className="icon-btn" onClick={stepBack}>‹</button>
        <button className="icon-btn today-btn" onClick={goToToday}>
          Today
        </button>
        <button className="icon-btn" onClick={stepFwd}>›</button>
        <div className="view-switch" role="tablist" style={{ marginLeft: 6 }}>
          {(['month', 'week', 'day'] as const).map((v) => (
            <button
              key={v}
              role="tab"
              aria-pressed={view === v}
              onClick={() => setView(v)}
            >
              {v}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
