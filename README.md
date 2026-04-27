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
