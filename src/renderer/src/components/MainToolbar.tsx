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
  onOpenSettings: () => void;
  onOpenSearch: () => void;
}

export function MainToolbar({
  view, setView, anchor, setAnchor, goToToday, loading, onOpenSettings,
  onOpenSearch,
}: Props) {
  // macOS uses ⌘, Windows/Linux uses Ctrl. Detect once for the hint label.
  const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);
  const searchHint = isMac ? '⌘K' : '⌃K';
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
        <button
          className="tb-search-btn"
          onClick={onOpenSearch}
          title={'Search events & todos (' + searchHint + ')'}
          aria-label="Search events and todos"
        >
          <span className="ic" aria-hidden="true">
            <svg
              width="13" height="13" viewBox="0 0 16 16" fill="none"
              stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"
            >
              <circle cx="7" cy="7" r="4.5" />
              <path d="M10.5 10.5L14 14" />
            </svg>
          </span>
          <span className="lbl">Search events &amp; todos</span>
          <span className="kb">{searchHint}</span>
        </button>
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
        <button
          className="icon-btn prefs-btn"
          onClick={onOpenSettings}
          title="Settings (⌘,)"
          aria-label="Open settings"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.25"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="8" cy="8" r="2.2" />
            <path d="M8 1.5v1.8 M8 12.7v1.8 M14.5 8h-1.8 M3.3 8H1.5 M12.6 3.4l-1.27 1.27 M4.67 11.33l-1.27 1.27 M12.6 12.6l-1.27-1.27 M4.67 4.67L3.4 3.4" />
          </svg>
        </button>
      </div>
    </div>
  );
}
