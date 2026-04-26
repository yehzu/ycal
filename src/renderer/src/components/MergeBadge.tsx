import type { CalendarEvent } from '@shared/types';

// Visual indicator for events merged from multiple calendars. The compact
// variant is icon-only (used inside small in-cell pills); the full variant
// adds a "×N" count for larger surfaces (popover title, agenda rows).
export function MergeBadge({
  event, variant,
}: { event: CalendarEvent; variant?: 'compact' }) {
  const n = event.mergedFrom?.length ?? 1;
  if (n < 2) return null;
  const cls = ['merge-badge'];
  if (variant) cls.push('mb-' + variant);
  return (
    <span
      className={cls.join(' ')}
      title={`Merged from ${n} calendars`}
      aria-label={`Merged from ${n} calendars`}
    >
      <svg className="mb-icon" viewBox="0 0 14 10" aria-hidden="true">
        <circle cx="4" cy="5" r="3" fill="none" stroke="currentColor" strokeWidth="1" />
        <circle cx="9" cy="5" r="3" fill="currentColor" />
      </svg>
      {variant !== 'compact' && <span className="mb-n">×{n}</span>}
    </span>
  );
}
