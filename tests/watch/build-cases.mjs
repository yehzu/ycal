// Regenerates the .jsonl snapshot fixtures in this directory.
//
// The fixtures are checked in — this script exists so a new case is written as
// readable intent rather than hand-edited JSON, and so every case shares one
// definition of "an ordinary event".
//
//   node tests/watch/build-cases.mjs
//
// It does NOT touch the .expected files. Those are the assertions; see
// `npm run test:watch`.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const WINDOW_TO = '2026-09-01T00:00:00.000Z';

const ev = (id, title, start, end, extra = {}) => ({
  id,
  title,
  start,
  end,
  allDay: false,
  duration_minutes: 60,
  location: null,
  description: null,
  rsvp: 'accepted',
  status: 'confirmed',
  eventType: 'default',
  calendar: { id: 'c1', name: 'Work', account: 'me@x.com', primary: true },
  url: `https://cal/${id}`,
  attendees: [],
  ...extra,
});

const me = (over = {}) => ({
  email: 'me@x.com', name: 'Me', rsvp: 'needsAction',
  organizer: false, self: true, optional: false, resource: false, ...over,
});
const her = (over = {}) => ({
  email: 'her@x.com', name: 'Her', rsvp: 'accepted',
  organizer: true, self: false, optional: false, resource: false, ...over,
});
const room = () => ({
  email: 'room@resource.calendar.google.com', name: '13F Chromebox',
  rsvp: 'accepted', organizer: false, self: false, optional: false,
  resource: true,
});

/** Somebody invited me: I am an attendee and NOT the organizer. */
const invited = (id, title, start, end, extra = {}) =>
  ev(id, title, start, end, { rsvp: 'needsAction', attendees: [me(), her()], ...extra });

/** I created it, with a guest. Nobody invited me to my own meeting. */
const mine = (id, title, start, end, extra = {}) =>
  ev(id, title, start, end, {
    rsvp: 'accepted',
    attendees: [me({ organizer: true, rsvp: 'accepted' }), her({ organizer: false })],
    ...extra,
  });

const snap = (now, events, opts = {}) => ({
  now,
  params: { from: '2026-08-17T16:00:00.000Z', to: opts.windowTo ?? WINDOW_TO },
  count: events.length,
  partial: !!opts.partial,
  failures: opts.partial
    ? [{ account: 'me@x.com', calendar: 'Work', message: 'Rate Limit Exceeded', transient: true, needsReauth: false }]
    : [],
  events,
});

