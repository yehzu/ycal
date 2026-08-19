// Change detection over calendar snapshots — the pure half of `ycal watch`.
//
// NO ELECTRON, NO I/O, NO CLOCK OF ITS OWN. Everything here is a function of
// (previous state, new snapshot, now). That is what lets `ycal watch --replay`
// drive it deterministically from recorded snapshots, which is how this logic
// gets tested in a repo with no test runner.
//
// --------------------------------------------------------------------------
// WHY THIS IS MOSTLY GUARD RAILS
// --------------------------------------------------------------------------
// Google's events.list is called with singleEvents=true and WITHOUT
// showDeleted, so a cancelled event is not returned as `status: cancelled` —
// it simply is not in the list any more. Measured on a real calendar
// 2026-08-18: 93 events over -1d..+14d, `status` === 'confirmed' for all 93.
// There is no cancellation signal.
//
// So CANCELLATION CAN ONLY BE OBSERVED AS AN ABSENCE, and an absence has at
// least six causes:
//
//   1. genuinely cancelled                      -> report it
//   2. moved outside the watched window         -> a CHANGE, not a cancellation
//   3. a per-calendar fetch failure (429/5xx)   -> report NOTHING
//   4. a calendar/account hidden in the GUI     -> report NOTHING
//   5. the owner declined it                    -> keep declined events in view
//   6. a recurring SERIES was re-timed          -> ids all change at once
//
// (6) is the common case, not an edge case: 59 of those 93 events were
// recurring instances, whose id is `<seriesId>_<originalStartUTC>`. Re-time the
// series and every instance id changes in one poll — which naively reads as a
// mass cancellation plus a mass invitation.
//
// Hence the gauntlet an absence runs before anyone hears about it:
//
//   partial gate        a poll that could not read every calendar never judges
//                       an absence (changes to events we CAN see still count)
//   series pairing      vanished A_x + appeared A_y from one series is a
//                       single time-changed, never cancel + create
//   edge-of-window      vanished from near the far edge -> moved-out-of-window
//   quarantine          an absence must survive N consecutive clean polls
//   mass-vanish breaker too many at once -> report the anomaly, judge nothing
//
// The same doctrine already governs this app's Apple Calendar mirror: "a
// partial Google fetch aborts before the helper runs, so missing remote data
// can never become mass deletion."

export interface WatchAttendee {
  email: string;
  name: string | null;
  rsvp: string;
  organizer: boolean;
  self: boolean;
  resource: boolean;
}

// The normalised shape the engine consumes. The live runner maps a
// CalendarEvent into this; --replay maps a recorded `ycal events` document
// into it. Keeping the engine off both concrete shapes is what stops a change
// to either from quietly altering detection.
export interface WatchInput {
  id: string;
  recurringEventId?: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  status: string;
  eventType: string | null;
  location: string | null;
  url: string | null;
  meetUrl?: string;
  rsvp: string | null;
  calendarName: string;
  attendees: WatchAttendee[];
}

// What we keep per event. Wider than what we compare: an event has to stay
// describable after it has disappeared.
export interface WatchRecord {
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  status: string;
  location: string | null;
  url: string | null;
  meetUrl?: string;
  series: string | null;
  calendar: string;
  rsvp: string | null;
  attendees: WatchAttendee[];
  // When we FIRST saw this event. Carried across polls. Without it there is no
  // way to tell "we were down when this reminder came due" from "this invite
  // arrived after its own reminder time" — and the second case, an invite that
  // lands the same day, is the one that most needs the reminder.
  seenAt: number;
}

export interface WatchState {
  version: number;
  events: Record<string, WatchRecord>;
  missing: Record<string, { polls: number; since: number; rec: WatchRecord }>;
  fired: Record<string, number>;
  windowTo: string | null;
}

export interface WatchConfig {
  quarantinePolls: number;
  massVanishRatio: number;
  massVanishMin: number;
  edgeDays: number;
  rsvpLeadHours: number;
  prepLeadMinutes: number;
  lateNoticeMinutes: number;
  skipEventTypes: string[];
}

