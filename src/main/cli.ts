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
import { app, BrowserWindow } from 'electron';
import { readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Writable } from 'node:stream';

import { isConfigured } from './config';
import { listAccountSummaries, listAllCalendars, listEvents } from './calendar';
import { listAccounts } from './tokenStore';
import { clearWeatherCache, fetchWeather } from './weather';
import {
  getSettingsSnapshotStrict, getSettingsStrict, getUiSettings, setUiSettings, setWeatherUrl,
} from './settings';
import { scheduleAppleCalendarAutoSync } from './appleCalendar';
import {
  CONFIG_KEYS, isSecretKey, lookupKey, parseValue, renderViewValue, viewOf,
} from './configKeys';
import type { ConfigKeyDef, ConfigSnapshot, ConfigValue, ConfigView } from './configKeys';
import {
  DIARIZE_TRANSFORMERS_COMMIT, getRecorderSetupInFlight, getRecorderSetupStatus,
  isDiarizeVenvReady, onRecorderSetupProgress, runDiarizeSetup, runRecorderSetup,
} from './recorderSetup';
import type { RecorderSetupKind, RecorderSetupResult } from './recorderSetup';
import { getModelById } from '@shared/whisperModels';
import { calKey, resolveTargets, roleOf } from './calendarTargets';
import { DEFAULT_WATCH_RUNNER, subscribeWatch } from './watchRunner';
import {
  DEFAULT_WATCH_CONFIG, emptyState, evictUnwatched, ingest, renderWatchEvent, runTimers,
  snapshotOf,
} from '@shared/calendarWatch';
import type {
  WatchConfig, WatchEvent, WatchInput,
} from '@shared/calendarWatch';
import {
  checkForUpdatesNow, getLastUpdateStatus, onUpdateStatus, requestInstall,
} from './updater';
import {
  fetchMeetingArtifact, findAccountForArchive, listAllMeetingArchives,
} from './meetingArchive';
import { getNote, listNotes } from './notesStore';
import { dedupEvents } from '@shared/dedup';
import { htmlToPlainText } from '@shared/htmlText';
import { DEFAULT_MERGE_CRITERIA, IPC } from '@shared/types';
import fs from 'node:fs';
import type {
  AccountSummary,
  CalendarSummary,
  CalendarEvent,
  CalendarFetchFailure,
  CalRolePersisted,
  MeetingArtifactKind,
  MeetingNote,
  UpdateStatus,
  UiSettings,
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
  progress?: (status: UpdateStatus) => void;
  // Push one stdout line to the caller NOW, rather than at exit. Only set for
  // socket clients that opted into streaming; `watch` falls back to writing
  // straight to `out` (in-process mode) when it is absent.
  emit?: (line: string) => void;
  // Push one stderr line to the caller NOW — live progress for a long job
  // (`recorder setup`). Absent → write to `err`, which in-process mode shows
  // live and a non-streaming socket client receives at the end.
  note?: (line: string) => void;
  // Fires when the caller went away — for `watch`, which otherwise never
  // returns and would keep the poll loop alive for nobody.
  signal?: AbortSignal;
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

interface PublicAttendee {
  email: string;
  name: string | null;
  rsvp: string;
  organizer: boolean;
  self: boolean;
  optional: boolean;
  // Meeting rooms and equipment come back as attendees too. Without this flag
  // a consumer writing "who is in this meeting" lists the Chromebox.
  resource: boolean;
}

interface PublicEvent {
  id: string;
  // Present only on a recurring instance. `id` embeds the instance's original
  // start, so a re-timed series changes every id at once; this is the stable
  // half, and the only way a consumer tracking events over time can tell that
  // apart from a wave of cancellations.
  recurringEventId?: string;
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
  // Conference URL, protocol-less (matches how the GUI stores it). Cheap
  // enough to always include — it is the one thing you actually need at the
  // moment a meeting starts.
  meetUrl?: string;
  meetLabel?: string;
  // Opt-in via --include-attendees: an all-hands invite list is long, and
  // every other caller would pay for it in tokens on every single event.
  attendees?: PublicAttendee[];
  calendar: { id: string; name: string; account: string | null; primary: boolean };
  url: string | null;
}

// A calendar we could not read this time. Until now these only reached
// `process.stderr` from inside fetchShapedEvents, which in socket mode (the
// default `bin/ycal` path) is the GUI process's stderr — not the caller's —
// so a partial fetch was invisible to the client and absent from the JSON.
// That matters to any machine consumer that DIFFS two snapshots: without a
// way to tell "nothing changed" from "we could not see part of the calendar",
// one rate-limited calendar reads as a batch of cancellations.
interface PublicFailure {
  account: string;
  // null = whole-account failure (the OAuth refresh itself rejected), so we
  // never got far enough to name a calendar.
  calendar: string | null;
  message: string;
  transient: boolean;
  needsReauth: boolean;
}

// What fetchShapedEvents returns: what we could see, plus what we could not.
interface ShapedEvents {
  events: PublicEvent[];
  failures: PublicFailure[];
}

function shapeFailure(f: CalendarFetchFailure): PublicFailure {
  return {
    account: f.accountEmail,
    calendar: f.calendarName,
    message: f.message,
    transient: f.transient,
    needsReauth: f.needsReauth,
  };
}

// Partial fetches keep exit code 0 — partial data is still useful — but they
// must be audible on the CALLER's stderr, which means io.err, never
// process.stderr.
function reportFailures(failures: PublicFailure[], io: CliIo): void {
  for (const f of failures) {
    const target = f.calendar ? `${f.account}/${f.calendar}` : f.account;
    io.err.write(`[ycal] ${target}: ${f.message}\n`);
  }
}

function shapeEvent(
  ev: CalendarEvent,
  look: CalendarLookup,
  includeAttendees = false,
): PublicEvent {
  const cal = look.byId.get(ev.calendarId);
  const acc = look.accountById.get(ev.accountId);
  return {
    id: ev.id,
    ...(ev.recurringEventId ? { recurringEventId: ev.recurringEventId } : {}),
    title: ev.title,
    start: ev.start,
    end: ev.end,
    allDay: ev.allDay,
    duration_minutes: durationMinutes(ev.start, ev.end, ev.allDay),
    location: ev.location ?? null,
    description: htmlToPlainText(ev.description),
    rsvp: ev.rsvp,
    status: ev.status,
    eventType: ev.eventType,
    ...(ev.workingLocation ? { workingLocation: ev.workingLocation } : {}),
    ...(ev.meetUrl ? { meetUrl: ev.meetUrl } : {}),
    ...(ev.meetLabel ? { meetLabel: ev.meetLabel } : {}),
    ...(includeAttendees && ev.attendees
      ? {
          attendees: ev.attendees.map((a) => ({
            email: a.email,
            name: a.name,
            rsvp: a.rsvp,
            organizer: a.organizer,
            self: a.self,
            optional: a.optional,
            resource: a.resource,
          })),
        }
      : {}),
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
  const ui = getUiSettings();

  // Annotate each calendar with the GUI's view of it: per-account active
  // toggle, per-calendar visibility, and role (normal/subscribed/holiday/team OOO).
  // `included` summarizes whether `ycal events` would query this calendar
  // by default — useful debug aid for "why isn't event X showing up".
  const shaped = calendars.map((c) => {
    const accountActive = ui.accountsActive[c.accountId] !== false;
    const visible = ui.calVisible[calKey(c.accountId, c.id)] ?? c.selected;
    const role = roleOf(ui, c.accountId, c.id);
    // Mirrors resolveTargets' default filter exactly — this field exists to
    // answer "why isn't event X showing up", so it is worthless if it drifts.
    const included = accountActive && visible && role === 'normal';
    return {
      id: c.id,
      name: c.name,
      account: accById.get(c.accountId)?.email ?? null,
      accountId: c.accountId,
      primary: c.primary,
      selected: c.selected,
      visible,
      accountActive,
      role,
      includedByDefault: included,
      accessRole: c.accessRole,
      description: c.description,
    };
  });

  const format = getFormat(args);
  emit(
    { command: 'calendars', count: shaped.length, calendars: shaped },
    format,
    () => {
      if (format === 'markdown') {
        return [
          '## Calendars',
          ...shaped.map((c) => {
            const tag = c.role !== 'normal' ? ` _(${c.role})_` : '';
            const off = !c.includedByDefault ? ' ⊘' : '';
            return `- ${c.primary ? '★ ' : ''}**${c.name}**${tag}${off} — ${c.account ?? c.accountId} (\`${c.id}\`)`;
          }),
        ].join('\n');
      }
      const w = Math.max(...shaped.map((c) => c.name.length), 4);
      return shaped
        .map((c) => {
          const flag = !c.includedByDefault
            ? '⊘'
            : c.role === 'subscribed'
              ? 'r'
              : c.role === 'holiday'
                ? 'h'
                : c.role === 'teamOoo'
                  ? 't'
                  : ' ';
          return `${c.primary ? '★' : ' '}${flag} ${c.name.padEnd(w)}  ${c.account ?? ''}  ${c.id}`;
        })
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
  // Calendar-set filtering. By default we mirror the GUI agenda: only the
  // user's active accounts, only their visible calendars, and normal/team-OOO
  // marker role calendars (read-only/subscribed and holidays excluded).
  // `--all-calendars` bypasses every UI filter; `--include-read-only` /
  // `--include-holidays` selectively widen for planning use.
  allCalendars: boolean;
  includeReadOnly: boolean;
  includeHolidays: boolean;
  includeAttendees: boolean;
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
    allCalendars: !!args.flags['all-calendars'],
    includeReadOnly: !!args.flags['include-read-only'],
    includeHolidays: !!args.flags['include-holidays'],
    includeAttendees: !!args.flags['include-attendees'],
  };
}

async function fetchShapedEvents(opts: EventQueryOptions): Promise<ShapedEvents> {
  const accounts = listAccountSummaries();
  const allCalendars = await listAllCalendars();
  const ui = getUiSettings();

  // Resolve target calendars — shared with `ycal watch`, so the watcher and
  // the agenda can never drift apart. Precedence:
  //   1. Explicit --calendar <id> always wins (user is being deliberate).
  //   2. --all-calendars bypasses UI filters but still respects --account.
  //   3. Default: mirror the GUI agenda — only active accounts, only
  //      visible calendars, normal + team-OOO marker roles. Optional flags widen.
  // Post-filtering by PAIR handles the shared-calendar-across-accounts case:
  // account A has it visible while account B has it hidden, and a fetch keyed
  // on calendar id alone would bring back both.
  let targets;
  try {
    targets = resolveTargets(allCalendars, ui, opts);
  } catch (e) {
    throw new CliError(e instanceof Error ? e.message : String(e));
  }
  if (targets.pairs.length === 0) {
    return { events: [], failures: [] };
  }
  const { calendarIds, pairKeys } = targets;

  const fetch = await listEvents({
    timeMin: opts.range.from.toISOString(),
    timeMax: opts.range.to.toISOString(),
    calendarIds,
  });
  // Carried out to the command, which reports them on io.err AND in the JSON.
  const failures = fetch.failures.map(shapeFailure);
  let events = fetch.events.filter((ev) => pairKeys.has(calKey(ev.accountId, ev.calendarId)));
  // Google's timeMin is documented as exclusive on event end, but multi-day
  // all-day events whose exclusive end.date equals our local midnight still
  // come back (e.g. an event whose last day is "yesterday" leaks into today).
  // Enforce strict overlap with the requested local range here.
  const fromMs = opts.range.from.getTime();
  const toMs = opts.range.to.getTime();
  events = events.filter((ev) => {
    const startMs = new Date(ev.start).getTime();
    const endMs = new Date(ev.end).getTime();
    return endMs > fromMs && startMs <= toMs;
  });
  if (opts.dedup) {
    // Same cross-calendar collapse the GUI applies. Keeps tokens manageable
    // when the user subscribes to the same shared calendar from multiple
    // accounts. Honour the user's persisted mergeCriteria when present.
    events = dedupEvents(events, allCalendars, ui.mergeCriteria ?? DEFAULT_MERGE_CRITERIA);
  }

  const lookup = buildLookup(allCalendars, accounts);
  let shaped = events
    .filter((ev) => opts.includeDeclined || ev.rsvp !== 'declined')
    .map((ev) => shapeEvent(ev, lookup, opts.includeAttendees));

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
  return { events: shaped, failures };
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
  const { events, failures } = await fetchShapedEvents(opts);
  reportFailures(failures, io);
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
      partial: failures.length > 0,
      failures,
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
  const fetched = await fetchShapedEvents({ ...opts, range: { from, to } });
  reportFailures(fetched.failures, io);
  const events = fetched.events
    .filter((ev) => new Date(ev.end).getTime() > from.getTime())
    .slice(0, n);
  const format = getFormat(args);
  emit(
    {
      command: 'next',
      params: { count_requested: n, lookahead_days: 30 },
      count: events.length,
      partial: fetched.failures.length > 0,
      failures: fetched.failures,
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
  const { events, failures } = await fetchShapedEvents({ ...opts, search: query });
  reportFailures(failures, io);
  const format = getFormat(args);
  emit(
    {
      command: 'find',
      params: { query, from: from.toISOString(), to: to.toISOString() },
      count: events.length,
      partial: failures.length > 0,
      failures,
      events,
    },
    format,
    () => format === 'markdown' ? renderEventsMarkdown(events, { ...opts, range: { from, to } }) : renderEventsText(events),
    io,
  );
  return 0;
}

// ---------- watch ----------

function watchConfigFrom(args: ParsedArgs): WatchConfig {
  const num = (flag: string, fallback: number): number => {
    const raw = args.flags[flag];
    if (typeof raw !== 'string') return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
      throw new CliError(`--${flag} must be a non-negative number, got ${raw}`);
    }
    return n;
  };
  return {
    ...DEFAULT_WATCH_CONFIG,
    quarantinePolls: num('quarantine-polls', DEFAULT_WATCH_CONFIG.quarantinePolls),
    rsvpLeadHours: num('rsvp-lead-hours', DEFAULT_WATCH_CONFIG.rsvpLeadHours),
    prepLeadMinutes: num('prep-lead-minutes', DEFAULT_WATCH_CONFIG.prepLeadMinutes),
  };
}

/** Map a recorded `ycal events` document into engine inputs. */
function replayInputs(doc: Record<string, unknown>): WatchInput[] {
  const rows = Array.isArray(doc.events) ? doc.events : [];
  return rows.map((raw) => {
    const ev = raw as Record<string, any>;
    return {
      id: String(ev.id ?? ''),
      ...(ev.recurringEventId ? { recurringEventId: String(ev.recurringEventId) } : {}),
      // The recorded document identifies an account by email, which is the
      // stable key AT THIS LAYER; the live runner uses the internal accountId.
      // Both only ever have to agree with the `watched` set beside them.
      accountId: String(ev.calendar?.account ?? ''),
      calendarId: String(ev.calendar?.id ?? ''),
      title: String(ev.title ?? ''),
      start: String(ev.start ?? ''),
      end: String(ev.end ?? ''),
      allDay: !!ev.allDay,
      status: String(ev.status ?? 'confirmed'),
      eventType: ev.eventType ?? null,
      location: ev.location ?? null,
      url: ev.url ?? null,
      ...(ev.meetUrl ? { meetUrl: String(ev.meetUrl) } : {}),
      rsvp: ev.rsvp ?? null,
      calendarName: String(ev.calendar?.name ?? ev.calendar?.id ?? ''),
      attendees: Array.isArray(ev.attendees)
        ? ev.attendees.map((a: Record<string, any>) => ({
            email: String(a.email ?? ''),
            name: a.name ?? null,
            rsvp: String(a.rsvp ?? 'needsAction'),
            organizer: !!a.organizer,
            self: !!a.self,
            resource: !!a.resource,
          }))
        : [],
    } satisfies WatchInput;
  });
}

/** Deterministic replay: feed recorded snapshots through the engine.
 *
 * This is how the detection logic is tested in a repo with no test runner —
 * no GUI, no Google, no clock of its own. Each input line is one document in
 * the shape `ycal events --format json` produces, optionally carrying a "now"
 * (ISO) that sets the clock for that step so the timers are reproducible, and
 * a `"watched"` array of `<account>|<calendarId>` keys standing in for the
 * calendars the sidebar had ticked at that moment. Omit `watched` and no
 * eviction runs, which is what every case that predates it wants.
 */
function cmdWatchReplay(args: ParsedArgs, io: CliIo, cfg: WatchConfig): number {
  const file = args.flags.replay;
  if (typeof file !== 'string') throw new CliError('usage: ycal watch --replay <file.jsonl>');
  let body: string;
  try {
    body = fs.readFileSync(file, 'utf-8');
  } catch (e) {
    throw new CliError(`cannot read ${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const format = getFormat(args);
  const state = emptyState();
  let seeded = false;

  const write = (ev: WatchEvent): void => {
    io.out.write(
      (format === 'json' ? JSON.stringify(ev) : renderWatchEvent(ev)) + '\n',
    );
  };

  for (const [i, line] of body.split('\n').entries()) {
    if (!line.trim()) continue;
    let doc: Record<string, unknown>;
    try {
      doc = JSON.parse(line) as Record<string, unknown>;
    } catch (e) {
      throw new CliError(`${file}:${i + 1} is not JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
    const nowRaw = typeof doc.now === 'string' ? Date.parse(doc.now) : NaN;
    const now = Number.isNaN(nowRaw) ? Date.now() : nowRaw;
    const params = doc.params as Record<string, unknown> | undefined;
    const windowFrom = (params?.from as string) ?? null;
    const windowTo = (params?.to as string) ?? null;
    const cur = snapshotOf(replayInputs(doc), cfg, now);
    const watched = Array.isArray(doc.watched)
      ? new Set((doc.watched as unknown[]).map(String))
      : null;

    if (!seeded) {
      seeded = true;
      state.events = cur;
      state.windowTo = windowTo;
      runTimers(state, cfg, now, true);
      write({
        kind: 'watch-armed',
        at: new Date(now).toISOString(),
        tracked: Object.keys(state.events).length,
        windowTo: windowTo ?? '',
        pollSeconds: 0,
      });
      continue;
    }
    if (watched) evictUnwatched(state, watched);
    for (const ev of ingest(state, cur, {
      partial: !!doc.partial, windowFrom, windowTo, now, config: cfg,
    })) {
      write(ev);
    }
    for (const ev of runTimers(state, cfg, now).events) write(ev);
  }
  return 0;
}

async function cmdWatch(args: ParsedArgs, io: CliIo): Promise<number> {
  const cfg = watchConfigFrom(args);
  if (args.flags.replay !== undefined) return cmdWatchReplay(args, io, cfg);

  ensureConfigured();
  ensureAccounts();
  const format = getFormat(args);
  const intFlag = (flag: string, fallback: number): number => {
    const raw = args.flags[flag];
    if (typeof raw !== 'string') return fallback;
    const n = parseInt(raw, 10);
    if (Number.isNaN(n)) throw new CliError(`--${flag} must be an integer, got ${raw}`);
    return n;
  };

  // Streaming when the caller opted in; otherwise straight to stdout, which is
  // what `yCal --cli watch` (in-process) does.
  const push = (line: string): void => {
    if (io.emit) io.emit(line + '\n');
    else io.out.write(line + '\n');
  };

  const unsubscribe = subscribeWatch(
    {
      fromDays: intFlag('from-days', DEFAULT_WATCH_RUNNER.fromDays),
      toDays: intFlag('to-days', DEFAULT_WATCH_RUNNER.toDays),
      pollSeconds: Math.max(15, intFlag('interval', DEFAULT_WATCH_RUNNER.pollSeconds)),
      config: cfg,
      filter: {
        calendarIds: Array.isArray(args.flags.calendar) ? args.flags.calendar : null,
        accountIds: Array.isArray(args.flags.account) ? args.flags.account : null,
        allCalendars: !!args.flags['all-calendars'],
        includeReadOnly: !!args.flags['include-read-only'],
        includeHolidays: !!args.flags['include-holidays'],
      },
    },
    (ev) => push(format === 'json' ? JSON.stringify(ev) : renderWatchEvent(ev)),
  );

  // `watch` does not return on its own — it ends when the caller goes away.
  await new Promise<void>((resolve) => {
    if (io.signal) {
      if (io.signal.aborted) resolve();
      else io.signal.addEventListener('abort', () => resolve(), { once: true });
    }
    // With no signal (in-process mode) this never resolves, which is correct:
    // the process is the subscription, and Ctrl-C ends it.
  });
  unsubscribe();
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

// ---------- Meeting archive commands ----------
// Read recordings stored on each event's Google account's Drive
// `appdata` folder (the same hidden bucket yCal uses for cross-device
// sync). Filenames embed the calendar event id, so a transcript or
// summary is reachable from any Mac signed in to the same Google
// account that owns the event.

async function cmdRecordings(args: ParsedArgs, io: CliIo): Promise<number> {
  ensureConfigured();
  ensureAccounts();
  const limit = typeof args.flags.limit === 'string' ? parseInt(args.flags.limit, 10) : 50;
  if (Number.isNaN(limit) || limit < 1) {
    throw new CliError(`--limit must be a positive integer, got ${args.flags.limit}`);
  }
  const archives = (await listAllMeetingArchives()).slice(0, limit);
  const format = getFormat(args);
  const accounts = new Map(listAccountSummaries().map((a) => [a.id, a]));
  const shaped = archives.map((a) => ({
    eventId: a.eventId,
    title: a.meta?.title ?? null,
    startedAt: a.meta?.startedAt ?? null,
    endsAt: a.meta?.endsAt ?? null,
    account: accounts.get(a.accountId)?.email ?? a.accountId,
    accountId: a.accountId,
    hasAudio: a.has.audio,
    hasTranscript: a.has.transcript,
    hasSummary: a.has.summary,
    modifiedAt: a.modifiedAt,
  }));
  emit(
    { command: 'recordings', count: shaped.length, recordings: shaped },
    format,
    () => {
      if (shaped.length === 0) return '(no recordings on Drive)';
      if (format === 'markdown') {
        return [
          '## Recordings',
          ...shaped.map((r) => {
            const date = r.startedAt
              ? new Date(r.startedAt).toLocaleString(undefined, {
                year: 'numeric', month: 'short', day: '2-digit',
                hour: '2-digit', minute: '2-digit',
              })
              : '(date?)';
            const tags = [
              r.hasTranscript ? 'T' : '·',
              r.hasSummary ? 'S' : '·',
              r.hasAudio ? 'A' : '·',
            ].join('');
            return `- \`[${tags}]\` **${r.title ?? '(untitled)'}** — ${date} · ${r.account} · \`${r.eventId}\``;
          }),
        ].join('\n');
      }
      return shaped
        .map((r) => {
          const date = r.startedAt
            ? new Date(r.startedAt).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })
            : '?';
          const tags = [
            r.hasTranscript ? 'T' : '·',
            r.hasSummary ? 'S' : '·',
            r.hasAudio ? 'A' : '·',
          ].join('');
          return `[${tags}]  ${date.padEnd(18)}  ${(r.title ?? '(untitled)').slice(0, 40).padEnd(40)}  ${r.account}  ${r.eventId}`;
        })
        .join('\n');
    },
    io,
  );
  return 0;
}

// Resolve the (eventId, accountId) pair for a recording the user asked
// for. Two modes:
//   • positional id matches an archive eventId exactly → use that
//   • --query <substring> matches against archive titles (case-insens)
// Returns null when nothing matches. Multiple matches without a way to
// disambiguate is an error — surface the candidates so the user can
// pick.
async function resolveArchiveTarget(
  idArg: string | undefined,
  query: string | undefined,
): Promise<{ eventId: string; accountId: string; title: string | null; startedAt: number | null }> {
  const archives = await listAllMeetingArchives();
  let matches = archives;
  if (idArg) {
    matches = archives.filter((a) => a.eventId === idArg);
    if (matches.length === 0) {
      // Fall back to a prefix match — useful when the user pastes only
      // the first few chars from `ycal recordings`. Reject if the
      // prefix is ambiguous.
      matches = archives.filter((a) => a.eventId.startsWith(idArg));
    }
  } else if (query) {
    const q = query.toLowerCase();
    matches = archives.filter((a) => (a.meta?.title ?? '').toLowerCase().includes(q));
  } else {
    throw new CliError('usage: ycal transcript|summary <event-id> | --query <title-substring>');
  }
  if (matches.length === 0) {
    throw new CliError(
      `no recording matched ${idArg ? `id ${idArg}` : `query "${query}"`} — try \`ycal recordings\` to list available archives.`,
    );
  }
  if (matches.length > 1) {
    const lines = matches
      .slice(0, 10)
      .map((m) => `  ${m.eventId}  ${m.meta?.title ?? '(untitled)'}`)
      .join('\n');
    throw new CliError(
      `${matches.length} recordings matched — disambiguate by full event id:\n${lines}`,
    );
  }
  const m = matches[0];
  return {
    eventId: m.eventId,
    accountId: m.accountId,
    title: m.meta?.title ?? null,
    startedAt: m.meta?.startedAt ?? null,
  };
}

async function cmdMeetingArtifact(
  args: ParsedArgs,
  kind: MeetingArtifactKind,
  io: CliIo,
): Promise<number> {
  ensureConfigured();
  ensureAccounts();
  const idArg = args.positional[0];
  const query = typeof args.flags.query === 'string' ? args.flags.query : undefined;
  // First, see if the eventId is reachable directly without listing
  // every archive. If the caller knows the exact id, we can skip the
  // (potentially N-account-deep) full enumeration.
  let eventId: string;
  let accountId: string;
  let title: string | null = null;
  let startedAt: number | null = null;
  if (idArg && !query) {
    const acct = await findAccountForArchive(idArg);
    if (acct) {
      eventId = idArg;
      accountId = acct;
    } else {
      const resolved = await resolveArchiveTarget(idArg, query);
      eventId = resolved.eventId;
      accountId = resolved.accountId;
      title = resolved.title;
      startedAt = resolved.startedAt;
    }
  } else {
    const resolved = await resolveArchiveTarget(idArg, query);
    eventId = resolved.eventId;
    accountId = resolved.accountId;
    title = resolved.title;
    startedAt = resolved.startedAt;
  }
  const localPath = await fetchMeetingArtifact(eventId, accountId, kind);
  const format = getFormat(args);
  if (format === 'json') {
    // For JSON we include the body — that's what an LLM wants. For
    // audio (.m4a) we never inline the body; emit just the cached path.
    const body = kind === 'audio' ? null : fs.readFileSync(localPath, 'utf-8');
    io.out.write(JSON.stringify({
      command: kind,
      eventId,
      accountId,
      title,
      startedAt,
      path: localPath,
      ...(body !== null ? { body } : {}),
    }, null, 2) + '\n');
  } else {
    if (kind === 'audio') {
      io.out.write(`${localPath}\n`);
    } else {
      io.out.write(fs.readFileSync(localPath, 'utf-8'));
      // Ensure a trailing newline so the next prompt isn't glued to
      // the last line of the artifact.
      if (!io.out.writableEnded) io.out.write('\n');
    }
  }
  return 0;
}

// The structured meeting note — summary / decisions / actions / open
// questions / follow-ups / speakers / terms-to-confirm — built the same way
// the Notes GUI builds it (notesStore.getNote: note.json → parsed summary.md
// → transcript-only, local-first then Drive). This is the AI-friendly
// surface: one JSON object an LLM can reason over, distinct from `summary`
// (which prints the raw markdown artifact) and `transcript` (raw text).
function segPlainText(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .trim();
}

function renderNoteMarkdown(note: MeetingNote): string {
  const when = note.startedAt ? new Date(note.startedAt).toLocaleString() : note.date;
  const lines: string[] = [`# ${note.title}`, `_${when} · ${Math.round(note.durationSec / 60)} min_`];
  const sec = (h: string, items: string[]): void => {
    if (items.length) lines.push('', `## ${h}`, ...items.map((s) => `- ${s}`));
  };
  sec('Summary', note.summary);
  sec('Decisions', note.decisions);
  if (note.actions.length) {
    lines.push('', '## Action items', ...note.actions.map(
      (a) => `- [${a.done ? 'x' : ' '}] ${a.owner ? `**${a.owner}** — ` : ''}${a.text}`));
  }
  sec('Open questions', note.openQuestions);
  sec('Follow-ups', note.followups);
  sec('Speakers', note.speakers.map((s) => `${s.name}${s.role ? ` _(${s.role})_` : ''}`));
  sec('Terms to confirm', note.terms.map((t) => `${t.heard}${t.suggestion ? ` → ${t.suggestion}` : ''}`));
  return lines.join('\n');
}

function renderNoteText(note: MeetingNote): string {
  const when = note.startedAt ? new Date(note.startedAt).toLocaleString() : note.date;
  const out: string[] = [note.title, `${when} · ${Math.round(note.durationSec / 60)} min`];
  const sec = (h: string, items: string[]): void => {
    if (!items.length) return;
    out.push('', h.toUpperCase());
    items.forEach((s) => out.push('  • ' + s));
  };
  sec('Summary', note.summary);
  sec('Decisions', note.decisions);
  sec('Action items', note.actions.map(
    (a) => `${a.owner ? a.owner + ': ' : ''}${a.text}${a.done ? ' ✓' : ''}`));
  sec('Open questions', note.openQuestions);
  sec('Follow-ups', note.followups);
  sec('Speakers', note.speakers.map((s) => s.name + (s.role ? ` (${s.role})` : '')));
  sec('Terms to confirm', note.terms.map((t) => t.heard + (t.suggestion ? ` → ${t.suggestion}` : '')));
  return out.join('\n');
}

async function cmdNote(args: ParsedArgs, io: CliIo): Promise<number> {
  ensureConfigured();
  ensureAccounts();
  const idArg = args.positional[0];
  const query = typeof args.flags.query === 'string' ? args.flags.query : undefined;
  const includeTranscript = !!args.flags['include-transcript'];

  // Resolve (eventId, accountId). Exact id: resolve the owning Drive account
  // directly (getNote also reads local-first). --query: match against titles
  // across local ∪ Drive notes; an ambiguous match is an error.
  let eventId: string;
  let accountId: string | null = null;
  if (idArg && !query) {
    eventId = idArg;
    accountId = await findAccountForArchive(idArg).catch(() => null);
  } else if (query) {
    const q = query.toLowerCase();
    const matches = (await listNotes()).filter((n) => n.title.toLowerCase().includes(q));
    if (matches.length === 0) {
      throw new CliError(
        `no recording matched query "${query}" — try \`ycal recordings\` to list available notes.`,
      );
    }
    if (matches.length > 1) {
      const list = matches.slice(0, 10).map((m) => `  ${m.eventId}  ${m.title}`).join('\n');
      throw new CliError(`${matches.length} notes matched — disambiguate by full event id:\n${list}`);
    }
    eventId = matches[0].eventId;
    accountId = matches[0].accountId;
  } else {
    throw new CliError('usage: ycal note <event-id> | --query "<title-substring>"');
  }

  const note = await getNote(eventId, accountId);
  if (!note.hasSummary && !note.hasTranscript && !note.hasAudio) {
    throw new CliError(
      `no recording found for event id ${eventId} — try \`ycal recordings\` to list available notes.`,
    );
  }

  const speakerName = new Map(note.speakers.map((s) => [s.id, s.name]));
  const format = getFormat(args);
  emit(
    {
      command: 'note',
      eventId: note.eventId,
      accountId: note.accountId,
      title: note.title,
      date: note.date,
      startedAt: note.startedAt ? new Date(note.startedAt).toISOString() : null,
      durationMinutes: Math.round(note.durationSec / 60),
      source: note.source,
      has: { audio: note.hasAudio, transcript: note.hasTranscript, summary: note.hasSummary },
      summary: note.summary,
      decisions: note.decisions,
      actions: note.actions.map((a) => ({ text: a.text, owner: a.owner, done: a.done })),
      openQuestions: note.openQuestions,
      followups: note.followups,
      speakers: note.speakers.map((s) => ({ name: s.name, label: s.label, role: s.role })),
      termsToConfirm: note.terms.map((t) => ({ heard: t.heard, suggestion: t.suggestion, type: t.type })),
      ...(includeTranscript
        ? {
            transcript: note.segments.map((g) => ({
              t: g.t,
              speaker: speakerName.get(g.speakerId) ?? g.speakerId,
              text: segPlainText(g.html),
            })),
          }
        : {}),
    },
    format,
    () => (format === 'markdown' ? renderNoteMarkdown(note) : renderNoteText(note)),
    io,
  );
  return 0;
}

// ---------- Settings: `ycal config` ----------
// Reads and writes the same settings.json the Settings window does, through
// the same setters (setUiSettings / setWeatherUrl), then tells the GUI. The
// key list, types and defaults live in configKeys.ts.

function readConfigSnapshot(): ConfigSnapshot {
  const s = getSettingsStrict();
  if (!s) {
    throw new CliError(
      'settings.json is unreadable right now (iCloud Drive may be mid-sync). '
      + 'Nothing was read or written — try again in a moment.',
    );
  }
  return s;
}

function lookupConfigKey(key: string): ConfigKeyDef {
  try {
    return lookupKey(key);
  } catch (e) {
    throw new CliError(e instanceof Error ? e.message : String(e));
  }
}

// Tell the GUI about a write it did not make. Our own write updated
// cloudStore's `lastSeen`, so the file watcher will — correctly — never
// report it; without this push the renderer keeps its stale copy, and its
// next auto-save (which sends every slice) quietly reverts the CLI's change.
// Same payload the watcher sends for a remote edit, applied idempotently.
function broadcastSettingsChange(): void {
  // In-process mode (`yCal --cli`) is a separate process: the running GUI's
  // file watcher sees our write like any other edit and pushes it itself.
  if (isCliInvocation(process.argv)) return;
  const snap = getSettingsSnapshotStrict();
  if (snap) {
    // "Unset" and '' both mean the built-in summary prompt, but the renderer
    // skips a key that is absent from a push — so a cleared prompt must be
    // sent as '' or it would come back on the renderer's next save.
    const payload = {
      ...snap,
      ui: { ...snap.ui, recordingSummaryPrompt: snap.ui.recordingSummaryPrompt ?? '' },
    };
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(IPC.SettingsChanged, payload);
    }
  }
  // What the SetUiSettings IPC handler does after every write.
  scheduleAppleCalendarAutoSync();
}

function effectiveValue(def: ConfigKeyDef, s: ConfigSnapshot): ConfigValue {
  const v = def.read(s);
  return v === undefined ? def.default : v;
}

// The part of a view worth echoing after `set`: value (or, for a secret,
// only whether it is set and how long) and where it came from.
function briefView(v: ConfigView): Record<string, unknown> {
  return v.secret
    ? { configured: v.configured, length: v.length }
    : { value: v.value, source: v.source };
}

function renderConfigTable(views: ConfigView[], format: Format): string {
  if (views.length === 0) return '(no settings)';
  if (format === 'markdown') {
    return [
      '| key | value | |',
      '| --- | --- | --- |',
      ...views.map((v) => `| \`${v.key}\` | ${renderViewValue(v).replace(/\|/g, '\\|').replace(/\n/g, ' ')} | ${v.source === 'default' ? 'default' : ''} |`),
    ].join('\n');
  }
  const width = Math.max(...views.map((v) => v.key.length));
  return views
    .map((v) => {
      let shown = renderViewValue(v).replace(/\n/g, '⏎');
      if (shown.length > 60) shown = `${shown.slice(0, 57)}… (${shown.length} chars)`;
      return `${v.key.padEnd(width)}  ${shown}${v.source === 'default' ? '  (default)' : ''}`;
    })
    .join('\n');
}

const CONFIG_USAGE = 'usage: ycal config list [prefix] | get <key> | set <key> <value>';

function cmdConfig(args: ParsedArgs, io: CliIo): number {
  const format = getFormat(args);
  const [action = 'list', ...rest] = args.positional;

  if (action === 'list') {
    if (rest.length > 1) throw new CliError(CONFIG_USAGE);
    const prefix = rest[0];
    const defs = prefix ? CONFIG_KEYS.filter((d) => d.key.startsWith(prefix)) : CONFIG_KEYS;
    if (defs.length === 0) {
      throw new CliError(`no config keys start with "${prefix}". Run \`ycal config list\` for all of them.`);
    }
    const snap = readConfigSnapshot();
    const views = defs.map((d) => viewOf(d, snap));
    emit(
      { command: 'config', action: 'list', count: views.length, settings: views },
      format,
      () => renderConfigTable(views, format),
      io,
    );
    return 0;
  }

  if (action === 'get') {
    if (rest.length !== 1) throw new CliError('usage: ycal config get <key>');
    const def = lookupConfigKey(rest[0]);
    const view = viewOf(def, readConfigSnapshot());
    emit({ command: 'config', action: 'get', ...view }, format, () => renderViewValue(view), io);
    return 0;
  }

  if (action === 'set') {
    if (rest.length !== 2) {
      throw new CliError(
        'usage: ycal config set <key> <value>  (quote a value with spaces; "" clears a text value)',
      );
    }
    const def = lookupConfigKey(rest[0]);
    let value: ConfigValue;
    try {
      value = parseValue(def, rest[1]);
    } catch (e) {
      throw new CliError(e instanceof Error ? e.message : String(e));
    }
    const before = readConfigSnapshot();
    const invalid = def.check?.(before, value);
    if (invalid) throw new CliError(invalid);

    const patch = def.patch(before, value);
    try {
      if (patch.ui) setUiSettings(patch.ui);
      if (patch.weatherIcsUrl !== undefined) {
        setWeatherUrl(patch.weatherIcsUrl);
        clearWeatherCache(); // what the SetWeatherUrl IPC handler does
      }
    } catch (e) {
      throw new CliError(`could not write settings.json: ${e instanceof Error ? e.message : String(e)}`);
    }
    // The setters return nothing and skip the write when settings.json turns
    // unreadable between our read and theirs — read back rather than assume.
    const after = readConfigSnapshot();
    if ((def.read(after) ?? null) !== value) {
      throw new CliError(
        `${def.key} did not take effect (settings.json may be mid-sync). Try again in a moment.`,
      );
    }
    broadcastSettingsChange();

    const beforeView = viewOf(def, before);
    const afterView = viewOf(def, after);
    const changed = effectiveValue(def, before) !== effectiveValue(def, after);
    emit(
      {
        command: 'config',
        action: 'set',
        key: def.key,
        secret: isSecretKey(def),
        changed,
        before: briefView(beforeView),
        after: briefView(afterView),
      },
      format,
      () => (changed
        ? `${def.key}: ${renderViewValue(beforeView)} → ${renderViewValue(afterView)}`
        : `${def.key}: already ${renderViewValue(afterView)}`),
      io,
    );
    for (const hint of configSetHints(def, value)) io.err.write(`ycal: ${hint}\n`);
    return 0;
  }

  throw new CliError(`unknown config action "${action}". ${CONFIG_USAGE}`);
}

// Settings whose value only matters once something else is installed —
// say so at the moment the user flips them, not at the next meeting.
function configSetHints(def: ConfigKeyDef, value: ConfigValue): string[] {
  if (def.key === 'recorderDiarize.enabled' && value === true && !isDiarizeVenvReady()) {
    return ['diarization is on, but the diarize venv is not ready — run `ycal recorder setup`.'];
  }
  if (def.key === 'recordingWhisperModel' && !getRecorderSetupStatus().whisperModel.installed) {
    return [`whisper model ${String(value)} is not downloaded yet — run \`ycal recorder setup --all\`.`];
  }
  if (def.key === 'recorderDiarize.hfToken') {
    return ['nothing reads this token since the switch to Nemotron; it is kept for older yCal builds sharing settings.json.'];
  }
  return [];
}

// ---------- Recording pipeline: `ycal recorder` ----------

function tildify(p: string | null): string {
  if (!p) return '—';
  const home = os.homedir();
  return p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
}

function shortCommit(c: string | null): string {
  return c ? c.slice(0, 12) : 'none';
}

// The Settings → Recording probe, plus what the grid shows around it: the
// selected model, the pinned transformers commit, and the two toggles.
function recorderStatusDoc() {
  const st = getRecorderSetupStatus();
  const ui = getUiSettings();
  const model = getModelById(ui.recordingWhisperModel);
  return {
    ...st,
    whisperModel: { ...st.whisperModel, id: model.id, expectedBytes: model.sizeBytes },
    diarizeVenv: { ...st.diarizeVenv, expectedCommit: DIARIZE_TRANSFORMERS_COMMIT },
    diarizeEnabled: ui.recorderDiarize?.enabled ?? false,
    autoRecordMeetings: ui.autoRecordMeetings ?? false,
    setupInFlight: getRecorderSetupInFlight()?.kind ?? null,
  };
}

function renderRecorderStatus(doc: ReturnType<typeof recorderStatusDoc>): string {
  const mark = (ok: boolean): string => (ok ? '✓' : '✗');
  const gb = (n: number): string => `${(n / 1e9).toFixed(2)} GB`;
  const m = doc.whisperModel;
  const d = doc.diarizeVenv;
  const venvState = d.installed
    ? 'READY'
    : d.stale ? 'STALE (built for an older engine — rebuild)' : 'NOT INSTALLED';
  const lines = [
    `Recording pipeline  ${doc.ready ? 'READY' : 'NOT READY'}   (auto-record ${doc.autoRecordMeetings ? 'on' : 'off'})`,
    `  ${mark(doc.ffmpeg.installed)} ffmpeg          ${tildify(doc.ffmpeg.path)}`,
    `  ${mark(doc.whisperCli.installed)} whisper-cli     ${tildify(doc.whisperCli.path)}`,
    `  ${mark(m.installed)} whisper model   ${m.id}  ${gb(m.sizeBytes)} of ${gb(m.expectedBytes)}  ${tildify(m.path)}`,
    `  ${mark(doc.coreaudioTap.installed)} coreaudio-tap   ${tildify(doc.coreaudioTap.path)}`,
    `  ${mark(doc.scripts.installed)} scripts         ~/.ycal/record-meet.sh + post-meet.sh`,
    `  ${mark(doc.claude.installed)} claude          ${tildify(doc.claude.path)}   (summaries)`,
    `  ${mark(doc.brew.installed)} brew            ${tildify(doc.brew.path)}   (installer only)`,
    `Diarization         ${doc.diarizeEnabled ? 'enabled' : 'disabled'} · venv ${venvState}`,
    `  transformers      ${shortCommit(d.transformersCommit)}  (pinned ${shortCommit(d.expectedCommit)})`,
    `  python            ${tildify(d.pythonPath)}`,
    `  venv              ${tildify(d.venvPath)}`,
  ];
  if (doc.setupInFlight) lines.push(`Setup running       ${doc.setupInFlight}`);
  const next: string[] = [];
  if (doc.setupInFlight) {
    next.push('`ycal recorder setup` follows the running setup to its end.');
  } else {
    if (!doc.ffmpeg.installed || !doc.whisperCli.installed || !m.installed) {
      next.push('`ycal recorder setup --all` installs ffmpeg / whisper-cpp and the model.');
    }
    if (!d.installed && (doc.diarizeEnabled || d.stale)) {
      next.push('`ycal recorder setup` builds the diarize venv.');
    }
  }
  if (next.length > 0) lines.push('', ...next.map((n) => `Next: ${n}`));
  return lines.join('\n');
}

function untilAborted(signal?: AbortSignal): Promise<null> {
  return new Promise((resolve) => {
    if (!signal) return; // in-process: the process is the caller
    if (signal.aborted) resolve(null);
    else signal.addEventListener('abort', () => resolve(null), { once: true });
  });
}

interface SetupStepOutcome extends RecorderSetupResult {
  step: RecorderSetupKind;
  // True when this step's run was already going (from Settings, or a
  // previous CLI call whose client gave up) and we followed it.
  attached: boolean;
}

async function cmdRecorderSetup(args: ParsedArgs, io: CliIo): Promise<number> {
  const format = getFormat(args);
  const steps: RecorderSetupKind[] = args.flags.all ? ['deps', 'diarize'] : ['diarize'];
  const say = (line: string): void => {
    if (io.note) io.note(`${line}\n`);
    else io.err.write(`${line}\n`);
  };
  const gone = untilAborted(io.signal);

  // The runners' progress, as the Settings log shows it. Errors are left
  // out here: each one is reported once, as the step's result.
  let lastDecile = -1;
  const off = onRecorderSetupProgress((p) => {
    if (p.phase === 'error') return;
    if (p.phase === 'model') {
      if (typeof p.modelPercent === 'number') {
        const decile = Math.floor(p.modelPercent / 10);
        if (decile !== lastDecile) {
          lastDecile = decile;
          say(`[model] downloading ${Math.floor(p.modelPercent)}%`);
        }
        return;
      }
      // curl's bare progress-bar redraws carry no words; skip them.
      if (!p.line || !/[a-z]/i.test(p.line)) return;
    }
    if (p.line) say(`[${p.phase}] ${p.line}`);
  });

  const outcomes: SetupStepOutcome[] = [];
  try {
    for (const step of steps) {
      let job = getRecorderSetupInFlight();
      if (job && job.kind !== step) {
        say(`[wait] a ${job.kind} setup is already running — waiting for it to finish`);
        if ((await Promise.race([job.promise, gone])) === null) return 1;
        job = getRecorderSetupInFlight();
      }
      const attached = !!job && job.kind === step;
      if (attached) say(`[${step}] already running (started elsewhere) — following it`);
      const run = attached && job
        ? job.promise
        : step === 'deps' ? runRecorderSetup() : runDiarizeSetup();
      // The caller hung up: stop reporting, but let the setup finish — a
      // venv abandoned half-way through pip would only need rebuilding.
      const result = await Promise.race([run, gone]);
      if (result === null) return 1;
      outcomes.push({ step, attached, ...result });
      if (!result.ok) break;
    }
  } finally {
    off();
  }

  const failed = outcomes.find((o) => !o.ok);
  const st = getRecorderSetupStatus();
  const ok = !failed;
  emit(
    {
      command: 'recorder',
      action: 'setup',
      ok,
      steps: outcomes,
      ready: st.ready,
      diarizeVenv: {
        installed: st.diarizeVenv.installed,
        transformersCommit: st.diarizeVenv.transformersCommit,
        expectedCommit: DIARIZE_TRANSFORMERS_COMMIT,
      },
    },
    format,
    () => {
      if (failed) return `Recorder setup FAILED (${failed.step}): ${failed.error ?? 'unknown error'}`;
      const parts: string[] = [];
      if (steps.includes('deps')) {
        parts.push(`Recording dependencies ${st.ready ? 'ready' : 'installed (pipeline still NOT READY — see `ycal recorder status`)'}.`);
      }
      parts.push(`Diarization venv ready — transformers ${shortCommit(st.diarizeVenv.transformersCommit)} (pinned).`);
      return parts.join('\n');
    },
    io,
  );
  if (failed) {
    io.err.write(`ycal: recorder setup failed (${failed.step}): ${failed.error ?? 'unknown error'}\n`);
    return 1;
  }
  return 0;
}

async function cmdRecorder(args: ParsedArgs, io: CliIo): Promise<number> {
  const [action = 'status', ...rest] = args.positional;
  if (rest.length > 0) throw new CliError('usage: ycal recorder status | ycal recorder setup [--all]');
  if (action === 'status') {
    const format = getFormat(args);
    const doc = recorderStatusDoc();
    emit(
      { command: 'recorder', action: 'status', ...doc },
      format,
      () => (format === 'markdown'
        ? `\`\`\`\n${renderRecorderStatus(doc)}\n\`\`\``
        : renderRecorderStatus(doc)),
      io,
    );
    return 0;
  }
  if (action === 'setup') return await cmdRecorderSetup(args, io);
  throw new CliError(`unknown recorder action "${action}" (expected status | setup)`);
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
                                   --include-attendees,
                                   --include-read-only,
                                   --include-holidays,
                                   --all-calendars,
                                   --no-dedup
  today                     Shortcut for --from today --to today.
  tomorrow                  Shortcut for --from tomorrow --to tomorrow.
  week                      Shortcut for the current Mon–Sun.
  next [N]                  Next N (default 5) upcoming events.
  find <query>              Search events (default: -7d to +90d).
  watch                     Stream calendar CHANGES as they happen. Never
                            exits; one event per line (JSON by default).
                            Flags: --interval <sec>, --from-days <n>,
                                   --to-days <n>, --rsvp-lead-hours <n>,
                                   --prep-lead-minutes <n>,
                                   --quarantine-polls <n>,
                                   plus the calendar-filtering flags above,
                                   --replay <file.jsonl> (offline)
  weather                   Forecast from the configured weather iCal feed.
  update                    Install the latest yCal release and restart.
  upgrade                   Alias for update.
  recordings                List meeting recordings archived on Google Drive
                            (per-event-account appdata folder).
                            Flags: --limit <n>
  transcript <event-id>     Print the transcript for one recording.
                            Or: --query "<title-substring>"  (must be unique)
  summary    <event-id>     Print the raw summary artifact (Markdown note).
                            Or: --query "<title-substring>"
  note       <event-id>     Print the STRUCTURED meeting note for AI use:
                            summary / decisions / actions / open questions /
                            follow-ups / speakers / terms-to-confirm. JSON by
                            default. Reads local-first, then Drive.
                            Or: --query "<title-substring>"
                            Flag: --include-transcript (fold in timed lines)
  audio      <event-id>     Print the local cache path to the .m4a (does
                            NOT inline binary content). Or --query "...".
  config list [prefix]      Show settings (the Settings window's prefs) with
                            their current value; unset keys show the default.
  config get <key>          One setting. Nested keys use dots:
                            recorderDiarize.enabled, loadWindow.startMin.
  config set <key> <value>  Change one setting, validated against its type
                            (true/false, a number, or one of the listed
                            choices). "" clears a text setting. Unknown keys
                            are an error. The open Settings window updates live.
                            Secrets (tokens, the weather feed URL) are never
                            printed — only whether they are set, and the length.
  recorder status           Recording-pipeline readiness: ffmpeg, whisper-cli,
                            model, coreaudio-tap, scripts, diarize venv (and
                            its transformers commit vs the pinned one).
  recorder setup            Build / upgrade the speaker-diarization venv —
                            the Settings "Setup/Upgrade diarize venv" button.
                            Streams progress to stderr; exit 1 on failure.
                            Flag: --all  (first brew-install ffmpeg /
                            whisper-cpp and download the model, like the
                            Settings "Install" button)

CALENDAR FILTERING
  By default, events commands mirror the GUI agenda:
    • only active accounts (per the title-bar account stack)
    • only visible calendars (per the sidebar toggles)
    • normal and Team OOO marker calendars (read-only and holidays excluded)
  Flags to widen the set:
    --include-attendees     Add the invite list to each event (email, name,
                            RSVP, organizer/self/optional flags). Off by
                            default: it is long, and most callers never read it.
    --include-read-only     Include calendars marked read-only (subscribed)
                            — useful while planning, to see colleague schedules.
    --include-holidays      Include calendars marked as holiday calendars.
    --all-calendars         Bypass GUI filters entirely; behave like a fresh
                            install (only Google's \`selected\` flag respected).
    --calendar <id>         Explicit calendar list — bypasses every filter.

GLOBAL FLAGS
  --format json|text|markdown   Output format. Default: json (LLM-friendly).
  --help, -h                    Show this help.
  --version, -v                 Print the yCal version.

WATCH
  \`ycal watch\` is for a program that must react to the calendar rather than
  read it. Event kinds:

    watch-armed          state was seeded; changes BEFORE this were not
                         replayed and will never arrive
    new-invite           somebody put a meeting on your calendar (an event you
                         created yourself is not an invitation)
    time-changed         it moved. Carries old AND new, because a consumer has
                         to replace a deadline it wrote earlier
    cancelled            it is gone, confirmed over consecutive clean polls
    moved-out-of-window  it left the watched window; NOT a cancellation
    rsvp-due             --rsvp-lead-hours out, RSVP still needsAction
    starting             --prep-lead-minutes out
    watch-error          something went wrong, INCLUDING what was deliberately
                         not concluded and why

  Google's list omits cancelled events rather than flagging them, so a
  cancellation can only be seen as an absence — and a rate-limited calendar,
  a hidden calendar, a re-timed recurring series and the window rolling
  forward all look identical to one. Absences therefore pass a partial-fetch
  gate, series pairing, an edge-of-window check, a quarantine of
  --quarantine-polls clean polls, and a mass-vanish breaker before the word
  "cancelled" is used. Nothing is withheld silently: what was not concluded
  arrives as a watch-error.

  --replay <file.jsonl> runs the same detection offline over recorded
  snapshots — one \`ycal events\` JSON document per line, each optionally
  carrying "now" (ISO) to drive the timers. No GUI, no Google, no network.

DATE SHORTHAND
  today | tomorrow | yesterday | now
  +Nd  +Nw  +Nm  +Nh   (also -Nd, etc.)
  YYYY-MM-DD           (local midnight)
  YYYY-MM-DDTHH:MM     (local time)

EXAMPLES
  ycal today
  ycal events --from 2026-04-27 --to +7d --format markdown
  ycal next 3
  ycal update
  ycal find "1:1" --from -30d
  ycal calendars --account 1042... --format text
  ycal events --calendar primary@gmail.com --include-declined
  ycal week --include-read-only          # planning: see read-only calendars too
  ycal recordings --limit 10             # archived meeting notes on Drive
  ycal summary --query "weekly sync"     # latest matching meeting note
  ycal note --query "Q3 DevOps"          # structured note (JSON) for AI use
  ycal note abcd1234 --include-transcript --format markdown
  ycal transcript abcd1234_20260520T...  # exact event id from recordings list
  ycal config list recorder --format text
  ycal config set recorderDiarize.enabled true
  ycal recorder status --format text
  ycal recorder setup                    # after a yCal upgrade bumps the pin

JSON OUTPUT
  Every JSON document has at minimum: { "command", "count" } plus a payload
  array named after the command (events|accounts|calendars|days). Times are
  ISO 8601; durations are minutes; descriptions are plain text (HTML stripped).

  Event commands also carry { "partial", "failures" }. "partial": true means
  at least one calendar could not be read on this call, so the event array is
  an INCOMPLETE view — an absent event may simply be one we could not see.
  Anything that diffs two snapshots must check this before concluding that an
  event was cancelled. Exit code stays 0; the same failures go to stderr.

EXIT CODES
  0  success
  1  usage or runtime error (details on stderr)
  2  not configured / no accounts signed in
`;
}

// ---------- Entry point ----------

async function cmdUpdate(args: ParsedArgs, version: string, io: CliIo): Promise<number> {
  const format = getFormat(args);
  if (!app.isPackaged) {
    throw new CliError(
      'self-update is only available from an installed yCal.app release',
    );
  }

  const stopProgress = io.progress
    ? onUpdateStatus((status) => io.progress?.(status))
    : () => {};
  try {
    await checkForUpdatesNow();
    const checked = getLastUpdateStatus();
    if (checked.state === 'error') {
      throw new CliError(`update check failed: ${checked.error ?? 'unknown error'}`);
    }

    if (checked.state === 'idle') {
      emit(
        {
          command: args.command,
          currentVersion: version,
          latestVersion: version,
          updated: false,
          status: 'up-to-date',
        },
        format,
        () => `yCal ${version} is already up to date.`,
        io,
      );
      return 0;
    }

    if ((checked.state !== 'available' && checked.state !== 'ready')
        || !checked.version) {
      throw new CliError(`cannot install update while updater is ${checked.state}`);
    }

    const nextVersion = checked.version;
    await requestInstall();
    const installed = getLastUpdateStatus();
    if (installed.state === 'error') {
      throw new CliError(`update failed: ${installed.error ?? 'unknown error'}`);
    }
    if (installed.state !== 'installing') {
      throw new CliError(`update did not start (updater is ${installed.state})`);
    }

    emit(
      {
        command: args.command,
        currentVersion: version,
        latestVersion: nextVersion,
        updated: true,
        status: 'restarting',
      },
      format,
      () => `Updating yCal ${version} → ${nextVersion}. The app will restart automatically.`,
      io,
    );
    return 0;
  } finally {
    stopProgress();
  }
}

export async function runCli(
  argv: string[],
  out: Writable = process.stdout,
  err: Writable = process.stderr,
  progress?: (status: UpdateStatus) => void,
  stream?: {
    emit?: (line: string) => void;
    note?: (line: string) => void;
    signal?: AbortSignal;
  },
): Promise<number> {
  const io: CliIo = { out, err, progress, ...stream };
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
      case 'watch':
        return await cmdWatch(args, io);
      case 'weather':
        return await cmdWeather(args, io);
      case 'update':
      case 'upgrade':
        return await cmdUpdate(args, version, io);
      case 'recordings':
        return await cmdRecordings(args, io);
      case 'transcript':
        return await cmdMeetingArtifact(args, 'transcript', io);
      case 'summary':
        return await cmdMeetingArtifact(args, 'summary', io);
      case 'note':
        return await cmdNote(args, io);
      case 'audio':
        return await cmdMeetingArtifact(args, 'audio', io);
      case 'config':
        return cmdConfig(args, io);
      case 'recorder':
        return await cmdRecorder(args, io);
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
