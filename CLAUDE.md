# yCal — Claude working notes

Personal Electron app for the repo owner (a busy EM, not a primary code author). Reads Google Calendar, renders an editorial-styled month/week/day view, plus an LLM-friendly CLI. Optimize for: small reversible changes, clear release flow, never break the auth/encryption story.

User-facing docs live in `README.md`. This file is for fast onboarding when Claude is invoked into the repo.

## Stack at a glance

- **Electron 33** (main + preload + renderer separation enforced)
- **electron-vite + Vite 5 + React 18 + TypeScript**
- **googleapis** for Calendar v3 — read-only OAuth scopes
- **electron-updater + GitHub releases** for auto-update
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
│   ├── settings.ts       UI settings + weather URL + cloudStorage pref
│   ├── weather.ts        iCal-format weather feed parser + cache
│   ├── updater.ts        electron-updater wiring
│   ├── cloudStore.ts     iCloud-Drive-or-local JSON file router (rhythm + tasks)
│   ├── rhythm.ts         Wake/sleep defaults (time-versioned) + per-day overrides
│   ├── tasksStore.ts     Local task overlay (schedule + done) backed by cloudStore
│   ├── taskProviders/    Pluggable task backends
│   │   ├── types.ts        TaskProvider interface
│   │   ├── labels.ts       Troika label parser (duration / energy / location)
│   │   ├── todoist.ts      Todoist /api/v1 client (only provider today)
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
│       ├── dragController.tsx   Pointer + HTML5 hybrid drag controller
│       └── components/
│           ├── TimeView.tsx       Week/Day grid, task chips, rhythm lines, drops
│           ├── TasksPanel.tsx     Right rail + TaskCard + edge tab
│           ├── TaskSheet.tsx      Slide-in detail (description + comments)
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
8. **`cloudStore.ts` is the only thing that knows about iCloud Drive.** Anything that wants iCloud-or-local routing should go through `readJson` / `writeJson` and register its filename in `CLOUD_FILES` so the toggle in Settings → Sync moves it correctly. Today the routed files are `rhythm.json` and `tasks-schedule.json`.

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

`scripts/release.sh` then: typechecks + builds → tags `vX.Y.Z` if not present → pushes `main` and the tag → `npm run dist -- --publish always` (uploads dmg + zip to a draft GitHub release using `gh auth token` for `GH_TOKEN`) → `gh release edit vX.Y.Z --draft=false` to promote the draft to live. Existing installs auto-update within ~6h via `electron-updater`.

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

**Auto-rollover** is purely a renderer-side derivation: if a task's `scheduledAt.date < today` and it isn't done, it shows in the inbox panel with the carry indicator. The local schedule entry stays put until the user reschedules or completes it.

**Troika labels.** `parseTaskMeta` in `taskProviders/labels.ts` reads provider labels (and a few legacy inline tags in titles) and pulls out:
- duration: `30m` / `1h` / `1h30m` / `2h`
- energy: `low` / `mid` / `high` (optional `-energy` suffix)
- location: anything else, first wins

Pure-numeric labels are explicitly rejected as durations so a "2026" project label doesn't become 2026 minutes.

## Day rhythm — time-versioned defaults

`rhythm.json` (cloudStore-routed) holds:
- `defaults: RhythmDefault[]` — sorted ascending by `fromDate`. Every default-change appends a new entry; **historical days resolve through the previous entry**, so changing wake/sleep today does not rewrite last week's planning.
- `overrides: Record<dateStr, RhythmOverride>` — per-day explicit values from dragging the wake/sleep line in week or day view. These win over the default.

`resolveDefault(data, dateStr)` walks the list and returns the latest entry whose `fromDate ≤ dateStr`. `resolveEffective` layers the override on top. The renderer mirrors these helpers in `src/renderer/src/rhythm.ts` so a frame can paint without bouncing off IPC.

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