export const WATCH_STATE_VERSION = 1;

export const DEFAULT_WATCH_CONFIG: WatchConfig = {
  // 2 polls is ~2 minutes of extra latency on a real cancellation, which is
  // nothing against a deadline the consumer would otherwise get wrong in the
  // other direction.
  quarantinePolls: 2,
  // Trips on ratio OR floor, whichever is larger, so a 3-event calendar does
  // not trip on one ordinary cancellation.
  massVanishRatio: 0.3,
  massVanishMin: 5,
  edgeDays: 1,
  rsvpLeadHours: 24,
  prepLeadMinutes: 10,
  lateNoticeMinutes: 15,
  // Working locations are not meetings; they only add churn.
  skipEventTypes: ['workingLocation'],
};

export type WatchEventKind =
  | 'new-invite'
  | 'time-changed'
  | 'cancelled'
  | 'moved-out-of-window'
  | 'rsvp-due'
  | 'starting';

interface WatchEventBase {
  at: string;
  id: string;
  title: string;
  calendar: string;
  url: string | null;
  meetUrl?: string;
  allDay: boolean;
}

export type WatchEvent =
  | (WatchEventBase & {
      kind: 'time-changed';
      // Both sides matter: a consumer has to REPLACE a deadline, so it needs
      // the old value to find what it wrote and the new one to write.
      old: { start: string; end: string };
      new: { start: string; end: string };
      // Set when the pairing came from a re-timed recurring series.
      prevId?: string;
      series?: string | null;
    })
  | (WatchEventBase & {
      kind: 'new-invite';
      start: string;
      end: string;
      rsvp: string | null;
      location: string | null;
      attendees: WatchAttendee[];
    })
  | (WatchEventBase & {
      kind: 'cancelled' | 'moved-out-of-window';
      was: { start: string; end: string };
      confirmedPolls: number;
    })
  | (WatchEventBase & {
      kind: 'rsvp-due' | 'starting';
      start: string;
      end: string;
      minutesUntilStart: number;
      // 0 unless we could genuinely have sent this earlier and did not.
      reminderLateMinutes: number;
      rsvp: string | null;
      location: string | null;
      attendees: WatchAttendee[];
    })
  | {
      kind: 'watch-error';
      at: string;
      what: 'absence-withheld' | 'mass-vanish' | 'fetch' | 'internal';
      detail: string;
    }
  // Emitted once, by the runner, when a fresh state file has been seeded. It
  // carries no change: seeding records the world as it is rather than
  // replaying it. A consumer that sees this knows its baseline is new, so
  // anything that changed before this moment will never arrive.
  | {
      kind: 'watch-armed';
      at: string;
      tracked: number;
      windowTo: string;
      pollSeconds: number;
    };

export function emptyState(): WatchState {
  return {
    version: WATCH_STATE_VERSION,
    events: {},
    missing: {},
    fired: {},
    windowTo: null,
  };
}

/** The recurring-series half of an instance id — the fallback path.
 *
 * Instance ids look like `<seriesId>_<originalStartUTC>`. `recurringEventId` is
 * the authoritative answer and is preferred; this parse covers a snapshot
 * recorded before that field existed.
 */
export function seriesFromId(id: string): string | null {
  const m = /^(.+)_(\d{8}T\d{6}Z)$/.exec(id);
  return m ? m[1] : null;
}

export function toRecord(ev: WatchInput, now: number): WatchRecord {
  return {
    title: ev.title,
    start: ev.start,
    end: ev.end,
    allDay: ev.allDay,
    status: ev.status,
    location: ev.location,
    url: ev.url,
    ...(ev.meetUrl ? { meetUrl: ev.meetUrl } : {}),
    series: ev.recurringEventId ?? seriesFromId(ev.id),
    calendar: ev.calendarName,
    rsvp: ev.rsvp,
    // Rooms and projectors arrive as attendees too. Dropping them HERE rather
    // than at each point of use means nothing downstream can report a
    // Chromebox as a participant.
    attendees: ev.attendees.filter((a) => !a.resource),
    seenAt: now,
  };
}

