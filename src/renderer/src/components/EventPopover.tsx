import { useLayoutEffect, useRef, useState } from 'react';
import type { CalendarEvent, CalendarSummary, AccountSummary } from '@shared/types';
import { DOW_LONG, MONTH_NAMES, formatTimeFull, ordinal } from '../dates';
import { avatarBg, initials } from './MacTitleBar';
import { DescriptionHTML } from './DescriptionHTML';

interface Props {
  event: CalendarEvent;
  anchor: HTMLElement | null;
  calendars: CalendarSummary[];
  accounts: AccountSummary[];
  onClose: () => void;
}

export function EventPopover({ event, anchor, calendars, accounts, onClose }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });

  useLayoutEffect(() => {
    if (!anchor || !ref.current) return;
    const a = anchor.getBoundingClientRect();
    const p = ref.current.getBoundingClientRect();
    let left = a.left + a.width / 2 - p.width / 2;
    let top = a.bottom + 8;
    const margin = 12;
    left = Math.max(margin, Math.min(window.innerWidth - p.width - margin, left));
    if (top + p.height > window.innerHeight - margin) {
      top = Math.max(margin, a.top - p.height - 8);
    }
    setPos({ top, left });
  }, [anchor]);

  const cal = calendars.find((c) => c.id === event.calendarId);
  const acct = accounts.find((a) => a.id === event.accountId);
  const startD = new Date(event.start);
  const endD = new Date(event.end);
  const merged = event.mergedFrom && event.mergedFrom.length > 1 ? event.mergedFrom : null;

  const openInGoogle = () => {
    if (event.htmlLink) {
      // Renderer can't shell.openExternal directly; fall back to window.open
      // which Electron will route via the will-frame-navigate handler. Since
      // we set CSP connect-src to 'self', a plain anchor is safer.
      window.open(event.htmlLink, '_blank', 'noopener');
    }
  };

  return (
    <>
      <div className="popover-backdrop" onClick={onClose} />
      <div
        className="popover"
        ref={ref}
        style={{ top: pos.top, left: pos.left, ['--cal' as never]: event.color }}
      >
        <button className="pp-close" onClick={onClose}>✕</button>
        <div className="pp-cal">
          {cal ? cal.name : 'Event'}
          {merged && (
            <span className="dup-badge" style={{ marginLeft: 8 }}>
              ×{merged.length} merged
            </span>
          )}
        </div>
        <div className="pp-title">{event.title}</div>
        <hr className="pp-rule" />
        <div className="pp-row">
          <span className="k">When</span>
          <span className="v">
            {DOW_LONG[startD.getDay()]}, {MONTH_NAMES[startD.getMonth()]}{' '}
            {ordinal(startD.getDate())}
            {!event.allDay && (
              <span className="mono" style={{ display: 'block', marginTop: 4 }}>
                {formatTimeFull(startD)} – {formatTimeFull(endD)}
              </span>
            )}
            {event.allDay && (
              <span
                style={{
                  display: 'block',
                  fontStyle: 'italic',
                  color: 'var(--ink-mute)',
                  marginTop: 2,
                }}
              >
                All day
              </span>
            )}
          </span>
        </div>
        {event.location && (
          <div className="pp-row">
            <span className="k">Where</span>
            <span className="v" style={{ fontStyle: 'italic' }}>{event.location}</span>
          </div>
        )}
        {event.description && (
          <div className="pp-row">
            <span className="k">Notes</span>
            <span className="v" style={{ minWidth: 0 }}>
              <DescriptionHTML html={event.description} />
            </span>
          </div>
        )}
        {acct && (
          <div className="pp-row">
            <span className="k">Account</span>
            <span className="v pp-acct">
              <span className="av" style={{ background: avatarBg(acct.id) }}>
                {initials(acct)}
              </span>
              {acct.email}
            </span>
          </div>
        )}
        {merged && (
          <div className="pp-row">
            <span className="k">In</span>
            <span className="v" style={{ fontSize: 12, lineHeight: 1.55 }}>
              {merged.map((m) => {
                const c = calendars.find((cc) => cc.id === m.calendarId);
                return (
                  <span key={m.id} style={{ display: 'block' }}>
                    <span
                      style={{
                        display: 'inline-block',
                        width: 8,
                        height: 8,
                        background: m.color,
                        marginRight: 6,
                        verticalAlign: 1,
                      }}
                    />
                    {c ? c.name : m.calendarId}
                  </span>
                );
              })}
            </span>
          </div>
        )}
        <div className="pp-actions">
          {event.htmlLink && (
            <button className="pp-btn primary" onClick={openInGoogle}>
              Open in Google
            </button>
          )}
          <button className="pp-btn" onClick={onClose} style={{ marginLeft: 'auto' }}>
            Close
          </button>
        </div>
      </div>
    </>
  );
}
