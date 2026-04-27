// AI/LLM-friendly CLI for yCal.
//
// Lives inside the same Electron main process so it shares safeStorage,
// userData, and the Google Calendar code path with the GUI. Detected via
// `--cli` in process.argv from `src/main/index.ts`, which bypasses window
// creation and routes here.
//
// Output contract:
//   • stdout receives exactly one JSON document (or one markdown/text block
//     when --format markdown|text is passed). Pipe-safe.
//   • stderr receives diagnostic logs only — never structured data.
//   • Exit codes: 0 success, 1 usage/runtime error, 2 not configured / no accounts.
//
// LLM-friendly conventions:
//   • Stable JSON shapes documented under each command.
//   • All times ISO 8601 with offset; durations explicit in minutes.
//   • Descriptions HTML-stripped; null when empty.
//   • Calendar/account references include both id + human label.
import { app } from 'electron';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Writable } from 'node:stream';

import { isConfigured } from './config';
import { listAccountSummaries, listAllCalendars, listEvents } from './calendar';
import { listAccounts } from './tokenStore';
import { fetchWeather } from './weather';
import { dedupEvents } from '@shared/dedup';
import { DEFAULT_MERGE_CRITERIA } from '@shared/types';
import type {
  AccountSummary,
  CalendarSummary,
  CalendarEvent,
} from '@shared/types';

const __dirname_ = path.dirname(fileURLToPath(import.meta.url));

function readVersion(): string {
  // The bundled main lives at out/main/index.js; package.json is two levels up.
  const candidates = [
    path.resolve(__dirname_, '../../package.json'),
    path.resolve(__dirname_, '../package.json'),
    path.resolve(process.cwd(), 'package.json'),
  ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const raw = JSON.parse(readFileSync(p, 'utf-8')) as { version?: string };
      if (raw.version) return raw.version;
    } catch {
      // try next
    }
  }
  return '0.0.0';
}

type Format = 'json' | 'text' | 'markdown';

// Threaded explicitly so the same `runCli` works in two modes:
//   • Electron --cli mode → process.stdout / process.stderr
//   • Socket-server mode  → in-memory buffers serialized back to the client
// Threading via param avoids module-level state and lets the server handle
// concurrent socket requests safely.
export interface CliIo {
  out: Writable;
  err: Writable;
}

interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean | string[]>;
  help: boolean;
}

const REPEATABLE_FLAGS = new Set(['calendar', 'account']);

function parseArgs(argv: string[]): ParsedArgs {
  const flags: ParsedArgs['flags'] = {};
  const positional: string[] = [];
  let help = false;

  let i = 0;
  let command = '';

  // Positional command first (skip leading flags? we accept them anywhere).
  while (i < argv.length) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      help = true;
      i++;
      continue;
    }
    if (a === '--version' || a === '-v') {
      command = command || '__version';
      i++;
      continue;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = (eq >= 0 ? a.slice(2, eq) : a.slice(2));
      let value: string | true;
      if (eq >= 0) {
        value = a.slice(eq + 1);
        i++;
      } else {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) {
          value = true;
          i++;
        } else {
          value = next;
          i += 2;
        }
      }
      if (REPEATABLE_FLAGS.has(name)) {
        const cur = flags[name];
        if (Array.isArray(cur)) cur.push(String(value));
        else flags[name] = [String(value)];
      } else {
        flags[name] = value;
      }
      continue;
    }
    if (!command) {
      command = a;
    } else {
      positional.push(a);
    }
    i++;
  }

  return { command, positional, flags, help };
}

function getFormat(args: ParsedArgs): Format {
  const f = args.flags.format;
  if (f === 'json' || f === 'text' || f === 'markdown') return f;
  if (typeof f === 'string') {
    throw new CliError(`unknown --format value: ${f} (expected json|text|markdown)`);
  }
  return 'json';
}