export function snapshotOf(
  events: WatchInput[],
  cfg: WatchConfig,
  now: number,
): Record<string, WatchRecord> {
  const out: Record<string, WatchRecord> = {};
  for (const ev of events) {
    if (!ev.id) continue;
    if (ev.eventType && cfg.skipEventTypes.includes(ev.eventType)) continue;
    out[ev.id] = toRecord(ev, now);
  }
  return out;
}

function ms(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t;
}

function normTitle(rec: WatchRecord): string {
  return rec.title.trim().toLowerCase();
}

/** Did somebody invite ME, or did I put this on my own calendar?
 *
 * Two independent signals, because some calendars withhold attendee lists:
 *   - a self attendee record that is NOT the organizer -> I was invited
 *   - rsvp still needsAction -> nobody waits on an answer from the person who
 *     created the event
 * A solo block on your own calendar matches neither, and stays silent.
 */
export function isInvite(rec: WatchRecord): boolean {
  for (const a of rec.attendees) {
    if (a.self) return !a.organizer;
  }
  return rec.rsvp === 'needsAction';
}

function base(id: string, rec: WatchRecord, at: string): WatchEventBase {
  return {
    at,
    id,
    title: rec.title,
    calendar: rec.calendar,
    url: rec.url,
    ...(rec.meetUrl ? { meetUrl: rec.meetUrl } : {}),
    allDay: rec.allDay,
  };
}

/** Match a vanished instance to a newly appeared one from the same series.
 *
 * Only pairs when the series AND the normalised title both match, and only one
 * candidate exists — an ambiguous match is left to the ordinary quarantine path
 * rather than guessed at.
 */
function pairSeries(
  vanished: string[],
  appeared: string[],
  prev: Record<string, WatchRecord>,
  cur: Record<string, WatchRecord>,
): Map<string, string> {
  const bySeries = new Map<string, string[]>();
  for (const id of appeared) {
    const key = cur[id].series;
    if (!key) continue;
    const k = `${key} ${normTitle(cur[id])}`;
    const list = bySeries.get(k);
    if (list) list.push(id);
    else bySeries.set(k, [id]);
  }
  const pairs = new Map<string, string>();
  const taken = new Set<string>();
  for (const oldId of vanished) {
    const key = prev[oldId].series;
    if (!key) continue;
    const cands = (bySeries.get(`${key} ${normTitle(prev[oldId])}`) ?? []).filter(
      (c) => !taken.has(c),
    );
    if (cands.length === 1) {
      pairs.set(oldId, cands[0]);
      taken.add(cands[0]);
    }
  }
  return pairs;
}

export interface IngestOptions {
  partial: boolean;
  // BOTH edges are needed, and for different reasons. The far edge classifies
  // an event rescheduled past the horizon as moved-out-of-window rather than
  // cancelled. The NEAR edge is what stops the watcher reporting every one of
  // yesterday's meetings as cancelled at midnight: a window of -1d..+14d moves
  // its start forward every night, and everything on the day that drops off
  // the back vanishes from the snapshot at once.
  windowFrom: string | null;
  windowTo: string | null;
  now: number;
  config: WatchConfig;
}

/** Fold one snapshot into state, returning everything it proves.
 *
 * Mutates `state`. Emitting and persisting are the caller's job.
 */
