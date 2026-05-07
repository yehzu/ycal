# yCal — Claude working notes

Personal Electron app for the repo owner (a busy EM, not a primary code author). Reads Google Calendar, renders an editorial-styled month/week/day view, plus an LLM-friendly CLI. Optimize for: small reversible changes, clear release flow, never break the auth/encryption story.

User-facing docs live in `README.md`. This file is for fast onboarding when Claude is invoked into the repo.

## Stack at a glance

- **Electron 33** (main + preload + renderer separation enforced)
- **electron-vite + Vite 5 + React 18 + TypeScript**
- **googleapis** for Calendar v3 — read-only OAuth scopes
- **GitHub releases** for auto-update (custom, no electron-updater — see "Auto-update" below)
- **No tests, no lint config.** "Verified" means typecheck clean + build clean + smoke-tested manually. Don't introduce a test framework without asking.

## Layout

```
src/
├── main/         Electron main process (Node)
│   ├── index.ts          Entry point, window creation, IPC registration, --cli dispatch
│   ├── auth.ts           OAuth loopback flow (port 0, ephemeral)
│   ├── tokenStore.ts     safeStorage-backed accounts.json (Keychain on macOS)
│   ├── config.ts         Loads oauth-client.json from userData
│   ├── calendar.ts       Google Calendar API client + event shaping
│   ├── settings.ts       UI settings + weather URL + active task provider id (cloud-routed)
│   ├── device.ts         Per-device prefs (cloudStorage pref only — userData)
│   ├── weather.ts        iCal-format weather feed parser + cache
│   ├── updater.ts        Custom GitHub-releases auto-updater (handles unsigned builds)
│   ├── cloudStore.ts     iCloud-Drive-or-local file router (JSON + text)
│   ├── rhythm.ts         Wake/sleep defaults (time-versioned) + per-day overrides
│   ├── tasksStore.ts     Local task overlay (schedule + done) backed by cloudStore
│   ├── taskProviders/    Pluggable task backends
│   │   ├── types.ts        TaskProvider interface
│   │   ├── labels.ts       Troika label parser (duration / energy / location)
│   │   ├── todoist.ts      Todoist /api/v1 client
│   │   ├── markdownDoc.ts  Markdown task parser + serializer + targeted edits
│   │   ├── markdown.ts     Markdown-file-backed provider (cloudStore-routed tasks.md)
│   │   └── index.ts        Registry — drop new providers here
│   ├── cli.ts            Argv-driven CLI (LLM-friendly, JSON/text/markdown)
│   └── cliServer.ts      Unix socket server bridging external clients to runCli
├── preload/      contextBridge → window.ycal; the only renderer↔main surface
├── renderer/     React UI; styled in src/renderer/src/styles.css
│   └── src/
│       ├── App.tsx              Main shell, wires all stores + panels
│       ├── store.ts             Calendar events + accounts + weather hook
│       ├── tasks.ts             Tasks store hook (provider-agnostic)
│       ├── rhythm.ts            Pure helpers — resolveRhythm / formatRhythmTime
│       ├── dayLoad.ts           Pure helper — computeDayLoad (free / energy / intensity)
│       ├── dragController.tsx   Pointer + HTML5 hybrid drag controller
│       └── components/
│           ├── TimeView.tsx       Week/Day grid, task chips, rhythm lines, drops
│           ├── TasksPanel.tsx     Right rail + TaskCard + edge tab
│           ├── TaskSheet.tsx      Slide-in detail (description + comments)
│           ├── EventPopover.tsx   Event detail popover (Meet link + attendees)
│           ├── PopoverAttendees.tsx  Sorted guest list for the popover
│           ├── DayLoad.tsx        DayLoadGauge / Readout / Summary (capacity bar)
│           └── SettingsModal.tsx  Tabs: General/Tasks/Day rhythm/Sync/…
└── shared/       Cross-process types and pure helpers
    ├── types.ts        IPC contract — change carefully
    └── dedup.ts        Cross-calendar duplicate collapsing (used by both)
bin/ycal         Plain-Node CLI client (no Electron import — talks to socket)
```

## Architectural invariants — don't break these