class CliError extends Error {
  exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

// ---------- Date parsing ----------

function startOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

function endOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(23, 59, 59, 999);
  return out;
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

function addMonths(d: Date, n: number): Date {
  const out = new Date(d);
  out.setMonth(out.getMonth() + n);
  return out;
}

// Monday-of-this-week, local time. (yCal already conventions weeks but we
// don't need to import the renderer's helpers here.)
function startOfWeek(d: Date): Date {
  const out = startOfDay(d);
  const day = out.getDay(); // 0=Sun..6=Sat
  const diff = (day + 6) % 7; // distance back to Monday
  return addDays(out, -diff);
}

// Lenient date parser. Returns Date in local time.
//   today, tomorrow, yesterday, now
//   +Nd | -Nd | +Nw | +Nm | +Nh
//   YYYY-MM-DD                       (treated as start-of-day local)
//   YYYY-MM-DDTHH:MM[:SS][±HH:MM|Z]  (passed through to Date)
function parseDate(input: string, edge: 'start' | 'end'): Date {
  const lower = input.toLowerCase().trim();
  const now = new Date();

  if (lower === 'now') return now;
  if (lower === 'today') return edge === 'start' ? startOfDay(now) : endOfDay(now);
  if (lower === 'tomorrow') {
    const t = addDays(now, 1);
    return edge === 'start' ? startOfDay(t) : endOfDay(t);
  }
  if (lower === 'yesterday') {
    const t = addDays(now, -1);
    return edge === 'start' ? startOfDay(t) : endOfDay(t);
  }

  const rel = lower.match(/^([+-]?)(\d+)([dwmh])$/);
  if (rel) {
    const sign = rel[1] === '-' ? -1 : 1;
    const n = parseInt(rel[2], 10) * sign;
    const unit = rel[3];
    let d: Date;
    if (unit === 'd') d = addDays(now, n);
    else if (unit === 'w') d = addDays(now, n * 7);
    else if (unit === 'm') d = addMonths(now, n);
    else d = new Date(now.getTime() + n * 3600 * 1000);
    if (unit === 'h') return d;
    return edge === 'start' ? startOfDay(d) : endOfDay(d);
  }

  // YYYY-MM-DD → local midnight (Date constructor would treat as UTC).
  const isoDateOnly = input.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoDateOnly) {
    const d = new Date(
      parseInt(isoDateOnly[1], 10),
      parseInt(isoDateOnly[2], 10) - 1,
      parseInt(isoDateOnly[3], 10),
    );
    return edge === 'start' ? startOfDay(d) : endOfDay(d);
  }

  const d = new Date(input);
  if (Number.isNaN(d.getTime())) {
    throw new CliError(`invalid date: ${input}`);
  }
  return d;
}

// ---------- Helpers ----------

function stripHtml(s: string | null): string | null {
  if (!s) return null;
  const cleaned = s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<\/li\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return cleaned || null;
}

function durationMinutes(startIso: string, endIso: string, allDay: boolean): number {
  if (allDay) {
    // All-day events: end is exclusive; report as whole days × 1440 for clarity.
    const s = new Date(startIso).getTime();
    const e = new Date(endIso).getTime();
    return Math.max(0, Math.round((e - s) / 60000));
  }
  return Math.max(0, Math.round((new Date(endIso).getTime() - new Date(startIso).getTime()) / 60000));
}

interface CalendarLookup {
  byId: Map<string, CalendarSummary>;
  accountById: Map<string, AccountSummary>;
}

function buildLookup(calendars: CalendarSummary[], accounts: AccountSummary[]): CalendarLookup {
  return {
    byId: new Map(calendars.map((c) => [c.id, c])),
    accountById: new Map(accounts.map((a) => [a.id, a])),
  };
}

interface PublicEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  duration_minutes: number;
  location: string | null;
  description: string | null;
  rsvp: CalendarEvent['rsvp'];
  status: string;
  eventType: string | null;
  workingLocation?: { kind: string; label: string };
  calendar: { id: string; name: string; account: string | null; primary: boolean };
  url: string | null;
}

