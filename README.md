# yCal

An editorial-styled macOS calendar with multi-Google-account support and per-event colors.

Stack: Electron + Vite + React + TypeScript. Uses the Google Calendar API directly (the same approach Notion Calendar takes), so per-event color overrides work.

---

## One-time setup (developer)

End-users of a release `.dmg` don't need this section — the OAuth client is bundled into `Contents/Resources/oauth-client.json` at package time, so they just install yCal and click *Sign in*. This setup is only for cutting your own builds.

### 1. Install dependencies

```bash
cd /Users/yehzu/github/yCal
npm install
```

### 2. Create a Google Cloud OAuth client

1. Go to <https://console.cloud.google.com/> and create a project (e.g., `yCal`).
2. **Enable the Google Calendar API:** APIs & Services → Library → search *Google Calendar API* → Enable.
3. **Configure the OAuth consent screen:** APIs & Services → OAuth consent screen.
   - User type: **External**
   - App name: `yCal`
   - Support email + developer contact: your email
   - Scopes: `.../auth/calendar.readonly`, `.../auth/calendar.events.readonly`, `.../auth/userinfo.email`, `.../auth/userinfo.profile`, `openid`
   - **Publishing status: In production.** This is the key step that kills the 7-day refresh-token TTL that "Testing" mode imposes. Unverified-but-published apps still work — first sign-in shows a "Google hasn't verified this app" warning and the user clicks Advanced → Go to yCal. Cap is 100 users; for personal/team use that's plenty. Submit for verification later if you want to remove the warning.
4. **Create the OAuth client:** APIs & Services → Credentials → Create credentials → OAuth client ID.
   - Application type: **Desktop app**
   - Name: `yCal desktop`
5. Download the JSON.

### 3. Place `oauth-client.json` where the build can find it

```bash
mv ~/Downloads/client_secret_*.json build/oauth-client.json
```

That single location now feeds both flows:

- **`npm run dev`** reads `build/oauth-client.json` directly via `loadOAuthConfig`'s dev-mode candidate.
- **`npm run dist` / `npm run package`** copies it into the `.app`'s `Contents/Resources/` via `extraResources`. Installed users get it automatically.

`.gitignore` excludes `build/oauth-client.json`, so the credentials never enter the public repo. The file is still embedded in every release artifact — that's fine for desktop OAuth clients, where Google's docs explicitly note the `client_secret` isn't a real secret.

`loadOAuthConfig` resolution order (highest priority first):

1. `$YCAL_CONFIG` env var (full path) — explicit override
2. `~/Library/Application Support/yCal/oauth-client.json` — per-machine override (drop a file here to point a single Mac at a different OAuth client without rebuilding)
3. **Bundled credentials**: `Contents/Resources/oauth-client.json` (packaged) or `build/oauth-client.json` (dev)
4. App-path / cwd fallbacks (legacy)

The file's shape (Google Cloud Console downloads it wrapped in `{ "installed": { ... } }` — that's fine, the app accepts both):

```json
{
  "installed": {
    "client_id": "XXXXXXXXX.apps.googleusercontent.com",
    "client_secret": "YYYYYY",
    "redirect_uris": ["http://127.0.0.1"]
  }
}
```

---

## Run

```bash
npm run dev          # development with hot reload
npm run build        # type-check + bundle to ./out
npm run start        # preview the production build
npm run package      # build a .app bundle (./release)
npm run dist         # build a signed .dmg (requires codesigning setup)
npm run typecheck    # tsc --noEmit on both projects
```

On first run:

1. The window opens with an empty state.
2. Click **Sign in with Google** (or the **+** in the title bar).
3. Your default browser opens Google's consent screen.
4. After consent, the browser redirects to `http://127.0.0.1:<random>/oauth2callback`, the app captures the code, exchanges it for tokens, and the window populates.
5. Refresh tokens are encrypted via Electron's `safeStorage` (Keychain-backed on macOS) and stored in `accounts.json` in userData.

Add more accounts via the **+** in the account stack. Each account's calendars appear in the sidebar grouped by email.

---

## What works