const write = (name, lines) => {
  writeFileSync(join(here, `${name}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  console.log(`${name}.jsonl  (${lines.length} snapshots)`);
};

// --- the shared cast -------------------------------------------------------
const A = ev('a', 'Weekly', '2026-08-20T06:00:00Z', '2026-08-20T07:00:00Z');
const A_MOVED = { ...A, start: '2026-08-20T08:00:00Z', end: '2026-08-20T09:00:00Z' };
const B = ev('b', '1:1', '2026-08-21T02:00:00Z', '2026-08-21T02:30:00Z');
const WL = ev('w', 'Office', '2026-08-20T00:00:00Z', '2026-08-21T00:00:00Z', {
  eventType: 'workingLocation', allDay: true,
});
const t = (mins) => new Date(Date.parse('2026-08-18T10:00:00Z') + mins * 60000).toISOString();

// 1. Seeding records the world; it does not announce it. Working locations are
//    not meetings and are never tracked.
write('seed-is-silent', [
  snap(t(0), [A, B, WL]),
  snap(t(1), [A, B, WL]),
]);

// 2. A reschedule of an event present in both snapshots. Both times must
//    survive: a consumer has to find the deadline it wrote and replace it.
write('time-changed', [
  snap(t(0), [A, B]),
  snap(t(1), [A_MOVED, B]),
]);

// 3. An absence must survive consecutive clean polls, must not repeat, and a
//    reappearance inside the quarantine is a non-event.
write('cancelled-after-quarantine', [
  snap(t(0), [A, B]),
  snap(t(1), [A]),
  snap(t(2), [A]),
  snap(t(3), [A]),
]);
write('reappears-inside-quarantine', [
  snap(t(0), [A, B]),
  snap(t(1), [A]),
  snap(t(2), [A, B]),
  snap(t(3), [A, B]),
]);

// 4. A rate-limited calendar hides events; it does not cancel them. Once it
//    comes back, the absence is judged normally.
write('partial-fetch-withholds', [
  snap(t(0), [A, B]),
  snap(t(1), [A], { partial: true }),
  snap(t(2), [A], { partial: true }),
  snap(t(3), [A], { partial: true }),
  snap(t(4), [A]),
  snap(t(5), [A]),
]);

// 5. Ten events cannot be cancelled between two polls. Something broke.
const many = Array.from({ length: 10 }, (_, i) =>
  ev(`e${i}`, `E${i}`, `2026-08-2${i % 10}T06:00:00Z`, `2026-08-2${i % 10}T07:00:00Z`));
write('mass-vanish-breaker', [
  snap(t(0), many),
  snap(t(1), []),
  snap(t(2), []),
  snap(t(3), []),
]);

// 6. Re-time a recurring SERIES and every instance id changes at once, because
//    the id embeds the instance's ORIGINAL start.
const OLD_ID = 's1_20260820T060000Z';
const NEW_ID = 's1_20260820T080000Z';
write('series-retime-is-one-change', [
  snap(t(0), [invited(OLD_ID, '1:1', '2026-08-20T06:00:00Z', '2026-08-20T07:00:00Z', { recurringEventId: 's1' })]),
  snap(t(1), [invited(NEW_ID, '1:1', '2026-08-20T08:00:00Z', '2026-08-20T09:00:00Z', { recurringEventId: 's1' })]),
  snap(t(2), [invited(NEW_ID, '1:1', '2026-08-20T08:00:00Z', '2026-08-20T09:00:00Z', { recurringEventId: 's1' })]),
  snap(t(3), [invited(NEW_ID, '1:1', '2026-08-20T08:00:00Z', '2026-08-20T09:00:00Z', { recurringEventId: 's1' })]),
]);

// 7. Pushed past the far edge of the window: still on the calendar, out of view.
const FAR = ev('z', 'Far', '2026-08-31T06:00:00Z', '2026-08-31T07:00:00Z');
write('far-edge-is-a-move', [
  snap(t(0), [A, FAR]),
  snap(t(1), [A]),
  snap(t(2), [A]),
]);

// 8. An invitation is announced with what a todo needs; my own event is not an
//    invitation; a meeting room is not a person.
write('new-invite', [
  snap(t(0), [A]),
  snap(t(1), [A, invited('i1', 'Review', '2026-08-22T06:00:00Z', '2026-08-22T07:00:00Z', {
    meetUrl: 'meet.google.com/abc-defg', location: 'Room 4',
    attendees: [me(), her(), room()],
  })]),
  snap(t(2), [A, mine('m1', 'Focus', '2026-08-22T09:00:00Z', '2026-08-22T10:00:00Z')]),
]);

// 9. The window's far edge advances every local midnight. Everything on the
//    newly visible day is new to the VIEW, not to the calendar.
write('window-roll-is-not-an-invite', [
  snap(t(0), [A], { windowTo: '2026-08-21T00:00:00.000Z' }),
  snap(t(1), [A, invited('far', 'Next week', '2026-09-03T06:00:00Z', '2026-09-03T07:00:00Z')],
    { windowTo: '2026-09-08T00:00:00.000Z' }),
]);

// 9b. The window's NEAR edge rolls forward every midnight too, and everything
//     on the day that drops off the back vanishes from the snapshot at once.
//     That is not a cancellation — nothing about those meetings changed, our
//     view moved past them — and reporting it would mean a batch of phantom
//     cancellations every single night.
//
//     The second half of this case is what makes it worth having: a FUTURE
//     event is deleted in the same roll and must STILL be reported. Without
//     it, muting the whole quarantine would pass.
const yest = (n) => ev(`y${n}`, `Yesterday ${n}`, `2026-08-17T0${n}:00:00Z`, `2026-08-17T0${n}:30:00Z`);
const soonEv = (n) => ev(`s${n}`, `Later ${n}`, `2026-08-2${n}T06:00:00Z`, `2026-08-2${n}T07:00:00Z`);
const rolled = (now, events) => ({
  now,
  // Both edges one day further on than WINDOW_FROM/WINDOW_TO below.
  params: { from: '2026-08-17T16:00:00.000Z', to: '2026-09-02T15:59:59.999Z' },
  count: events.length,
  partial: false,
  failures: [],
  events,
});
write('near-edge-ages-out-silently', [
  {
    now: '2026-08-17T20:00:00Z',
    params: { from: '2026-08-16T16:00:00.000Z', to: '2026-09-01T15:59:59.999Z' },
    count: 5, partial: false, failures: [],
    events: [yest(1), yest(2), yest(3), soonEv(1), soonEv(2)],
  },
  // Midnight: the three 08-17 events fall off the back, and someone also
  // deletes a future one.
  rolled('2026-08-18T00:01:00Z', [soonEv(1)]),
  rolled('2026-08-18T00:02:00Z', [soonEv(1)]),
  rolled('2026-08-18T00:03:00Z', [soonEv(1)]),
]);

// 10. Timers. Nothing changes at T-minus-N; the clock simply arrives.
const SOON = '2026-08-18T10:20:00Z';        // 20 min after t(0)
const meeting = mine('t1', 'Sync', SOON, '2026-08-18T11:20:00Z', {
  meetUrl: 'meet.google.com/abc-defg',
});
write('timer-starting', [
  snap(t(0), [A]),
  snap(t(1), [A, meeting]),               // 19 min out: not due yet
  snap(t(11), [A, meeting]),              // 9 min out: fires
  snap(t(12), [A, meeting]),              // does not repeat
]);
// A meeting that moves re-arms its reminder: the fired key carries the start.
const meetingMoved = { ...meeting, start: '2026-08-18T10:30:00Z' };
write('timer-rearms-after-move', [
  snap(t(0), [meeting]),
  snap(t(11), [meeting]),                 // fires at 9 min out
  snap(t(12), [meetingMoved]),            // moved to 18 min out
  snap(t(21), [meetingMoved]),            // fires again for the new time
]);
// Seeding arms the timers without firing them: on fresh state every meeting in
// the next day is already "overdue" for its RSVP reminder, and none of it is news.
write('timer-armed-at-seed', [
  snap(t(0), [meeting, invited('r1', 'Decide', '2026-08-18T11:00:00Z', '2026-08-18T12:00:00Z')]),
  snap(t(11), [meeting, invited('r1', 'Decide', '2026-08-18T11:00:00Z', '2026-08-18T12:00:00Z')]),
]);
// An invite that ARRIVES inside its own lead window is still nagged: its 24h
// RSVP reminder is nominally 23h overdue, but nothing was missed — we had never
// seen the event. reminderLateMinutes must be 0.
write('timer-late-arriving-invite', [
  snap(t(0), [A]),
  snap(t(1), [A, invited('r2', 'Decide', '2026-08-18T12:00:00Z', '2026-08-18T13:00:00Z')]),
  snap(t(2), [A, invited('r2', 'Decide', '2026-08-18T12:00:00Z', '2026-08-18T13:00:00Z')]),
]);
// Answering the invite stops the nag. These two cases are a matched pair and
// only mean something together: the meeting is 26h out at seed, so its 24h
// reminder is still 2h in the future and nothing is armed away. The clock then
// advances past the reminder time. The ONLY difference between the two files
// is the RSVP — so `timer-nag-fires` is what proves `timer-answered-...` is
// silent because the answer landed, not because the reminder was never due.
const decide = (rsvp) =>
  ({ ...invited('r3', 'Decide', '2026-08-19T12:00:00Z', '2026-08-19T13:00:00Z'), rsvp });
write('timer-nag-fires', [
  snap(t(0), [A, decide('needsAction')]),
  snap(t(121), [A, decide('needsAction')]),
  snap(t(122), [A, decide('needsAction')]),
]);
write('timer-answered-invite-is-not-nagged', [
  snap(t(0), [A, decide('needsAction')]),
  snap(t(121), [A, decide('accepted')]),
  snap(t(122), [A, decide('accepted')]),
]);