1. **Renderer never sees Google or Todoist credentials or makes network calls.** All third-party API traffic happens in main. Renderer talks to main only via `IPC` channels declared in `@shared/types`. CSP in `index.html` blocks arbitrary network access.
2. **All credentials are encrypted at rest.** Google refresh tokens go through `tokenStore.ts`; the Todoist API key goes through `taskProviders/todoist.ts` (`todoist.key`). Both use `safeStorage` (macOS Keychain). Never write a plaintext token. `safeStorage` requires Electron runtime — that's why the CLI server lives inside the GUI process.
3. **OAuth scopes are read-only.** Adding write functionality requires dropping `.readonly` from `src/main/auth.ts` *and* re-consenting users. Don't broaden silently.
4. **`@shared/types.ts` is the IPC contract.** Adding/removing fields ripples through main, preload, renderer. CLI socket protocol is a separate contract; see below.
5. **`app.name` resolves to `"ycal"` (lowercase, from package.json `name`).** That's the userData dir name on disk: `~/Library/Application Support/ycal/`. The `productName` `"yCal"` only affects the .app bundle name. Don't call `app.setName('yCal')` — it would orphan existing users' tokens.
6. **Tasks is a pluggable provider, not a Todoist integration.** The renderer talks to `getActiveProvider()` via IPC (`tasksList`, `tasksClose`, `tasksAddComment`, …). Adding a new backend means dropping a file in `src/main/taskProviders/` that implements the `TaskProvider` interface and registering it in `taskProviders/index.ts`. The renderer is provider-agnostic.
7. **Task scheduling stays local-cloud — never round-trip to the upstream provider.** When a user drags a task onto a calendar slot, we record it in `tasks-schedule.json` (cloudStore-routed). We do NOT call Todoist's `update task due date`. Only completion (`closeTask`/`reopenTask`) and comments push upstream.
8. **`cloudStore.ts` is the only thing that knows about iCloud Drive.** Anything that wants iCloud-or-local routing should go through `readJson` / `writeJson` (or `readText` / `writeText`) and register its filename in `CLOUD_FILES` so the toggle in Settings → Sync moves it correctly. Today the routed files are `rhythm.json`, `tasks-schedule.json`, `settings.json`, and `tasks.md`.
9. **The cross-device sync model is "iCloud-Drive routing for files; safeStorage credentials stay local."** All UI prefs + the day rhythm + the task schedule + the markdown task store follow the user across Macs through cloudStore. OAuth refresh tokens (`accounts.json`) and the Todoist API key (`todoist.key`) cannot — `safeStorage` keys are per-device. Each new Mac re-signs once. The `cloudStorage` pref ITSELF lives in `device.json` (userData, never synced) so we can read settings.json from the right location without circular bootstrapping. `cloudStore.migrateMissingToCloud()` runs at startup to handle the upgrade case where new files joined `CLOUD_FILES` after the user already toggled iCloud on.

   **Drive sync is the cross-platform layer** (added 2026-05-07 for iPhone parity). `src/main/driveSync.ts` mirrors every CLOUD_FILES entry through the user's Google Drive `appdata` folder, using the `https://www.googleapis.com/auth/drive.appdata` scope (added to `auth.ts` SCOPES). Layered ON TOP of cloudStore: files still live on disk per the cloudStorage pref; Drive sync shadows them via the same per-app project iOS uses. Per-device prefs (`driveSyncEnabled`, `driveSyncAccountId`) live in `device.json`. The orchestrator debounces local writes (1.5s) before pushing, polls every 5 minutes for remote pulls, and uses a per-filename `lastSeen` map to break the watcher → push → pull echo loop. Manual PUSH NOW / PULL NOW lives in Settings → Sync. Existing OAuth tokens predate the `drive.appdata` scope — users must remove + re-add a Google account once for sync to engage.
