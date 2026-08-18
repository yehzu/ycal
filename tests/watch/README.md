# Watch replay cases

Golden-file tests for `ycal watch`'s change detection. No test framework: each
case is a `.jsonl` of recorded calendar snapshots and a `.expected` of the
events they must produce.

```bash
npm run test:watch          # run every case
npm run test:watch -- bless # rewrite .expected from current behaviour
```

Each `.jsonl` line is one document in the shape `ycal events --format json`
emits, plus a `"now"` (ISO) that drives the clock for that step. The first line
seeds; seeding is silent by design, so it only ever produces `watch-armed`.
Output is compared as JSON, not text, because the human rendering goes through
`toLocaleString` and would differ by machine locale and timezone.

**These cases are the reason the detection logic can be changed safely.** Every
one of them encodes a way to report a cancellation that never happened —
Google's list omits cancelled events rather than flagging them, so an absence
is all you ever get, and a rate-limited calendar, a hidden calendar, a re-timed
recurring series and the window rolling forward are all indistinguishable from
one at first glance. If a case starts failing, the question is not "update the
expectation" but "which of those did we just start getting wrong".

Before blessing a change, read the diff: an event kind flipping from
`moved-out-of-window` to `cancelled`, or a `watch-error` disappearing, is a
regression wearing the costume of a passing test.