function shapeEvent(ev: CalendarEvent, look: CalendarLookup): PublicEvent {
  const cal = look.byId.get(ev.calendarId);
  const acc = look.accountById.get(ev.accountId);
  return {
    id: ev.id,
    title: ev.title,
    start: ev.start,
    end: ev.end,
    allDay: ev.allDay,
    duration_minutes: durationMinutes(ev.start, ev.end, ev.allDay),
    location: ev.location ?? null,
    description: stripHtml(ev.description),
    rsvp: ev.rsvp,
    status: ev.status,
    eventType: ev.eventType,
    ...(ev.workingLocation ? { workingLocation: ev.workingLocation } : {}),
    calendar: {
      id: ev.calendarId,
      name: cal?.name ?? ev.calendarId,
      account: acc?.email ?? null,
      primary: !!cal?.primary,
    },
    url: ev.htmlLink ?? null,
  };
}

function compareEvents(a: PublicEvent, b: PublicEvent): number {
  const sa = new Date(a.start).getTime();
  const sb = new Date(b.start).getTime();
  if (sa !== sb) return sa - sb;
  return a.title.localeCompare(b.title);
}

// ---------- Output ----------

function emit(payload: unknown, format: Format, render: () => string, io: CliIo): void {
  if (format === 'json') {
    io.out.write(JSON.stringify(payload, null, 2) + '\n');
  } else {
    io.out.write(render() + '\n');
  }
}