10. **Live-sync (no app restart needed) is the watcher's job.** `cloudStore.startCloudWatcher()` polls every CLOUD_FILES entry every 1.5s via `fs.watchFile` (poll-based, deliberate — `fs.watch`/FSEvents is unreliable for iCloud Drive's sync-down replacements). When a file's body differs from the per-filename `lastSeen` map (maintained on every read AND every write), the watcher pushes the relevant slice to the renderer over IPC: `SettingsChanged`, `RhythmChanged`, `TasksLocalChanged`, `TasksProviderDataChanged`. The renderer applies idempotently. Loop prevention: cloudStore's `writeJson`/`writeText` short-circuit when the new body equals `lastSeen`, so a renderer that auto-saves after applying a remote update produces no disk write — the round-trip ends at the dedupe gate. `tasksStore.setTasksLocal` ALSO dedupes ignoring `cacheAt` so the per-Mac 5-min Todoist poll doesn't churn the schedule file just to bump a timestamp.

## Common commands

```bash
npm run dev              # hot-reload dev (opens GUI window)
npm run build            # type-check + bundle to ./out  ← run this before commit
npm run typecheck        # tsc --noEmit on both projects (fast feedback loop)
npm run typecheck:node   # main/preload/shared only
npm run typecheck:web    # renderer only
npm run package          # build ./release/mac-arm64/yCal.app (no signing)
npm run dist             # build signed dmg + zip (needs codesign setup)

# Run the in-process CLI from a built tree:
./node_modules/.bin/electron . --cli accounts
./node_modules/.bin/electron . --cli today --format markdown

# The standalone Node client (talks to socket; no Electron flash):
./bin/ycal today
```

**The validation loop is `npm run typecheck && npm run build`.** No test runner, no linter — keep changes small enough to verify by reading and by running the result.

## CLI architecture (the recently-added bit)

Two execution modes share `runCli()` from `src/main/cli.ts`:

| Mode | Trigger | When to use | Cost |
| --- | --- | --- | --- |
| **Socket** (default) | `bin/ycal <args>` (plain Node) | Every interactive call. GUI auto-launches if not running. | ~50ms + Google API time. No dock flash. |
| **In-process** | `yCal --cli <args>` (Electron) | CI / headless / fallback | Bounces Electron, dock icon flashes briefly. |

**Wire protocol on the socket** (`<userData>/cli.sock`, mode 0600):
- Client → server: `{"args": ["today", "--format", "markdown"]}` then half-close write side
- Server → client: `{"stdout": "...", "stderr": "...", "code": 0}`

**Two non-obvious gotchas live here:**

1. **`net.createServer({ allowHalfOpen: true }, ...)` is required.** Default is `false`, which auto-FINs the server's writable side as soon as the client half-closes — racing the async `runCli` and dropping responses on the floor. Symptom: client connects, gets `end` and `close` with zero `data` events.
2. **Connect and read timeouts must be split.** A unified 2s budget worked for `--version` (instant) but cut off `today`/`events` mid-Google-API-call. Current split: 1s connect, 30s read.

`runCli(argv, out, err)` writes to injected `Writable` streams — don't go back to `process.stdout.write`. The same function serves stdio (in-process mode) and `StringSink` buffers (socket mode), and the server can serve concurrent connections safely.

**CLI mirrors GUI filtering by default.** `src/main/cli.ts` reads `settings.json` UI prefs (`accountsActive`, `calVisible`, `calRoles`) and applies them like the renderer's agenda would: only active accounts × visible calendars × `normal`-role calendars. Opt-in flags widen the set: `--include-read-only` (subscribed), `--include-holidays`, `--all-calendars` (full bypass). `--calendar <id>` always wins. Calendar-set filtering is account-scoped (pair-based) so a shared calendar visible on account A but hidden on account B fetches only the A copy.

## Caching layers in main

Two TTL'd caches live in `src/main/calendar.ts`:

- `CALENDAR_CACHE_TTL_MS` (5 min) — `listAllCalendars()` result. Calendar lists rarely change; this kills the dominant per-call cost when the user has multiple accounts. Per-account fetch is parallelised.
- `EVENTS_CACHE_TTL_MS` (30 s) — `listEvents()` keyed by `(timeMin|timeMax|sorted account|cal pairs)`. Lets back-to-back CLI calls and same-window UI re-renders skip Google.

Both expose `invalidateCalendarCache()` / `invalidateEventsCache()` and are busted on AddAccount / RemoveAccount. `ListEventsRequest.force` lets the renderer's auto-refresh skip the events cache while still re-warming it.

