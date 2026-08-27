// The live half of `ycal watch`: poll, persist, broadcast.
//
// All the judgement lives in @shared/calendarWatch (pure, replayable). This
// file only supplies the three things that engine deliberately does not have:
// a clock, Google, and a disk.
//
// Detection runs ONLY while at least one consumer is attached, and the state
// snapshot is persisted. Those two together are what make a consumer's
// downtime lossless rather than silent: on reattach the first poll diffs
// against the last persisted snapshot, so everything that changed while it was
// away arrives at once instead of being missed. Running the loop with nobody
// attached would advance the snapshot past changes no one ever heard.
import { app } from 'electron';
import * as path from 'node:path';
import { promises as fsp, readFileSync } from 'node:fs';
import { listAllCalendars, listEvents } from './calendar';
import { getUiSettings } from './settings';
import { resolveTargets, calKey, type TargetFilter } from './calendarTargets';
import {
  DEFAULT_WATCH_CONFIG,
  WATCH_STATE_VERSION,
  emptyState,
  evictUnwatched,
  ingest,
  runTimers,
  snapshotOf,
  type WatchConfig,
  type WatchEvent,
  type WatchInput,
  type WatchState,
} from '@shared/calendarWatch';
import type { CalendarEvent } from '@shared/types';

const STATE_FILENAME = 'watch-state.json';

export interface WatchRunnerOptions {
  // Day offsets, quantised to local midnight boundaries exactly like the CLI's
  // -Nd / +Nd shorthand. Quantising matters: it keeps the requested window (and
  // therefore listEvents' cache key) identical across polls, so the events
  // cache and — more importantly — its "serve the last fully successful
  // snapshot when a refresh fails" fallback both engage. A window measured in
  // hours from now would be a different key every single poll.
  fromDays: number;
  toDays: number;
  pollSeconds: number;
  config: WatchConfig;
  filter: TargetFilter;
}

export const DEFAULT_WATCH_RUNNER: Omit<WatchRunnerOptions, 'filter'> = {
  fromDays: -1,
  toDays: 14,
  pollSeconds: 60,
  config: DEFAULT_WATCH_CONFIG,
};

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function endOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function statePath(): string {
  return path.join(app.getPath('userData'), STATE_FILENAME);
}