- Multi-Google-account sign-in via OAuth 2.0 loopback flow
- Calendar list per account, with each calendar's user-customized color
- Events for the visible month range, fetched in parallel across calendars
- **Per-event color overrides** resolved through Google's `/colors` endpoint
- Month / Week / Day views with column-sweep layout for overlapping events
- Tiny / short / regular event rendering modes (so 15-min events don't crash into each other)
- Mini-month sidebar with event-day dots
- Today's agenda summary
- Calendar visibility toggles (per calendar and per account)
- Click event → detail popover with metadata + "Open in Google" link
- Keyboard navigation: ←/→ to step, T jumps to today, Esc closes
- Refresh tokens encrypted at rest via Electron `safeStorage`
- **Cross-calendar duplicate merging.** Events with the same title and time slot across multiple calendars collapse into a single rendering with a `×N` badge; the popover lists all source calendars. Duplicates are matched on `title + start + end + allDay` (case-insensitive title, trimmed). Color of the kept rendering prefers the primary calendar's.
- **Seven-day weather strip** powered by [weather-in-calendar.com](https://weather-in-calendar.com). Generate your per-location iCal feed at that site, paste the URL into the sidebar's *Forecast · Seven Days* section, and the strip updates with daily glyph + high/low. Click the **✎ change** link to update the location (re-generate at the site → paste new URL). The feed is cached for 30 minutes per fetch.
- **Auto-update against GitHub releases.** On startup, every 30 minutes, and whenever the window comes back into focus, yCal polls the repo's latest release via the GitHub API. When a newer version is found a toast appears; clicking **Install & restart** downloads the arch-matched `.zip`, extracts it, strips macOS' Gatekeeper quarantine attribute, swaps the bundle in place, and relaunches — no manual `xattr -cr` or drag-into-Applications step. The flow is robust against unsigned builds (no Apple Developer Program required); on failure the previous bundle is restored so the user is never appless. Skipping a version with **Later** suppresses the toast for that version only.

### Cutting a release

`electron-builder` is configured with `publish: { provider: "github" }`, so:

```bash
GH_TOKEN=<token> npm run dist -- --publish always
```

bumps the artifacts to a draft GitHub release for the version in `package.json`. Tag the commit, publish the draft, and existing installs pick it up on next launch.

---

## CLI (LLM-friendly)

yCal ships a small, headless CLI that reuses the same auth and Google Calendar code as the GUI. Designed for piping into LLMs and other automations: stable JSON output, no TTY-only ANSI escapes, stderr-vs-stdout discipline.

### How it works

`bin/ycal` is a tiny Node script (no Electron). It connects to a Unix socket the GUI yCal exposes at `~/Library/Application Support/ycal/cli.sock` and exchanges one JSON request/response per invocation. Because no second Electron process is started, the macOS Dock never flashes — typical roundtrip is ~50ms.

If yCal isn't already running, the client launches it via `open -a yCal` and polls the socket for up to 15 seconds. The window appears once; subsequent CLI invocations go straight through the socket with the GUI still in the background.

The same `runCli` code path also still works as `yCal --cli <args>` (in-process Electron mode) — useful for CI/headless contexts where the GUI can't display.

### Install

```bash
# from the repo
npm install
npm run build           # produces out/main/index.js
ln -s "$PWD/bin/ycal" /usr/local/bin/ycal   # optional — put it on PATH
```

The launcher in `bin/ycal` prefers the installed `/Applications/yCal.app` binary, falling back to the local checkout. To force a specific binary set `YCAL_BIN=/path/to/yCal`.

For dev work, `npm run ycal -- <args>` runs the CLI from the freshly built source.

### Commands

| Command | Description |
| --- | --- |
| `ycal accounts` | Signed-in Google accounts. |
| `ycal calendars` | All calendars across all accounts. Filter with `--account <id>`. |
| `ycal events` | Events in a date range (default: today + 7d). |
| `ycal today` | Shortcut for `--from today --to today`. |
| `ycal tomorrow` | Shortcut for tomorrow. |
| `ycal week` | Current Mon–Sun. |
| `ycal next [N]` | Next N upcoming events (default 5). |
| `ycal find <query>` | Search events `-7d` to `+90d`. |
| `ycal weather` | Forecast from the configured weather iCal feed. |
| `ycal --help` | Full reference. |

### Flags

```
--from <when>            Start of range. See "Date shorthand".
--to <when>              End of range.
--calendar <id>          Repeatable; restrict to specific calendar IDs.
--account <id>           Repeatable; restrict to specific account IDs.
--search <text>          Substring match against title/description/location.
--limit <n>              Cap result count after sorting by start.
--include-declined       Keep events you've declined (default: drop).
--include-read-only      Include read-only / subscribed calendars (default: drop).
--include-holidays       Include calendars marked as holiday (default: drop).
--all-calendars          Bypass GUI filters; mirror only Google's `selected` flag.
--no-dedup               Disable cross-calendar duplicate collapsing.
--format json|text|markdown    Default: json.
```

### Calendar filtering

By default the events commands mirror the GUI agenda — only your active accounts, only the calendars you have visible in the sidebar, and only "normal" role calendars (read-only / subscribed and holidays excluded). This keeps `ycal today` focused on the same events the app shows you.

When planning your schedule and you want to see colleague availability, add `--include-read-only`:

```bash
ycal week --include-read-only
```

`--calendar <id>` always wins — passing an explicit calendar bypasses every GUI filter.

#### Date shorthand

```
today | tomorrow | yesterday | now
+Nd | +Nw | +Nm | +Nh    (also -Nd, etc.)
YYYY-MM-DD               (local midnight)
YYYY-MM-DDTHH:MM[:SS]    (local time, or include offset)
```

### JSON shape

Every JSON document has at minimum `{ "command", "count" }` and a payload array named after the command. All times are ISO 8601 (timed events carry the originating timezone offset; all-day events are naive YYYY-MM-DDT00:00:00). Durations are in minutes. Descriptions are plain text — HTML is stripped and entities decoded.

```jsonc
{
  "command": "events",
  "params": {
    "from": "2026-04-27T00:00:00.000Z",
    "to":   "2026-05-04T23:59:59.999Z",
    "search": null, "limit": null, "includeDeclined": false,
    "calendarIds": null, "accountIds": null
  },
  "count": 1,
  "events": [
    {
      "id": "abc123",
      "title": "Standup",
      "start": "2026-04-27T09:00:00+08:00",
      "end":   "2026-04-27T09:30:00+08:00",
      "allDay": false,
      "duration_minutes": 30,
      "location": "Zoom",
      "description": null,
      "rsvp": "accepted",                    // accepted | tentative | declined | needsAction | null
      "status": "confirmed",
      "eventType": "default",                // default | workingLocation | outOfOffice | focusTime | birthday | fromGmail
      "calendar": { "id": "...", "name": "Work", "account": "you@gmail.com", "primary": true },
      "url": "https://www.google.com/calendar/event?..."
    }
  ]
}
```

### Examples

```bash
# What's on today, as Markdown for pasting into chat:
ycal today --format markdown

# Next three upcoming events:
ycal next 3

# Pipe to an LLM:
ycal events --from today --to +14d | llm -m claude-opus-4-7 \
  "Summarise my next two weeks. Flag any conflicts."

# Find every "1:1" in the last month:
ycal find "1:1" --from -30d --to today --format text

# Just one calendar, declined included:
ycal events --calendar primary@gmail.com --include-declined
```

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | Usage / runtime error (details on stderr) |
| 2 | Not configured, or no accounts signed in |

### Notes

- **Cross-calendar duplicates are collapsed by default.** Same `(title + start)` events on multiple calendars become one row. Pass `--no-dedup` to see all rows.
- **Declined events are hidden by default.** Pass `--include-declined` to include them.
- **GUI filters apply by default** (read-only, holidays, hidden calendars are dropped). See "Calendar filtering" above for the opt-in flags.
- **Stderr is for diagnostics only.** stdout receives exactly one JSON document (or one text/markdown block). Pipe-safe.
- **Default range** for `events` is today through 7 days out. Override with `--from`/`--to`.
- **Caching:** the GUI process keeps a 5-minute calendar-list cache and a 30-second events cache, so back-to-back CLI calls in interactive use are near-instant. Caches are busted on account add/remove.

---

## What's not built (yet)

- Creating / editing / deleting events (read-only for now; the scopes are restricted to `*.readonly`)
- Real-time push notifications via Google's webhook channels
- Offline cache / persistent event storage between launches
- Recurring-event editing UI
- Time-zone handling beyond the system zone
- Reminders, attendees, conferencing data
- Search
- Holidays / journal sidebar sections (those were prototype-only mock content)

To enable write access, broaden the OAuth scopes in `src/main/auth.ts` (drop the `.readonly` suffix) and add IPC handlers for `events.insert/update/delete`.

---

## Project layout

```
src/
├── main/                 # Electron main process (Node)
│   ├── index.ts          # window + IPC registration
│   ├── config.ts         # loads oauth-client.json
│   ├── auth.ts           # OAuth loopback flow
│   ├── tokenStore.ts     # safeStorage-backed account persistence
│   └── calendar.ts       # Google Calendar API client
├── preload/
│   ├── index.ts          # contextBridge → window.ycal
│   └── index.d.ts        # window.ycal type declaration
├── renderer/
│   ├── index.html
│   └── src/
│       ├── main.tsx
│       ├── App.tsx
│       ├── store.ts      # accounts/calendars/events state
│       ├── dates.ts
│       ├── styles.css    # editorial CSS, ported from the design prototype
│       └── components/   # MacTitleBar, Sidebar, MonthGrid, TimeView, …
└── shared/
    └── types.ts          # IPC contract
```

---

## Privacy & security notes

- The app has read-only access to your Google Calendar.
- Refresh tokens are encrypted via the OS keystore (Keychain on macOS) before being written to disk.
- The renderer process runs with `contextIsolation: true` and `nodeIntegration: false`. All Google API calls happen in the main process; the renderer only sees event objects via IPC.
- Content Security Policy in the renderer disallows arbitrary network calls — events come from main, fonts from Google Fonts, nothing else.
- The app makes one outbound connection on sign-in (to `accounts.google.com`) and ongoing connections to `googleapis.com`. No telemetry.

To revoke access entirely: <https://myaccount.google.com/permissions>.