## Renderer auto-refresh

`useStore.refreshEvents()` re-fetches the held range with `force: true` (busts both renderer-side `fetchedRangeRef` and main-side events cache). `App.tsx` wires three triggers, all gated by a 30 s timestamp throttle:

- `window` `focus` — switch back to yCal after editing in Google Calendar.
- `document` `visibilitychange` (visible) — covers macOS Spaces / minimised window cases that don't always fire `focus`.
- 5-minute `setInterval` — slow poll for users who leave yCal in the foreground all day.

An `inFlightRef` guard inside `useStore` blocks overlapping fetches if multiple triggers fire close together despite the throttle.

## Where to put new code

- **Shared by main and renderer (types, pure helpers)** → `src/shared/`. Both ts-projects alias `@shared/*` here.
- **Renderer-only (React component, hook, dates helper)** → `src/renderer/src/`. Aliased as `@renderer/*` in renderer-only.
- **Main-only (Google API, IPC handler, OS integration)** → `src/main/`. Register IPC channel name in `@shared/types#IPC` first.
- **CLI subcommand** → add a `cmdFoo(args, io)` to `src/main/cli.ts`, wire into `runCli`'s switch, document in the `helpText` string and in `README.md`.

## Release flow

Encapsulated in `scripts/release.sh` (run via `npm run release`). Pre-conditions: `package.json` `version` is bumped, the bump commit is HEAD, working tree is clean.

```bash
# 1. Bump version + commit
#    (use the Bump format the project's commits follow):
#      Bump X.Y.Z: <one-line summary>
#
#      <multi-line reasoning>

# 2. Ship it
npm run release
```

`scripts/release.sh` then: typechecks + builds → tags `vX.Y.Z` if not present → pushes `main` and the tag → `npm run dist -- --publish always` (uploads dmg + zip to a draft GitHub release using `gh auth token` for `GH_TOKEN`) → `gh release edit vX.Y.Z --draft=false` to promote the draft to live. Existing installs auto-update within minutes via the in-app updater (poll on launch / focus / every 30 min).

## Auto-update — why we rolled our own (and the gotchas)

This app is **not** signed with an Apple Developer ID, so `electron-updater`'s normal swap-and-relaunch dies the moment Gatekeeper inspects the new bundle. We replaced it with a custom flow in `src/main/updater.ts`:

