import { getWeatherUrl } from './settings';

export interface WeatherDay {
  date: string; // YYYY-MM-DD
  glyph: string | null; // first emoji-like character extracted from SUMMARY
  hi: number | null;
  lo: number | null;
  summary: string; // raw SUMMARY for tooltip
}

interface CacheEntry {
  url: string;
  fetchedAt: number;
  days: WeatherDay[];
}

let cache: CacheEntry | null = null;
const TTL_MS = 30 * 60 * 1000; // 30 min

function decodeIcsValue(v: string): string {
  // RFC 5545: backslash-escaped commas, semicolons, newlines.
  return v
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

function unfoldLines(text: string): string[] {
  // RFC 5545 line folding: a line starting with space or tab continues the
  // previous line. Strip CRLF, then merge folded continuations.
  const raw = text.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  for (const line of raw) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length > 0) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

function parseIcsDate(value: string): string | null {
  // Accept YYYYMMDD (DTSTART;VALUE=DATE) and YYYYMMDDTHHMMSS(Z)?.
  const m = value.match(/^(\d{4})(\d{2})(\d{2})/);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

// We render forecast glyphs in the editorial serif column, so colored emoji
// (☀️ 🌧 ⛈ 🌦) clash visually with the rest of the typography. Map weather
// keywords (and well-known emoji) to a fixed set of monochrome typographic
// characters, then strip variation selectors so the OS renders text-style.
const GLYPH_MAP: Array<[RegExp, string]> = [
  [/(thunder|storm|lightning|⛈|🌩|⚡)/i, '⚡'],
  [/(snow|flurr|sleet|❄|🌨|☃)/i, '❄'],
  [/(rain|shower|drizzle|☔|🌧|🌦)/i, '☂'],
  [/(fog|mist|haze|smoke|🌫)/i, '☁'],
  [/(part(ly|ial)?\s*(sun|cloud)|⛅)/i, '☁'],
  [/(cloud|overcast|☁)/i, '☁'],
  [/(sun|clear|fair|☀|🌞|🌤)/i, '☀'],
  [/(wind|breez|💨)/i, '∿'],
];
function extractGlyph(summary: string): string | null {
  for (const [re, glyph] of GLYPH_MAP) {
    if (re.test(summary)) return glyph;
  }
  return null;
}

function extractTemps(summary: string): { hi: number | null; lo: number | null } {
  // Match runs of (-?\d+)° optionally with F/C suffix. Take the largest as
  // hi, smallest as lo. Single number → hi only.
  const matches = [...summary.matchAll(/(-?\d+)\s*°/g)].map((m) => parseInt(m[1], 10));
  if (matches.length === 0) return { hi: null, lo: null };
  if (matches.length === 1) return { hi: matches[0], lo: null };
  const hi = Math.max(...matches);
  const lo = Math.min(...matches);
  return { hi, lo };
}

function parseIcs(text: string): WeatherDay[] {
  const lines = unfoldLines(text);
  const days: WeatherDay[] = [];
  let inEvent = false;
  let curDate: string | null = null;
  let curSummary = '';

  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      inEvent = true;
      curDate = null;
      curSummary = '';
      continue;
    }
    if (line === 'END:VEVENT') {
      if (inEvent && curDate) {
        const { hi, lo } = extractTemps(curSummary);
        days.push({
          date: curDate,
          glyph: extractGlyph(curSummary),
          hi,
          lo,
          summary: curSummary,
        });
      }
      inEvent = false;
      continue;
    }
    if (!inEvent) continue;
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const head = line.slice(0, colonIdx);
    const value = line.slice(colonIdx + 1);
    const name = head.split(';')[0];
    if (name === 'DTSTART') {
      curDate = parseIcsDate(value);
    } else if (name === 'SUMMARY') {
      curSummary = decodeIcsValue(value);
    }
  }
  return days;
}

export function clearWeatherCache(): void {
  cache = null;
}

export async function fetchWeather(): Promise<WeatherDay[]> {
  const url = getWeatherUrl();
  if (!url) return [];

  if (cache && cache.url === url && Date.now() - cache.fetchedAt < TTL_MS) {
    return cache.days;
  }

  // Some feeds use webcal:// — convert to https://.
  const httpUrl = url.replace(/^webcal:\/\//i, 'https://');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(httpUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'yCal/0.1',
        Accept: 'text/calendar, text/plain, */*',
      },
      redirect: 'follow',
    });
    if (!res.ok) {
      throw new Error(`Weather feed returned ${res.status} ${res.statusText}`);
    }
    const text = await res.text();
    if (!text.includes('BEGIN:VCALENDAR')) {
      throw new Error('Weather URL did not return an iCalendar feed.');
    }
    const days = parseIcs(text);
    cache = { url, fetchedAt: Date.now(), days };
    console.log(`[yCal weather] fetched ${days.length} days from ${httpUrl}`);
    return days;
  } catch (e) {
    console.error('[yCal weather] fetch failed:', e);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