export function ingest(
  state: WatchState,
  cur: Record<string, WatchRecord>,
  opts: IngestOptions,
): WatchEvent[] {
  const { partial, now, config: cfg } = opts;
  const at = new Date(now).toISOString();
  const out: WatchEvent[] = [];
  const prev = state.events;
  const prevWindowTo = state.windowTo;
  const windowTo = opts.windowTo ?? prevWindowTo;

  // Carry the first-seen stamp forward: records are replaced wholesale.
  for (const [id, rec] of Object.entries(cur)) {
    rec.seenAt = prev[id]?.seenAt ?? now;
  }

  // 1. Changes among events present in BOTH snapshots. Trustworthy even on a
  // partial fetch: a lost calendar can hide an event, it cannot invent a new
  // start time.
  for (const [id, fresh] of Object.entries(cur)) {
    const was = prev[id];
    if (!was) continue;
    if (was.start !== fresh.start || was.end !== fresh.end) {
      out.push({
        ...base(id, fresh, at),
        kind: 'time-changed',
        old: { start: was.start, end: was.end },
        new: { start: fresh.start, end: fresh.end },
      });
    }
  }

  // An event that reappears is no longer missing, whatever the reason was.
  for (const id of Object.keys(state.missing)) {
    if (cur[id]) delete state.missing[id];
  }

  let vanished = Object.keys(prev).filter((id) => !cur[id]);
  let appeared = Object.keys(cur).filter((id) => !prev[id]);

  // Aged out of the back of the window. NOT a change and NOT reported: the
  // event did not move and was not cancelled, our view moved past it. It is
  // also unambiguous — an event genuinely cancelled while still inside the
  // window disappears while its start is still at or after the near edge, so
  // this only ever catches meetings that have already happened, where there is
  // nothing for a consumer to do anyway. Dropped before the partial gate
  // because the window no longer covers them either way; they are never
  // coming back.
  const nearEdge = ms(opts.windowFrom);
  if (nearEdge !== null) {
    const agedOut = vanished.filter((id) => {
      const start = ms(prev[id].start);
      return start !== null && start < nearEdge;
    });
    for (const id of agedOut) {
      delete prev[id];
      delete state.missing[id];
    }
    vanished = vanished.filter((id) => !agedOut.includes(id));
  }

  // 2. A re-timed recurring SERIES changes every instance id at once. This
  // runs BEFORE the partial gate on purpose: a series lives on ONE calendar,
  // so if the replacement instance is visible then that calendar was readable
  // this poll, which makes its predecessor's absence a real observation.
  const pairs = pairSeries(vanished, appeared, prev, cur);
  for (const [oldId, newId] of pairs) {
    const was = prev[oldId];
    const fresh = cur[newId];
    // Same meeting, new id: keep the ORIGINAL sighting, or its reminders would
    // look like something we only just learned about.
    fresh.seenAt = was.seenAt;
    out.push({
      ...base(newId, fresh, at),
      kind: 'time-changed',
      old: { start: was.start, end: was.end },
      new: { start: fresh.start, end: fresh.end },
      prevId: oldId,
      series: fresh.series,
    });
    // Retire the old id NOW. Leaving it in `prev` would make the next poll see
    // it vanish all over again and quarantine it into a phantom cancellation
    // of a meeting we just reported as merely moved.
    delete prev[oldId];
  }
  vanished = vanished.filter((id) => !pairs.has(id));
  const pairedNew = new Set(pairs.values());
  appeared = appeared.filter((id) => !pairedNew.has(id));

  // 3. Somebody invited me. Also trustworthy on a partial fetch: an event that
  // IS in the snapshot is really there.
  const prevEdge = ms(prevWindowTo);
  for (const id of appeared) {
    const rec = cur[id];
    const start = ms(rec.start);
    // The window's far edge rolls forward at local midnight, so everything on
    // the newly visible day is new to the VIEW, not new to the calendar.
    // Announcing those would mean a burst of fake invitations every midnight.
    if (prevEdge !== null && start !== null && start > prevEdge) continue;
    if (!isInvite(rec)) continue;
    out.push({
      ...base(id, rec, at),
      kind: 'new-invite',
      start: rec.start,
      end: rec.end,
      rsvp: rec.rsvp,
      location: rec.location,
      attendees: rec.attendees,
    });
  }

  if (partial) {
    // ABSENCE PROVES NOTHING HERE. Update what we saw, leave what we did not
    // alone, and freeze the quarantine counters so a blip cannot age its way
    // into a cancellation.
    if (vanished.length > 0) {
      out.push({
        kind: 'watch-error',
        at,
        what: 'absence-withheld',
        detail:
          `${vanished.length} event(s) not in this snapshot, but at least one ` +
          'calendar could not be read — withholding judgement (they stay tracked)',
      });
    }
    Object.assign(prev, cur);
    state.windowTo = windowTo;
    return out;
  }

  // 4. Circuit breaker.
  const tracked = Object.keys(prev).length;
  const threshold = Math.max(
    cfg.massVanishMin,
    Math.floor(tracked * cfg.massVanishRatio),
  );
  if (vanished.length > 0 && vanished.length >= threshold) {
    out.push({
      kind: 'watch-error',
      at,
      what: 'mass-vanish',
      detail:
        `${vanished.length} of ${tracked} tracked events vanished in one poll ` +
        `(threshold ${threshold}) — that is a fetch or config problem, not ` +
        `${vanished.length} cancellations. Judging nothing this round.`,
    });
    Object.assign(prev, cur);
    state.windowTo = windowTo;
    return out;
  }

  // 5. Quarantine. An absence must survive N consecutive clean polls before
  // anyone hears the word "cancelled".
  for (const id of vanished) {
    const miss = state.missing[id];
    if (miss) miss.polls += 1;
    else state.missing[id] = { polls: 1, since: now, rec: prev[id] };
  }

  const edge = ms(windowTo);
  for (const [id, miss] of Object.entries(state.missing)) {
    if (miss.polls < cfg.quarantinePolls) continue;
    const rec = miss.rec;
    const start = ms(rec.start);
    const nearEdge =
      edge !== null && start !== null && edge - start <= cfg.edgeDays * 86400000;
    out.push({
      ...base(id, rec, at),
      kind: nearEdge ? 'moved-out-of-window' : 'cancelled',
      was: { start: rec.start, end: rec.end },
      confirmedPolls: miss.polls,
    });
    delete state.missing[id];
    delete prev[id];
  }

  // Events still inside the quarantine window stay in `prev` on purpose: if
  // they come back, the reappearance is a no-op rather than a new invite.
  Object.assign(prev, cur);
  state.windowTo = windowTo;
  return out;
}