1. Poll `https://api.github.com/repos/yehzu/ycal/releases/latest` (no auth — well under the 60-rps anonymous rate limit at our cadence).
2. Pick the arch-matched zip asset (`yCal-X.Y.Z-arm64-mac.zip` on Apple Silicon, `yCal-X.Y.Z-mac.zip` on Intel — `.blockmap` files share the prefix and must be skipped).
3. **Pre-fetch the zip in the background** as soon as the version is detected, into `<userData>/update-cache/yCal-<version>.zip`, broadcasting progress as `state: 'available'` with a `progress` field. When the file lands, transition to `state: 'ready'` so the toast can read "Update ready" and the user's eventual click is essentially free. The cache holds at most one zip — `pruneCache(keepVersion)` runs on every successful check.
4. Download via Node `https` (which doesn't add `com.apple.quarantine`, unlike Safari/Chrome).
5. When the user clicks Install, `performInstall` awaits any in-flight prefetch (its progress callback re-routes from 'available' → 'installing' so the splash shows real bytes-on-the-wire instead of a frozen 0%), then skips the download entirely if the cached zip is intact. Falls back to a foreground download if the cache is missing or the prefetch errored.
6. Extract with `/usr/bin/ditto` — the same tool electron-builder uses on the producing side; preserves resource forks and xattrs better than `unzip`.
7. Write a detached bash helper script and `app.quit()`. The helper waits for the old process to exit, **moves the running bundle aside (not delete-first)**, moves the new bundle into place, runs `xattr -cr` to strip Gatekeeper attrs, sanity-checks the executable, then `lsregister -f`s the path and `open -n`s it (with retries). On any failure path it restores the aside-bundle so the user is never appless.

**Why `lsregister -f` + `open -n` instead of plain `open`:** after we replace the bundle on disk, LaunchServices can hold a stale entry pointing at the (just-deleted) inode, which makes the subsequent `open` resolve to nothing and the relaunch silently fail. Re-registering the path forces LSi to pick up the new Info.plist; `-n` then forces a fresh instance instead of reusing the (no-longer-valid) record.

**The swap helper logs to `~/Library/Logs/yCal/swap.log`** in addition to the temp dir. The temp dir gets `rm -rf`'d ten seconds after the script finishes, so without the persistent copy a failed relaunch leaves no trace. If the user reports "didn't relaunch", check that file first.

**Don't try to make electron-updater work for unsigned builds again.** That was the bug we're working around: Gatekeeper requires either notarisation OR a missing quarantine bit, and electron-updater can't help with either. The bundle path is found via `process.execPath` so this works regardless of whether yCal lives in `/Applications`, `~/Applications`, or a custom location.

**Renderer contract is unchanged.** `UpdateOverlay.tsx` and `SettingsModal.tsx`'s update card still drive the lifecycle through the existing `UpdateStatus` IPC stream + `installUpdate()` channel — only the main-side mechanics changed.

**`bin/ycal` is not in the dmg.** It's a checkout-only script. If a fix lives in `bin/ycal`, users with `~/.local/bin/ycal` already symlinked or copied need to re-copy. A version bump still helps signal that.

## User preferences (from session memory)

- **Match the user's input language.** Chinese in → Chinese out, English in → English out.
- **Direct, concise.** Lead with the answer; expand only on follow-up.
- **Frame technical decisions in business terms** when they affect users / release scope.
- **Auto mode is the norm.** Don't ask before reading, building, committing, pushing to main, tagging, or publishing a release — those are all pre-authorized in `.claude/settings.json` for this repo. Solo personal project; the user wants velocity over ceremony.
- **The full release flow is one autonomous block.** When the user says "ship X.Y.Z" or "release", the expected sequence is: bump → typecheck+build → commit → push main → tag → push tag → `npm run dist -- --publish always` → `gh release edit vX.Y.Z --draft=false`. No checkpoints.
- **Force-push, hard reset, rm -rf, killing processes — still denied.** Those are how you lose work, and irreversible. Stop and ask.

## Tasks subsystem — quick mental model

The Tasks rail in Week + Day views is glued together by three files:

- `src/main/taskProviders/<provider>.ts` — talks to the upstream backend (today: Todoist `/api/v1`). Implements the `TaskProvider` interface. Only the active provider runs.
- `src/main/tasksStore.ts` — local schedule + done overlay, cloudStore-backed. Lives in iCloud Drive when preferred and available; falls back to userData. Migrates from a legacy `tasks` block in `settings.json` once.
- `src/renderer/src/tasks.ts` — the `useTasks` hook. Hydrates tasks with the local overlay, computes `carryoverIds` (scheduled-in-the-past + not-done), surfaces `inboxTasks` and `scheduledById` for the calendar.

**Tasks panel layout (top → bottom):** `TasksPanel.tsx` splits the inbox into three buckets — `Today` (anything firing today: scheduled-today, due-today, or a recurring task whose cadence hits today), the regular project sections, and a collapsed `Routines` fold at the bottom for every recurring task that *isn't* firing today. The fold uses `task.isRecurring` (from Todoist's `due.is_recurring`) rather than the parsed `recur.dow`, so cadences like "every 3 days" don't leak into the project sections — only weekday-shaped recurrences populate `recur.dow`. Each card shows a colored priority pip for Todoist priority 2/3/4 (P3/P2/P1); priority 1 = default = no flag.

**Auto-rollover** is gated by the `autoRolloverPastTasks` UI setting (default on). When on, `useTasks` runs an idempotent sweep: any past-dated scheduled entry whose task isn't done has its slot cleared via `persistLocal`, so the chip vanishes from the calendar grid and the task surfaces as a regular inbox row. When off, the schedule entry stays parked on its original day and `carryoverIds` flags it in the inbox with a soft "↻" hint. Either way the panel shows the task — the toggle just decides whether the calendar chip lingers.

