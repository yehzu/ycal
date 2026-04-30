import { useState } from 'react';
import type { EventAttendee } from '@shared/types';

// Stable hash → hue. Keeps avatars in 130–290 (greens through purples) so
// attendee dots can't be confused with calendar reds/oranges.
function attendeeColor(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  const hue = 130 + (Math.abs(h) % 160);
  return `oklch(58% 0.08 ${hue})`;
}

function attendeeInitials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '?';
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) return parts[0]![0]!.toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

const ORDER: Record<EventAttendee['rsvp'], number> = {
  accepted: 2,
  tentative: 3,
  needsAction: 4,
  declined: 5,
};

function rsvpRank(a: EventAttendee): number {
  if (a.organizer) return 0;
  if (a.self) return 1;
  return ORDER[a.rsvp];
}

interface Props {
  attendees: EventAttendee[];
}

export function PopoverAttendees({ attendees }: Props) {
  const [expanded, setExpanded] = useState(false);

  const counts = { accepted: 0, tentative: 0, declined: 0, needsAction: 0 };
  let total = 0;
  for (const a of attendees) {
    const headcount = 1 + Math.max(0, a.additionalGuests);
    counts[a.rsvp] += headcount;
    total += headcount;
  }

  const sorted = attendees.slice().sort((a, b) => rsvpRank(a) - rsvpRank(b));
  const visible = expanded ? sorted : sorted.slice(0, 5);

  const pill = (cls: string, n: number, label: string) => (n > 0 ? (
    <span className={'pp-att-pill ' + cls}>
      {n}<span className="pp-att-pill-l"> {label}</span>
    </span>
  ) : null);

  return (
    <div className="pp-row pp-att-row">
      <span className="k">Guests</span>
      <span className="v">
        <div className="pp-att-summary">
          <span className="pp-att-count">
            {total} guest{total === 1 ? '' : 's'}
          </span>
          <span className="pp-att-counts">
            {pill('yes', counts.accepted, 'yes')}
            {pill('maybe', counts.tentative, 'maybe')}
            {pill('awaiting', counts.needsAction, 'awaiting')}
            {pill('no', counts.declined, 'no')}
          </span>
        </div>
        <div className={'pp-att-list' + (expanded ? ' expanded' : '')}>
          {visible.map((a, i) => {
            const cls = ['pp-att-row-item'];
            if (a.rsvp === 'declined') cls.push('declined');
            else if (a.rsvp === 'tentative') cls.push('tentative');
            else if (a.rsvp === 'needsAction') cls.push('awaiting');
            const colorKey = a.email || a.name || String(i);
            const labelName = a.name || a.email || 'Unknown';
            const init = attendeeInitials(labelName);
            return (
              <div
                key={colorKey + ':' + i}
                className={cls.join(' ')}
                title={a.email || labelName}
              >
                <span
                  className="pp-att-av"
                  style={{ background: attendeeColor(colorKey), color: '#fff' }}
                >
                  {init}
                </span>
                <span className="pp-att-name">
                  {labelName}
                  {a.organizer && <span className="pp-att-tag">organizer</span>}
                  {a.self && !a.organizer && <span className="pp-att-tag">you</span>}
                  {a.additionalGuests > 0 && (
                    <span className="pp-att-tag">
                      +{a.additionalGuests} guest{a.additionalGuests === 1 ? '' : 's'}
                    </span>
                  )}
                </span>
                <span className="pp-att-rsvp" aria-hidden="true">
                  {a.rsvp === 'accepted' && <span className="pp-att-mark yes" title="Yes">✓</span>}
                  {a.rsvp === 'tentative' && <span className="pp-att-mark maybe" title="Maybe">?</span>}
                  {a.rsvp === 'declined' && <span className="pp-att-mark no" title="No">✕</span>}
                  {a.rsvp === 'needsAction' && <span className="pp-att-mark awaiting" title="Awaiting">·</span>}
                </span>
              </div>
            );
          })}
          {!expanded && sorted.length > visible.length && (
            <button
              className="pp-att-more"
              onClick={() => setExpanded(true)}
            >
              + {sorted.length - visible.length} more
            </button>
          )}
          {expanded && sorted.length > 5 && (
            <button
              className="pp-att-more"
              onClick={() => setExpanded(false)}
            >
              show less
            </button>
          )}
        </div>
      </span>
    </div>
  );
}