// ---------------------------------------------------------------------------
// Timers. These are not diffs — nothing CHANGES at T-minus-N, the clock simply
// arrives. Rebuilt from the current snapshot every poll, so a meeting that
// moves re-arms automatically: the fired key carries the start time, and a new
// start is a key nobody has fired.
// ---------------------------------------------------------------------------

interface Due {
  dueAt: number;
  kind: 'rsvp-due' | 'starting';
  id: string;
  rec: WatchRecord;
}

function dueList(state: WatchState, cfg: WatchConfig, now: number): Due[] {
  const out: Due[] = [];
  for (const [id, rec] of Object.entries(state.events)) {
    if (rec.allDay) continue; // an all-day entry has no meaningful T-minus
    const start = ms(rec.start);
    if (start === null || start <= now) continue;
    if (rec.rsvp === 'needsAction') {
      out.push({ dueAt: start - cfg.rsvpLeadHours * 3600000, kind: 'rsvp-due', id, rec });
    }
    if (rec.meetUrl || rec.attendees.length > 0) {
      out.push({ dueAt: start - cfg.prepLeadMinutes * 60000, kind: 'starting', id, rec });
    }
  }
  return out.sort((a, b) => a.dueAt - b.dueAt);
}

/** Fire whatever came due.
 *
 * `armOnly` marks everything already due as sent WITHOUT sending it — used
 * when seeding, for the same reason seeding does not replay history: on fresh
 * state every meeting in the next day is already "overdue" for its RSVP
 * reminder, and none of that is news.
 *
 * NOTHING IS EVER WITHHELD FOR BEING LATE. An earlier design suppressed a
 * reminder whose due time was long past, reasoning that a stale heads-up is a
 * false statement about how much time is left. It is not: every event reports
 * the remaining time measured at send, so it is true whenever it goes out —
 * and the suppression silently killed the single most useful case, an invite
 * that ARRIVES less than the lead time before the meeting (its RSVP reminder
 * is "due" 23 hours before we ever saw it). Lateness is measured from the
 * moment we could first have sent it — max(due, first seen) — and reported
 * alongside the reminder instead of replacing it.
 */
