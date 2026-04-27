# yCal

An editorial-styled macOS calendar with multi-Google-account support and per-event colors.

Stack: Electron + Vite + React + TypeScript. Uses the Google Calendar API directly (the same approach Notion Calendar takes), so per-event color overrides work.

---

## One-time setup

### 1. Install dependencies

```bash
cd /Users/yehzu/github/yCal
npm install
```

### 2. Create a Google Cloud OAuth client

Google requires you to create your own OAuth client because the app talks to Google as you, not as a published service.

1. Go to <https://console.cloud.google.com/> and create a new project (e.g., "yCal").
2. **Enable the Google Calendar API:** APIs & Services → Library → search "Google Calendar API" → Enable.
3. **Configure the OAuth consent screen:** APIs & Services → OAuth consent screen.
   - User type: **External**
   - App name: `yCal` (only you will see it)
   - Support email: your email
   - Developer contact: your email
   - Scopes: add `.../auth/calendar.readonly`, `.../auth/calendar.events.readonly`, `.../auth/userinfo.email`, `.../auth/userinfo.profile`, `openid`
   - **Test users:** add every Gmail address you want to sign into yCal with. Until the app is verified by Google, only listed test users can sign in.
4. **Create the OAuth client:** APIs & Services → Credentials → Create credentials → OAuth client ID.
   - Application type: **Desktop app**
   - Name: `yCal desktop`
   - Click Create.
5. Download the JSON. Rename it to `oauth-client.json`.

### 3. Place `oauth-client.json` where the app can find it

The app looks in this order:

1. `$YCAL_CONFIG` env var (full path)
2. macOS userData dir: `~/Library/Application Support/yCal/oauth-client.json`
3. App resources dir
4. Current working directory

The userData path is the right home for it on macOS:

```bash
mkdir -p ~/Library/Application\ Support/yCal
mv ~/Downloads/client_secret_*.json ~/Library/Application\ Support/yCal/oauth-client.json
```

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

> **About `client_secret` for desktop apps:** Google's docs note that a "secret" embedded in a desktop app isn't actually secret. It's a per-installation identifier, not a security boundary. Treat it as such — don't commit `oauth-client.json` to git (`.gitignore` already excludes it).

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
- **Auto-update against GitHub releases** via `electron-updater`. On startup (and every six hours after) the app polls the repo's `latest-mac.yml`. When a newer release is found it downloads the zip silently in the background; once ready, a full-bleed splash with a **Relaunch yCal** button appears, and clicking it quits, swaps the binary, and reopens. Skipping a version with **Later** suppresses the toast for that version only.

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

The CLI is the same Electron binary as the app, launched with a `--cli` sentinel. Because Electron is required for `safeStorage` (which decrypts your refresh tokens), there is no plain-Node fallback. Sign-in must happen via the GUI; once you're signed in, the CLI can read your calendars without the GUI running.

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
--no-dedup               Disable cross-calendar duplicate collapsing.
--format json|text|markdown    Default: json.
```

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
- **Stderr is for diagnostics only.** stdout receives exactly one JSON document (or one text/markdown block). Pipe-safe.
- **Default range** for `events` is today through 7 days out. Override with `--from`/`--to`.

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