**Troika labels.** `parseTaskMeta` in `taskProviders/labels.ts` reads provider labels (and a few legacy inline tags in titles) and pulls out:
- duration: `30m` / `1h` / `1h30m` / `2h`
- energy: `low` / `mid` / `high` (optional `-energy` suffix)
- location: anything else, first wins

Pure-numeric labels are explicitly rejected as durations so a "2026" project label doesn't become 2026 minutes.

## Markdown task provider — file format

The markdown provider stores everything yCal needs in a single `tasks.md` file under `cloudStore` (so it follows the user across Macs through iCloud Drive when enabled). Reference the parser in `src/main/taskProviders/markdownDoc.ts` if you need the gritty details — here's the user-facing shape:

```markdown
# Project Name {#5897c5}        ← top-level project; trailing {#hex} is optional
## Section Name                 ← nested project (any depth)

- [ ] Task title  @2026-05-15 !p2 #30m #high #office  ^abc12345
  Indented plain text becomes the description.
  Multiple lines OK; blank lines are paragraph breaks.
  - [ ] Subtask  ^def67890
  > [2026-05-01] First comment.
  > [2026-05-02] Second.

- [x] Done task  ^xyz98765
```

**Token grammar after the title:**
- `@YYYY-MM-DD` — due date (one). Also accepts `@today`, `@tomorrow`.
- `@daily` / `@weekdays` / `@every Mon Wed Fri` — weekday recurrence. Cadences that don't reduce to a weekday set (e.g. "every 3 days") set `isRecurring=true` but leave `recur.dow=null`, mirroring the Todoist provider so the Routines fold behaves identically.
- `!p1` … `!p4` — priority. **!p1 = highest = wire-priority 4** (matches Todoist's mental model where the user calls it "P1"). Default = 1.
- `#30m`, `#1h`, `#1h30m` — duration label.
- `#low`, `#mid`, `#high` — energy label.
- `#anything-else` — location label (first one wins).
- `^xxxxxxxx` — Obsidian-style block id. **Auto-assigned on first save when missing**, and the file is rewritten to make the id stick. Block ids survive title renames; without them, schedule overlay entries would orphan whenever the user edited a title.

**Why ids matter:** local schedule + done overlay (`tasks-schedule.json`) keys by task id. So the markdown file is *the* source of truth for what a task is, but the schedule of when it's planned lives separately. This is the same split the Todoist provider uses — `closeTask`/`reopenTask`/`addComment` write through to the markdown file, but `scheduleTask` does not (drag-to-schedule never round-trips to the markdown).

**Targeted-edit invariant:** the provider does line-level patches for close/reopen/addComment rather than re-emitting the whole document. That's deliberate — the user can keep arbitrary prose between blocks (HTML comments for help text, free-form notes, code fences) and yCal won't munge it. Re-serialization only happens on `needsRewrite` (new ids).

**Provider switching:** Settings → Tasks now offers a Todoist ↔ Markdown segmented control. Switching does NOT migrate tasks between providers — the markdown file and Todoist account each remain their own canonical source. The local schedule overlay is shared, so a chip dropped on Tuesday stays on Tuesday across a switch (though the id won't resolve to the new provider's tasks until the user moves it).

## Day rhythm — time-versioned defaults

`rhythm.json` (cloudStore-routed) holds:
- `defaults: RhythmDefault[]` — sorted ascending by `fromDate`. Every default-change appends a new entry; **historical days resolve through the previous entry**, so changing wake/sleep today does not rewrite last week's planning.
- `overrides: Record<dateStr, RhythmOverride>` — per-day explicit values from dragging the wake/sleep line in week or day view. These win over the default.

`resolveDefault(data, dateStr)` walks the list and returns the latest entry whose `fromDate ≤ dateStr`. `resolveEffective` layers the override on top. The renderer mirrors these helpers in `src/renderer/src/rhythm.ts` so a frame can paint without bouncing off IPC.

## Day-load gauge — energy + free-time indicator

`src/renderer/src/dayLoad.ts#computeDayLoad` is the single source of truth for the capacity bar that appears under each date (month cell, week/day column header) and as a richer summary in the day detail panel. Three rendering surfaces in `components/DayLoad.tsx`: `DayLoadGauge` (compact bar + head variant), `DayLoadReadout` ("5h free" / "PACKED"), `DayLoadSummary` (free + committed + meta block).

Two metrics come out of one pass over a configurable **active window**:

- `occupiedMin` — timed events + scheduled tasks, clipped to the window. RSVP-declined / holiday / location events don't count.
- `energyScore` — equivalent meeting hours: meetings 1.0×/h, tasks weighted by their declared energy (low 0.5×, mid 1.0×, high 1.5×).

**Active window** is the `loadWindow` UI setting:
- `mode: 'fixed'` (default) — `startMin` / `endMin` from midnight. Default is **9 AM – 6 PM** so packed work days actually read as packed instead of looking 60% free against a 16-hour wake-to-sleep span.
- `mode: 'rhythm'` — falls back to wake → sleep from the per-day rhythm.

**Energy bands** are the `loadBands` UI setting (default 3 / 6 / 9 equivalent meeting hours = calm / steady / full / heavy). `resolveBands` snaps misordered values up so calm < steady < full always holds and no bucket is unreachable. Color ramp is green → yellow → orange → red (calm → heavy), driven by the `i-<intensity>` class on each component. Don't change the order without updating the CSS variables in `styles.css` (search for `.day-load-gauge.i-`).

A null return from `computeDayLoad` means "nothing scheduled" — callers skip rendering the gauge entirely so empty days stay quiet on the page.

## Event popover — Meet link + attendees

`EventPopover.tsx` renders the "Video" row when `event.meetUrl` is set and the "Guests" row via `PopoverAttendees.tsx` when `event.attendees` is non-empty. Both fields are populated in `main/calendar.ts`:

- `meetUrl` comes from `conferenceData.entryPoints[type=video].uri` (preferred — carries the conference solution name) or the legacy `hangoutLink`. We strip `https://` so the popover can render it as a compact label and re-add the protocol when opening externally.
- `attendees` mirrors Google's attendee object, including `additionalGuests` so "+47 others" rows roll up correctly into the count pills.

`PopoverAttendees` sorts organizer → self → accepted → tentative → needsAction → declined and folds long lists past 5 with an expand/collapse. Avatar background is a stable hash of the email clamped to the 130–290 hue range so dots never collide with the warm calendar palette.

## Drag-and-drop bug to remember

The task-drag system uses a custom pointer + HTML5 hybrid controller (`src/renderer/src/dragController.tsx`). The bug from the original prototype was: `useDragTarget`'s effect depended on inline arrow callbacks, so every render tore down + rebuilt the listeners, and a render landing between pointerup and the rebuild swallowed the drop. **The fix is to read callbacks through a `cbRef`** — see the comment block at the top of `dragController.tsx`. Don't undo this when refactoring.

## Things I learned the hard way (so future Claude doesn't have to)

- **Don't `pkill -f yCal`** — the user's GUI is part of "shared/external state" and the harness will refuse. If you need the GUI to restart, ask the user to Cmd-Q it.
- **The installed app at `/Applications/yCal.app` is the auto-update target,** so `bin/ycal`'s default behavior of preferring it over the dev checkout is almost always what's wanted.
- **`open -a yCal` activates the running instance,** it doesn't spawn a second one. Good for the "launch if not running" path.
- **`fs.existsSync` on socket files reports the file, not a live listener.** A stale socket file + no listener still passes existsSync; you have to actually try `connect()`.
- **macOS APFS is case-insensitive by default,** so `ycal/cli.sock` and `yCal/cli.sock` resolve identically — but case-sensitive volumes exist. Use the lowercase canonical path.
- **Smoke testing the socket end-to-end requires the new app to be installed.** Typecheck + build catch type errors but not runtime protocol bugs. Plan for "release a fix and iterate" rather than expecting first-shot perfection on socket changes.
- **The dev-tree `bin/ycal` is CommonJS but the project is `"type": "module"`,** so `node ./bin/ycal …` from this checkout fails with "require is not defined". Drive the in-process CLI via `./node_modules/.bin/electron . --cli …` for local smoke tests, or hit the socket directly. The installed `/Applications/yCal.app` binary is unaffected.
