import type { ReactNode } from 'react';

export type WeatherGlyph =
  | 'sun' | 'partly-cloudy' | 'cloud' | 'drizzle' | 'rain' | 'thunder'
  | 'snow' | 'sleet' | 'fog' | 'wind' | 'hot' | 'cold'
  | 'night-clear' | 'night-cloudy';

// Full SVG icon set. Every icon renders in currentColor on a 24×24 viewBox
// so callers control color via parent CSS.
const ICONS: Record<WeatherGlyph, ReactNode> = {
  sun: (
    <g>
      <circle cx="12" cy="12" r="4.5" fill="currentColor" />
      {[0, 45, 90, 135, 180, 225, 270, 315].map((a) => (
        <line key={a} x1="12" y1="3" x2="12" y2="5.5"
              stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
              transform={`rotate(${a} 12 12)`} />
      ))}
    </g>
  ),
  'partly-cloudy': (
    <g fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="9" cy="8" r="3" fill="currentColor" stroke="none" />
      <line x1="9" y1="2.5" x2="9" y2="4" />
      <line x1="3.5" y1="8" x2="2" y2="8" />
      <line x1="5" y1="4" x2="4" y2="3" />
      <line x1="13" y1="4" x2="14" y2="3" />
      <path d="M16 19 H8 A4 4 0 0 1 8 11 a5 5 0 0 1 9.5 1.5 A3.5 3.5 0 0 1 16 19 Z"
            fill="var(--paper, #fff)" />
    </g>
  ),
  cloud: (
    <path d="M17 18 H7 A4 4 0 0 1 7 10 a5.5 5.5 0 0 1 10.5 1.5 A3.5 3.5 0 0 1 17 18 Z"
          fill="currentColor" />
  ),
  drizzle: (
    <g>
      <path d="M17 14 H7 A4 4 0 0 1 7 6 a5.5 5.5 0 0 1 10.5 1.5 A3.5 3.5 0 0 1 17 14 Z"
            fill="currentColor" />
      {[[8, 17], [12, 17], [16, 17], [10, 20], [14, 20]].map(([x, y]) => (
        <line key={`${x},${y}`} x1={x} y1={y} x2={x - 1} y2={y + 2}
              stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      ))}
    </g>
  ),
  rain: (
    <g>
      <path d="M17 13 H7 A4 4 0 0 1 7 5 a5.5 5.5 0 0 1 10.5 1.5 A3.5 3.5 0 0 1 17 13 Z"
            fill="currentColor" />
      {[[8, 16], [12, 16], [16, 16], [10, 19], [14, 19]].map(([x, y]) => (
        <line key={`${x},${y}`} x1={x} y1={y} x2={x - 1.5} y2={y + 3}
              stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      ))}
    </g>
  ),
  thunder: (
    <g>
      <path d="M17 12 H7 A4 4 0 0 1 7 4 a5.5 5.5 0 0 1 10.5 1.5 A3.5 3.5 0 0 1 17 12 Z"
            fill="currentColor" />
      <path d="M11 13 L8 18 H11 L9 22 L15 16 H12 L14 13 Z"
            fill="currentColor" />
    </g>
  ),
  snow: (
    <g>
      <path d="M17 13 H7 A4 4 0 0 1 7 5 a5.5 5.5 0 0 1 10.5 1.5 A3.5 3.5 0 0 1 17 13 Z"
            fill="currentColor" />
      {[[8, 17], [12, 18], [16, 17], [10, 20], [14, 20]].map(([x, y]) => (
        <g key={`${x},${y}`} stroke="currentColor" strokeWidth="1.2" strokeLinecap="round">
          <line x1={x - 1} y1={y} x2={x + 1} y2={y} />
          <line x1={x} y1={y - 1} x2={x} y2={y + 1} />
          <line x1={x - 0.7} y1={y - 0.7} x2={x + 0.7} y2={y + 0.7} />
          <line x1={x - 0.7} y1={y + 0.7} x2={x + 0.7} y2={y - 0.7} />
        </g>
      ))}
    </g>
  ),
  sleet: (
    <g>
      <path d="M17 13 H7 A4 4 0 0 1 7 5 a5.5 5.5 0 0 1 10.5 1.5 A3.5 3.5 0 0 1 17 13 Z"
            fill="currentColor" />
      <line x1="9" y1="16" x2="8" y2="19"
            stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <g transform="translate(13 17.5)" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round">
        <line x1="-1.5" y1="0" x2="1.5" y2="0" />
        <line x1="0" y1="-1.5" x2="0" y2="1.5" />
        <line x1="-1" y1="-1" x2="1" y2="1" />
        <line x1="-1" y1="1" x2="1" y2="-1" />
      </g>
      <line x1="17" y1="16" x2="16" y2="19"
            stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </g>
  ),
  fog: (
    <g stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none">
      <line x1="3" y1="7" x2="21" y2="7" />
      <line x1="5" y1="11" x2="19" y2="11" />
      <line x1="3" y1="15" x2="21" y2="15" />
      <line x1="6" y1="19" x2="18" y2="19" />
    </g>
  ),
  wind: (
    <g fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <path d="M3 8 H14 a2.5 2.5 0 1 0 -2.5 -2.5" />
      <path d="M3 13 H18 a2.5 2.5 0 1 1 -2.5 2.5" />
      <path d="M3 18 H11 a2 2 0 1 0 -2 -2" />
    </g>
  ),
  hot: (
    <g>
      <circle cx="12" cy="12" r="4" fill="currentColor" />
      {[0, 45, 90, 135, 180, 225, 270, 315].map((a) => (
        <line key={a} x1="12" y1="2.5" x2="12" y2="5.5"
              stroke="currentColor" strokeWidth="2" strokeLinecap="round"
              transform={`rotate(${a} 12 12)`} />
      ))}
      <text x="12" y="14.5" textAnchor="middle" fontSize="6.5"
            fontFamily="var(--mono)" fontWeight="700"
            fill="var(--paper, #fff)">H</text>
    </g>
  ),
  cold: (
    <g stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none">
      <line x1="12" y1="3" x2="12" y2="21" />
      <line x1="4" y1="7.5" x2="20" y2="16.5" />
      <line x1="4" y1="16.5" x2="20" y2="7.5" />
      <polyline points="9.5,5 12,3 14.5,5" />
      <polyline points="9.5,19 12,21 14.5,19" />
      <polyline points="5.5,9.5 4,7.5 6.5,6.5" />
      <polyline points="17.5,17 20,16.5 18.5,18.5" />
    </g>
  ),
  'night-clear': (
    <path d="M19 14 A8 8 0 1 1 10 5 a6.5 6.5 0 0 0 9 9 Z"
          fill="currentColor" />
  ),
  'night-cloudy': (
    <g>
      <path d="M14 8 A4 4 0 1 1 9 4 a3 3 0 0 0 5 4 Z"
            fill="currentColor" />
      <path d="M17 18 H7 A4 4 0 0 1 7 10 a5.5 5.5 0 0 1 10.5 1.5 A3.5 3.5 0 0 1 17 18 Z"
            fill="currentColor" opacity="0.85" />
    </g>
  ),
};

export function WeatherIcon({
  glyph, size = 18,
}: { glyph: string | null; size?: number }) {
  const node = glyph && (ICONS as Record<string, ReactNode>)[glyph];
  if (!node) {
    return (
      <span style={{
        display: 'inline-block', width: size, height: size, fontSize: size,
        lineHeight: 1, color: 'var(--ink-faint)',
      }}>·</span>
    );
  }
  return (
    <svg viewBox="0 0 24 24" width={size} height={size}
         className="weather-icon" aria-hidden="true">
      {node}
    </svg>
  );
}