function fmtTime(iso: string, allDay: boolean): string {
  const d = new Date(iso);
  if (allDay) {
    return d.toLocaleDateString(undefined, {
      weekday: 'short', year: 'numeric', month: 'short', day: '2-digit',
    });
  }
  return d.toLocaleString(undefined, {
    weekday: 'short', month: 'short', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
}

function fmtRange(ev: PublicEvent): string {
  if (ev.allDay) {
    const start = new Date(ev.start);
    const end = new Date(ev.end);
    // Google all-day end is exclusive; subtract a day for display.
    const lastDay = addDays(end, -1);
    if (start.toDateString() === lastDay.toDateString()) {
      return fmtTime(ev.start, true) + ' (all day)';
    }
    return `${fmtTime(ev.start, true)} → ${fmtTime(lastDay.toISOString(), true)} (all day)`;
  }
  const startStr = fmtTime(ev.start, false);
  const endStr = new Date(ev.end).toLocaleTimeString(undefined, {
    hour: '2-digit', minute: '2-digit',
  });
  return `${startStr} – ${endStr}`;
}

// ---------- Commands ----------

function ensureConfigured(): void {
  if (!isConfigured()) {
    throw new CliError(
      'OAuth client not configured. Place oauth-client.json in ' +
        app.getPath('userData') +
        ' (see README).',
      2,
    );
  }
}

function ensureAccounts(): AccountSummary[] {
  const accounts = listAccountSummaries();
  if (accounts.length === 0) {
    throw new CliError(
      'No Google accounts signed in. Open the yCal app and sign in first.',
      2,
    );
  }
  return accounts;
}

async function cmdAccounts(args: ParsedArgs, io: CliIo): Promise<number> {
  ensureConfigured();
  const accounts = listAccountSummaries();
  const format = getFormat(args);
  emit(
    { command: 'accounts', count: accounts.length, accounts },
    format,
    () => {
      if (accounts.length === 0) return '(no accounts)';
      if (format === 'markdown') {
        return ['## Accounts', ...accounts.map((a) => `- **${a.email}**${a.name ? ` — ${a.name}` : ''}`)].join('\n');
      }
      return accounts.map((a) => `${a.email}${a.name ? `  (${a.name})` : ''}`).join('\n');
    },
    io,
  );
  return 0;
}

async function cmdCalendars(args: ParsedArgs, io: CliIo): Promise<number> {
  ensureConfigured();
  ensureAccounts();
  const accountFilter = args.flags.account;
  const wanted = Array.isArray(accountFilter) ? new Set(accountFilter) : null;
  const calendars = (await listAllCalendars())
    .filter((c) => !wanted || wanted.has(c.accountId));
  const accounts = listAccountSummaries();
  const accById = new Map(accounts.map((a) => [a.id, a]));

  const shaped = calendars.map((c) => ({
    id: c.id,
    name: c.name,
    account: accById.get(c.accountId)?.email ?? null,
    accountId: c.accountId,
    primary: c.primary,
    selected: c.selected,
    accessRole: c.accessRole,
    description: c.description,
  }));

  const format = getFormat(args);
  emit(
    { command: 'calendars', count: shaped.length, calendars: shaped },
    format,
    () => {
      if (format === 'markdown') {
        return [
          '## Calendars',
          ...shaped.map((c) => `- ${c.primary ? '★ ' : ''}**${c.name}** — ${c.account ?? c.accountId} (\`${c.id}\`)`),
        ].join('\n');
      }
      const w = Math.max(...shaped.map((c) => c.name.length), 4);
      return shaped
        .map((c) => `${c.primary ? '★' : ' '} ${c.name.padEnd(w)}  ${c.account ?? ''}  ${c.id}`)
        .join('\n');
    },
    io,
  );
  return 0;
}

interface EventRange {
  from: Date;
  to: Date;
}

function resolveEventRange(args: ParsedArgs, fallback: EventRange): EventRange {
  const fromStr = args.flags.from;
  const toStr = args.flags.to;
  const from = typeof fromStr === 'string' ? parseDate(fromStr, 'start') : fallback.from;
  const to = typeof toStr === 'string' ? parseDate(toStr, 'end') : fallback.to;
  if (to.getTime() < from.getTime()) {
    throw new CliError(`--to (${to.toISOString()}) is before --from (${from.toISOString()})`);
  }
  return { from, to };
}

interface EventQueryOptions {
  range: EventRange;
  search?: string;
  limit?: number;
  includeDeclined: boolean;
  dedup: boolean;
  calendarIds: string[] | null;
  accountIds: string[] | null;
}

function readQueryOptions(args: ParsedArgs, fallback: EventRange): EventQueryOptions {
  const range = resolveEventRange(args, fallback);
  const search = typeof args.flags.search === 'string' ? args.flags.search : undefined;
  const limit = typeof args.flags.limit === 'string' ? parseInt(args.flags.limit, 10) : undefined;
  if (limit !== undefined && (Number.isNaN(limit) || limit < 1)) {
    throw new CliError(`--limit must be a positive integer, got ${args.flags.limit}`);
  }
  const calendarIds = Array.isArray(args.flags.calendar) ? args.flags.calendar : null;
  const accountIds = Array.isArray(args.flags.account) ? args.flags.account : null;
  return {
    range,
    search,
    limit,
    includeDeclined: !!args.flags['include-declined'],
    dedup: !args.flags['no-dedup'],
    calendarIds,
    accountIds,
  };
}

async function fetchShapedEvents(opts: EventQueryOptions): Promise<PublicEvent[]> {
  const accounts = listAccountSummaries();
  const allCalendars = await listAllCalendars();

  // Resolve calendarIds: explicit list wins; otherwise filter to selected
  // calendars (mirrors the GUI default), and then optionally narrow by account.
  let targets = allCalendars;
  if (opts.accountIds) {
    const set = new Set(opts.accountIds);
    targets = targets.filter((c) => set.has(c.accountId));
  }
  let calendarIds = opts.calendarIds;
  if (!calendarIds || calendarIds.length === 0) {
    calendarIds = targets.filter((c) => c.selected).map((c) => c.id);
  } else {
    // Guard against typos.
    const allowed = new Set(targets.map((c) => c.id));
    const bad = calendarIds.filter((id) => !allowed.has(id));
    if (bad.length > 0) {
      throw new CliError(`unknown calendar id(s): ${bad.join(', ')}`);
    }
  }
  if (calendarIds.length === 0) {
    return [];
  }

  let events = await listEvents({
    timeMin: opts.range.from.toISOString(),
    timeMax: opts.range.to.toISOString(),
    calendarIds,
  });
  if (opts.dedup) {
    // Same cross-calendar collapse the GUI applies. Keeps tokens manageable
    // when the user subscribes to the same shared calendar from multiple
    // accounts.
    events = dedupEvents(events, allCalendars, DEFAULT_MERGE_CRITERIA);
  }

  const lookup = buildLookup(allCalendars, accounts);
  let shaped = events
    .filter((ev) => opts.includeDeclined || ev.rsvp !== 'declined')
    .map((ev) => shapeEvent(ev, lookup));

  if (opts.search) {
    const q = opts.search.toLowerCase();
    shaped = shaped.filter(
      (ev) =>
        ev.title.toLowerCase().includes(q) ||
        (ev.description ?? '').toLowerCase().includes(q) ||
        (ev.location ?? '').toLowerCase().includes(q),
    );
  }

  shaped.sort(compareEvents);
  if (opts.limit !== undefined) shaped = shaped.slice(0, opts.limit);
  return shaped;
}

function renderEventsText(events: PublicEvent[]): string {
  if (events.length === 0) return '(no events)';
  return events
    .map((ev) => {
      const head = `${fmtRange(ev)}  ${ev.title}`;
      const meta: string[] = [];
      if (ev.location) meta.push(`@ ${ev.location}`);
      if (ev.rsvp && ev.rsvp !== 'accepted') meta.push(`[${ev.rsvp}]`);
      if (ev.calendar.name) meta.push(`(${ev.calendar.name})`);
      return meta.length ? `${head}\n  ${meta.join('  ')}` : head;
    })
    .join('\n');
}

function renderEventsMarkdown(events: PublicEvent[], opts: EventQueryOptions): string {
  const heading = `## Events (${opts.range.from.toLocaleDateString()} → ${opts.range.to.toLocaleDateString()})`;
  if (events.length === 0) return `${heading}\n\n_no events_`;

  // Group by date for readability.
  const byDay = new Map<string, PublicEvent[]>();
  for (const ev of events) {
    const key = new Date(ev.start).toLocaleDateString(undefined, {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    });
    const list = byDay.get(key);
    if (list) list.push(ev);
    else byDay.set(key, [ev]);
  }

  const sections: string[] = [heading];
  for (const [day, list] of byDay) {
    sections.push(`\n### ${day}`);
    for (const ev of list) {
      const time = ev.allDay
        ? '(all day)'
        : new Date(ev.start).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) +
          '–' +
          new Date(ev.end).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
      const tags: string[] = [];
      if (ev.location) tags.push(`@ ${ev.location}`);
      if (ev.rsvp && ev.rsvp !== 'accepted') tags.push(`_${ev.rsvp}_`);
      tags.push(`\`${ev.calendar.name}\``);
      sections.push(`- **${time}** ${ev.title}  ·  ${tags.join('  ·  ')}`);
    }
  }
  return sections.join('\n');
}

async function cmdEvents(args: ParsedArgs, defaultRange: EventRange, io: CliIo): Promise<number> {
  ensureConfigured();
  ensureAccounts();
  const opts = readQueryOptions(args, defaultRange);
  const events = await fetchShapedEvents(opts);
  const format = getFormat(args);
  emit(
    {
      command: 'events',
      params: {
        from: opts.range.from.toISOString(),
        to: opts.range.to.toISOString(),
        search: opts.search ?? null,
        limit: opts.limit ?? null,
        includeDeclined: opts.includeDeclined,
        calendarIds: opts.calendarIds,
        accountIds: opts.accountIds,
      },
      count: events.length,
      events,
    },
    format,
    () => {
      if (format === 'markdown') return renderEventsMarkdown(events, opts);
      return renderEventsText(events);
    },
    io,
  );
  return 0;
}

async function cmdNext(args: ParsedArgs, io: CliIo): Promise<number> {
  ensureConfigured();
  ensureAccounts();
  const n = args.positional[0] ? parseInt(args.positional[0], 10) : 5;
  if (Number.isNaN(n) || n < 1) {
    throw new CliError(`expected a positive integer, got: ${args.positional[0]}`);
  }
  // Look ahead 30 days, then take first N.
  const from = new Date();
  const to = addDays(from, 30);
  const opts = readQueryOptions({ ...args, flags: { ...args.flags, limit: undefined as any } }, { from, to });
  // Override limit and force from=now (so we don't return events that started earlier today).
  const events = (await fetchShapedEvents({ ...opts, range: { from, to } }))
    .filter((ev) => new Date(ev.end).getTime() > from.getTime())
    .slice(0, n);
  const format = getFormat(args);
  emit(
    {
      command: 'next',
      params: { count_requested: n, lookahead_days: 30 },
      count: events.length,
      events,
    },
    format,
    () => format === 'markdown' ? renderEventsMarkdown(events, { ...opts, range: { from, to } }) : renderEventsText(events),
    io,
  );
  return 0;
}

async function cmdFind(args: ParsedArgs, io: CliIo): Promise<number> {
  ensureConfigured();
  ensureAccounts();
  const query = args.positional[0];
  if (!query) throw new CliError('usage: ycal find <query>');
  const fromStr = typeof args.flags.from === 'string' ? args.flags.from : '-7d';
  const toStr = typeof args.flags.to === 'string' ? args.flags.to : '+90d';
  const from = parseDate(fromStr, 'start');
  const to = parseDate(toStr, 'end');
  const opts = readQueryOptions({ ...args, flags: { ...args.flags, search: query } }, { from, to });
  const events = await fetchShapedEvents({ ...opts, search: query });
  const format = getFormat(args);
  emit(
    { command: 'find', params: { query, from: from.toISOString(), to: to.toISOString() }, count: events.length, events },
    format,
    () => format === 'markdown' ? renderEventsMarkdown(events, { ...opts, range: { from, to } }) : renderEventsText(events),
    io,
  );
  return 0;
}

async function cmdWeather(args: ParsedArgs, io: CliIo): Promise<number> {
  const days = await fetchWeather().catch((e) => {
    throw new CliError(`weather fetch failed: ${e instanceof Error ? e.message : String(e)}`);
  });
  const format = getFormat(args);
  emit(
    { command: 'weather', count: days.length, days },
    format,
    () => {
      if (days.length === 0) return '(weather feed not configured)';
      return days
        .map((d) => {
          const hi = d.hi !== null ? `${d.hi}°` : '—';
          const lo = d.lo !== null ? `${d.lo}°` : '—';
          return `${d.date}  ${(d.glyph ?? '').padEnd(14)} ${hi.padStart(4)} / ${lo.padStart(4)}  ${d.summary}`;
        })
        .join('\n');
    },
    io,
  );
  return 0;
}

function helpText(version: string): string {
  return `yCal CLI ${version} — read your Google Calendar from the terminal.

USAGE
  ycal <command> [flags]

COMMANDS
  accounts                  List signed-in Google accounts.
  calendars                 List all calendars across all accounts.
                            Flags: --account <id> (repeatable)
  events                    List events in a date range (default: today + 7 days).
                            Flags: --from <when>, --to <when>,
                                   --calendar <id> (repeatable),
                                   --account <id> (repeatable),
                                   --search <text>,
                                   --limit <n>,
                                   --include-declined,
                                   --no-dedup
  today                     Shortcut for --from today --to today.
  tomorrow                  Shortcut for --from tomorrow --to tomorrow.
  week                      Shortcut for the current Mon–Sun.
  next [N]                  Next N (default 5) upcoming events.
  find <query>              Search events (default: -7d to +90d).
  weather                   Forecast from the configured weather iCal feed.

GLOBAL FLAGS
  --format json|text|markdown   Output format. Default: json (LLM-friendly).
  --help, -h                    Show this help.
  --version, -v                 Print the yCal version.

DATE SHORTHAND
  today | tomorrow | yesterday | now
  +Nd  +Nw  +Nm  +Nh   (also -Nd, etc.)
  YYYY-MM-DD           (local midnight)
  YYYY-MM-DDTHH:MM     (local time)

EXAMPLES
  ycal today
  ycal events --from 2026-04-27 --to +7d --format markdown
  ycal next 3
  ycal find "1:1" --from -30d
  ycal calendars --account 1042... --format text
  ycal events --calendar primary@gmail.com --include-declined

JSON OUTPUT
  Every JSON document has at minimum: { "command", "count" } plus a payload
  array named after the command (events|accounts|calendars|days). Times are
  ISO 8601; durations are minutes; descriptions are plain text (HTML stripped).

EXIT CODES
  0  success
  1  usage or runtime error (details on stderr)
  2  not configured / no accounts signed in
`;
}

// ---------- Entry point ----------

export async function runCli(
  argv: string[],
  out: Writable = process.stdout,
  err: Writable = process.stderr,
): Promise<number> {
  const io: CliIo = { out, err };
  const version = readVersion();
  const args = parseArgs(argv);

  if (args.command === '__version' || args.flags.version) {
    io.out.write(`yCal ${version}\n`);
    return 0;
  }
  if (args.help && !args.command) {
    io.out.write(helpText(version));
    return 0;
  }
  if (!args.command || args.command === 'help') {
    io.out.write(helpText(version));
    return args.command ? 0 : 1;
  }
  if (args.help) {
    // Per-command help → for now, fall back to the global help.
    io.out.write(helpText(version));
    return 0;
  }

  try {
    const now = new Date();
    switch (args.command) {
      case 'accounts':
        return await cmdAccounts(args, io);
      case 'calendars':
        return await cmdCalendars(args, io);
      case 'events':
        return await cmdEvents(args, { from: startOfDay(now), to: endOfDay(addDays(now, 7)) }, io);
      case 'today':
        return await cmdEvents(args, { from: startOfDay(now), to: endOfDay(now) }, io);
      case 'tomorrow': {
        const t = addDays(now, 1);
        return await cmdEvents(args, { from: startOfDay(t), to: endOfDay(t) }, io);
      }
      case 'week': {
        const ws = startOfWeek(now);
        return await cmdEvents(args, { from: ws, to: endOfDay(addDays(ws, 6)) }, io);
      }
      case 'next':
        return await cmdNext(args, io);
      case 'find':
        return await cmdFind(args, io);
      case 'weather':
        return await cmdWeather(args, io);
      default:
        io.err.write(`ycal: unknown command "${args.command}"\n\n`);
        io.err.write(helpText(version));
        return 1;
    }
  } catch (e) {
    if (e instanceof CliError) {
      io.err.write(`ycal: ${e.message}\n`);
      return e.exitCode;
    }
    io.err.write(`ycal: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
    return 1;
  }
}

// Pull just the user-facing CLI args from process.argv. Electron's argv shape
// varies between dev (`electron . --cli foo`) and packaged (`yCal --cli foo`).
// We anchor on the `--cli` sentinel.
export function extractCliArgs(argv: string[]): string[] {
  const idx = argv.indexOf('--cli');
  if (idx === -1) return [];
  return argv.slice(idx + 1);
}

export function isCliInvocation(argv: string[]): boolean {
  return argv.includes('--cli');
}