export function runTimers(
  state: WatchState,
  cfg: WatchConfig,
  now: number,
  armOnly = false,
): { events: WatchEvent[]; nextDue: number | null } {
  const at = new Date(now).toISOString();
  const out: WatchEvent[] = [];
  let nextDue: number | null = null;

  for (const due of dueList(state, cfg, now)) {
    const key = `${due.kind}|${due.id}|${due.rec.start}`;
    if (state.fired[key] !== undefined) continue;
    if (due.dueAt > now) {
      nextDue = nextDue === null ? due.dueAt : Math.min(nextDue, due.dueAt);
      continue;
    }
    state.fired[key] = now;
    if (armOnly) continue;

    // Could we actually have sent this earlier? Only if we already knew the
    // event existed.
    const sendableFrom = Math.max(due.dueAt, due.rec.seenAt);
    let lateMin = Math.floor((now - sendableFrom) / 60000);
    if (lateMin < cfg.lateNoticeMinutes) lateMin = 0;
    const start = ms(due.rec.start) ?? now;
    out.push({
      ...base(due.id, due.rec, at),
      kind: due.kind,
      start: due.rec.start,
      end: due.rec.end,
      minutesUntilStart: Math.floor((start - now) / 60000),
      reminderLateMinutes: lateMin,
      rsvp: due.rec.rsvp,
      location: due.rec.location,
      attendees: due.rec.attendees,
    });
  }

  // Forget keys for meetings two days past, or the state grows without bound.
  for (const key of Object.keys(state.fired)) {
    const start = ms(key.slice(key.lastIndexOf('|') + 1));
    if (start !== null && start <= now - 2 * 86400000) delete state.fired[key];
  }
  return { events: out, nextDue };
}

/** One human-readable line per event, for `ycal watch --format text`. */
export function renderWatchEvent(ev: WatchEvent): string {
  const time = (iso: string): string => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime())
      ? iso
      : d.toLocaleString(undefined, {
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        });
  };
  const slot = (s: string, e: string): string => `${time(s)} to ${time(e)}`;
  const who = (list: WatchAttendee[]): string => {
    const names = list.filter((a) => !a.self).map((a) => a.name || a.email);
    if (names.length === 0) return '(no attendee list)';
    return names.length > 6
      ? `${names.slice(0, 6).join(', ')} +${names.length - 6} more`
      : names.join(', ');
  };
  const late = (n: number): string => (n ? ` [reminder ${n}m late]` : '');
  switch (ev.kind) {
    case 'watch-armed':
      return `watch-armed | tracking ${ev.tracked} event(s) through ${ev.windowTo}, polling every ${ev.pollSeconds}s | seeded silently: changes before now were not replayed`;
    case 'watch-error':
      return `watch-error [${ev.what}] ${ev.detail}`;
    case 'time-changed':
      return `time-changed ${ev.id} | ${ev.title} | ${slot(ev.old.start, ev.old.end)} -> ${slot(ev.new.start, ev.new.end)}${ev.prevId ? ' (series re-timed)' : ''}`;
    case 'new-invite':
      return `new-invite ${ev.id} | ${ev.title} | ${slot(ev.start, ev.end)} | ${who(ev.attendees)}`;
    case 'cancelled':
      return `cancelled ${ev.id} | ${ev.title} | was ${slot(ev.was.start, ev.was.end)}, gone for ${ev.confirmedPolls} consecutive clean polls`;
    case 'moved-out-of-window':
      return `moved-out-of-window ${ev.id} | ${ev.title} | was ${slot(ev.was.start, ev.was.end)}, left the watched window — NOT confirmed cancelled`;
    case 'rsvp-due':
      return `rsvp-due ${ev.id} | ${ev.title} | starts in ${Math.max(1, Math.round(ev.minutesUntilStart / 60))}h and the RSVP is still needsAction | ${who(ev.attendees)}${late(ev.reminderLateMinutes)}`;
    case 'starting':
      return `starting ${ev.id} | ${ev.title} | starts in ${ev.minutesUntilStart}m | ${ev.meetUrl ?? ev.location ?? 'no link'}${late(ev.reminderLateMinutes)}`;
    default:
      return JSON.stringify(ev);
  }
}
