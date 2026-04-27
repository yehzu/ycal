import type { LocKind } from '../locations';

interface Props {
  kind: LocKind;
  title?: string;
}

// Tiny inline 12×12 glyph for one of the four working-location buckets.
// Color comes from the parent's `color: var(--cal)` so the icon picks up
// the underlying primary calendar's tint.
export function LocationIcon({ kind, title }: Props) {
  const k = kind || 'other';
  const path = (() => {
    switch (k) {
      case 'office':
        return (
          <g fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2.5" y="3" width="7" height="7.5" />
            <line x1="4.5" y1="5" x2="4.5" y2="5.01" />
            <line x1="7.5" y1="5" x2="7.5" y2="5.01" />
            <line x1="4.5" y1="7" x2="4.5" y2="7.01" />
            <line x1="7.5" y1="7" x2="7.5" y2="7.01" />
            <line x1="5.5" y1="10.5" x2="6.5" y2="10.5" />
          </g>
        );
      case 'home':
        return (
          <g fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2 6.5 L6 3 L10 6.5 V10.5 H2 Z" />
            <path d="M5 10.5 V8 H7 V10.5" />
          </g>
        );
      case 'ooo':
        return (
          <g fill="currentColor">
            <path d="M11 6 L7 6.6 L4.5 4 L3.5 4.2 L5 6.85 L2.5 7.2 L1.6 6.4 L1 6.55 L1.7 7.7 L1 8.85 L1.6 9 L2.5 8.2 L5 8.55 L3.5 11.2 L4.5 11.4 L7 8.8 L11 9.4 Q12 8.7 12 7.7 Q12 6.7 11 6 Z" />
          </g>
        );
      default:
        return (
          <g fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 1.8 C8.2 1.8 9.6 3.4 9.6 5.4 C9.6 7.7 6 11.2 6 11.2 C6 11.2 2.4 7.7 2.4 5.4 C2.4 3.4 3.8 1.8 6 1.8 Z" />
            <circle cx="6" cy="5.3" r="1.2" />
          </g>
        );
    }
  })();
  return (
    <svg
      className={`loc-ico loc-ico-${k}`}
      viewBox="0 0 12 12"
      width="12"
      height="12"
      aria-label={title || k}
    >
      <title>{title || k}</title>
      {path}
    </svg>
  );
}