function loadState(): WatchState | null {
  try {
    const parsed = JSON.parse(readFileSync(statePath(), 'utf-8')) as WatchState;
    if (!parsed || parsed.version !== WATCH_STATE_VERSION) return null;
    if (!parsed.events || !parsed.missing || !parsed.fired) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function saveState(state: WatchState): Promise<void> {
  // Write-then-rename: a watcher killed mid-write must not leave half a state
  // behind, because a truncated state file re-seeds — and a re-seed silently
  // swallows every change that happened while it was gone.
  const target = statePath();
  const tmp = `${target}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(state), 'utf-8');
  await fsp.rename(tmp, target);
}

function toWatchInput(ev: CalendarEvent, calendarName: string): WatchInput {
  return {
    id: ev.id,
    accountId: ev.accountId,
    calendarId: ev.calendarId,
    ...(ev.recurringEventId ? { recurringEventId: ev.recurringEventId } : {}),
    title: ev.title,
    start: ev.start,
    end: ev.end,
    allDay: ev.allDay,
    status: ev.status,
    eventType: ev.eventType,
    location: ev.location,
    url: ev.htmlLink,
    ...(ev.meetUrl ? { meetUrl: ev.meetUrl } : {}),
    rsvp: ev.rsvp,
    calendarName,
    attendees: (ev.attendees ?? []).map((a) => ({
      email: a.email,
      name: a.name,
      rsvp: a.rsvp,
      organizer: a.organizer,
      self: a.self,
      resource: a.resource,
    })),
  };
}

interface Fetched {
  events: WatchInput[];
  partial: boolean;
  windowFrom: string;
  windowTo: string;
  // The (account, calendar) pairs this poll actually watched. Carried out of
  // the fetch because the set is resolved fresh every poll — untick a
  // calendar and the state file is still full of its events.
  watched: Set<string>;
}

async function fetchSnapshot(opts: WatchRunnerOptions): Promise<Fetched> {
  const now = new Date();
  const timeMin = startOfDay(addDays(now, opts.fromDays));
  const timeMax = endOfDay(addDays(now, opts.toDays));

  const all = await listAllCalendars();
  const ui = getUiSettings();
  const targets = resolveTargets(all, ui, opts.filter);
  if (targets.pairs.length === 0) {
    return {
      events: [],
      partial: false,
      windowFrom: timeMin.toISOString(),
      windowTo: timeMax.toISOString(),
      watched: targets.pairKeys,
    };
  }
  const byId = new Map(all.map((c) => [c.id, c]));

  // No `force`: the 30s events cache is a feature here. The poll interval is
  // longer than the TTL, so we still see fresh data, and a renderer refresh
  // that just happened is reused instead of paid for twice.
  const res = await listEvents({
    timeMin: timeMin.toISOString(),
    timeMax: timeMax.toISOString(),
    calendarIds: targets.calendarIds,
  });

  // NOTE: declined events are deliberately NOT filtered out here, unlike the
  // events commands. Declining an invite would otherwise look exactly like the
  // event being deleted.
  const events = res.events
    .filter((ev) => targets.pairKeys.has(calKey(ev.accountId, ev.calendarId)))
    .map((ev) => toWatchInput(ev, byId.get(ev.calendarId)?.name ?? ev.calendarId));

  return {
    events,
    partial: res.failures.length > 0,
    windowFrom: timeMin.toISOString(),
    windowTo: timeMax.toISOString(),
    watched: targets.pairKeys,
  };
}

// --------------------------------------------------------------------------
// Subscribers
// --------------------------------------------------------------------------

export type WatchListener = (ev: WatchEvent) => void;

const listeners = new Set<WatchListener>();
let activeOptions: WatchRunnerOptions | null = null;
let loopRunning = false;
let stopRequested = false;
let wakeUp: (() => void) | null = null;

function broadcast(ev: WatchEvent): void {
  for (const l of listeners) {
    try {
      l(ev);
    } catch {
      /* one bad consumer must not take down the others, or the loop */
    }
  }
}

function sleep(msec: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      wakeUp = null;
      resolve();
    }, msec);
    wakeUp = () => {
      clearTimeout(timer);
      wakeUp = null;
      resolve();
    };
  });
}

async function loop(opts: WatchRunnerOptions): Promise<void> {
  loopRunning = true;
  try {
    let state = loadState();
    if (!state) {
      // Seed: record the world as it is; do NOT replay history as events.
      const first = await fetchSnapshot(opts);
      state = emptyState();
      const now = Date.now();
      state.events = snapshotOf(first.events, opts.config, now);
      state.windowTo = first.windowTo;
      // Arm the timers without firing them: on fresh state every meeting in
      // the next day is already "overdue" for its RSVP reminder.
      runTimers(state, opts.config, now, true);
      await saveState(state);
      broadcast({
        kind: 'watch-armed',
        at: new Date(now).toISOString(),
        tracked: Object.keys(state.events).length,
        windowTo: first.windowTo,
        pollSeconds: opts.pollSeconds,
      });
    }

    while (!stopRequested) {
      let nextDue: number | null = null;
      try {
        const got = await fetchSnapshot(opts);
        const now = Date.now();
        const cur = snapshotOf(got.events, opts.config, now);
        // BEFORE the diff, not after: an event on a calendar we stopped
        // watching must never reach ingest, where its absence would read as a
        // cancellation. Silent on purpose — see evictUnwatched.
        evictUnwatched(state, got.watched);
        for (const ev of ingest(state, cur, {
          partial: got.partial,
          windowFrom: got.windowFrom,
          windowTo: got.windowTo,
          now,
          config: opts.config,
        })) {
          broadcast(ev);
        }
        const timers = runTimers(state, opts.config, Date.now());
        for (const ev of timers.events) broadcast(ev);
        nextDue = timers.nextDue;
        await saveState(state);
      } catch (e) {
        // Do NOT advance state on a failed poll: the next good one must still
        // see the real diff rather than a diff against nothing. And say so —
        // "no events" and "not watching" look identical from the outside.
        broadcast({
          kind: 'watch-error',
          at: new Date().toISOString(),
          what: 'fetch',
          detail: e instanceof Error ? e.message : String(e),
        });
      }
      if (stopRequested) break;
      // Sleep to the next poll OR the next timer, whichever is sooner: a
      // "starts in 10 minutes" delivered 60 seconds late is a different
      // sentence from the one we meant to send. The floor stops a clump of
      // near-simultaneous timers from spinning.
      let delay = opts.pollSeconds * 1000;
      if (nextDue !== null) delay = Math.max(5000, Math.min(delay, nextDue - Date.now()));
      await sleep(delay);
    }
  } finally {
    loopRunning = false;
    stopRequested = false;
    activeOptions = null;
  }
}

/** Attach a consumer. Returns an unsubscribe function.
 *
 * The first subscriber starts the poll loop with ITS options; later
 * subscribers join the running loop and share its stream. That is deliberate:
 * one loop means one state file and one advance per poll. Two loops over one
 * state file would each consume half the changes and neither would notice.
 */
export function subscribeWatch(
  opts: WatchRunnerOptions,
  listener: WatchListener,
): () => void {
  if (loopRunning && activeOptions && JSON.stringify(activeOptions) !== JSON.stringify(opts)) {
    // Say so rather than pretending. A second consumer asking for a different
    // window or interval silently getting the first one's is the kind of thing
    // that reads as "the watcher is broken" three days later.
    listener({
      kind: 'watch-error',
      at: new Date().toISOString(),
      what: 'internal',
      detail:
        'joined a watch loop that was already running with different settings ' +
        `(active: ${JSON.stringify(activeOptions)}) — yours were ignored. One ` +
        'loop, one state file, on purpose: two loops would each consume half ' +
        'the changes and neither would notice.',
    });
  }
  listeners.add(listener);
  if (!loopRunning) {
    stopRequested = false;
    activeOptions = opts;
    void loop(opts);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      stopRequested = true;
      wakeUp?.();
    }
  };
}

export function watchSubscriberCount(): number {
  return listeners.size;
}
