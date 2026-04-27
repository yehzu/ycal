import type { WeatherDay } from '@shared/types';
import { fmtDate } from '../dates';
import { WeatherIcon } from './WeatherIcon';

// Source temps come back from the iCal feed in whatever units the feed
// produces (typically °F from weather-in-calendar.com). When the user
// picks °C we convert on the way out.
const fToC = (f: number): number => Math.round((f - 32) * 5 / 9);
const tempForDisplay = (n: number, units: 'F' | 'C'): number =>
  units === 'C' ? fToC(n) : Math.round(n);

interface Props {
  date: Date;
  days: WeatherDay[];
  units?: 'F' | 'C';
  variant?: 'compact' | 'header';
}

// Tiny weather pill rendered inside calendar cells (month, compact) and
// date headers (week/day, header). Returns null when no forecast exists
// for the date so callers don't have to guard.
export function WeatherChip({
  date, days, units = 'F', variant = 'compact',
}: Props) {
  const w = days.find((d) => d.date === fmtDate(date));
  if (!w || (w.hi == null && w.lo == null && !w.glyph)) return null;
  const hi = w.hi != null ? tempForDisplay(w.hi, units) : null;
  const lo = w.lo != null ? tempForDisplay(w.lo, units) : null;
  const title = `${w.summary || ''}${
    hi != null ? ` · hi ${hi}°` : ''
  }${lo != null ? ` / lo ${lo}°` : ''}`.trim();
  return (
    <span className={'weather-chip weather-chip-' + variant} title={title}>
      <WeatherIcon glyph={w.glyph} size={variant === 'compact' ? 11 : 14} />
      {(hi != null || lo != null) && (
        <span className="weather-chip-temp">
          {hi != null && <span className="weather-chip-hi">{hi}°</span>}
          {hi != null && lo != null && <span className="weather-chip-sep"> / </span>}
          {lo != null && <span className="weather-chip-lo">{lo}°</span>}
        </span>
      )}
    </span>
  );
}
