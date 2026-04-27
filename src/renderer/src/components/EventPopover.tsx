import { useLayoutEffect, useRef, useState } from 'react';
import type { CalendarEvent, CalendarSummary, AccountSummary } from '@shared/types';
import { DOW_LONG, MONTH_NAMES, formatTimeFull, ordinal } from '../dates';
import { rsvpClass, rsvpLabel } from '../rsvp';
import { avatarBg, initials } from './MacTitleBar';
import { DescriptionHTML } from './DescriptionHTML';
import { MergeBadge } from './MergeBadge';

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
  const rc = rsvpClass(event);
  const rLabel = rsvpLabel(event.rsvp);

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
        <div className="pp-cal">{cal ? cal.name : 'Event'}</div>
        <div className={'pp-title' + (rc ? ' ' + rc : '')}>
          {event.title}
          <MergeBadge event={event} />
        </div>
        {rc && rLabel && (
          <div className="pp-rsvp">
            <span className={'pp-rsvp-pill ' + rc}>{rLabel}</span>
          </div>
        )}
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
            <span className="k">Also on</span>
            <span className="v pp-merged">
              {/* Skip the first source — it's the canonical event already
                  shown above as the calendar/account. The "Also on" list
                  surfaces every other calendar this event lives in. */}
              {merged.slice(1).map((m) => {
                const c = calendars.find((cc) => cc.id === m.calendarId);
                const a = accounts.find((aa) => aa.id === m.accountId);
                return (
                  <span key={m.id} className="pp-merged-row">
                    <span className="pp-merged-dot" style={{ background: m.color }} />
                    <span className="pp-merged-name">{c ? c.name : m.calendarId}</span>
                    {a && <span className="pp-merged-acct">· {a.email}</span>}
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
