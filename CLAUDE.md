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
│   ├── index.ts        Entry point, window creation, IPC registration, --cli dispatch
│   ├── auth.ts         OAuth loopback flow (port 0, ephemeral)
│   ├── tokenStore.ts   safeStorage-backed accounts.json (Keychain on macOS)
│   ├── config.ts       Loads oauth-client.json from userData
│   ├── calendar.ts     Google Calendar API client + event shaping
│   ├── settings.ts     UI settings + weather URL persistence
│   ├── weather.ts      iCal-format weather feed parser + cache
│   ├── updater.ts      electron-updater wiring
│   ├── cli.ts          Argv-driven CLI (LLM-friendly, JSON/text/markdown)
│   └── cliServer.ts    Unix socket server bridging external clients to runCli
├── preload/      contextBridge → window.ycal; the only renderer↔main surface
├── renderer/     React UI; styled in src/renderer/src/styles.css
└── shared/       Cross-process types and pure helpers
    ├── types.ts        IPC contract — change carefully
    └── dedup.ts        Cross-calendar duplicate collapsing (used by both)
bin/ycal         Plain-Node CLI client (no Electron import — talks to socket)
```

## Architectural invariants — don't break these

1. **Renderer never sees Google credentials or makes network calls.** All Google API traffic happens in main. Renderer talks to main only via `IPC` channels declared in `@shared/types`. CSP in `index.html` blocks arbitrary network access.
2. **Refresh tokens are encrypted at rest.** Always go through `tokenStore.ts`; never write a plaintext refresh token. `safeStorage` requires Electron runtime — that's why the CLI server lives inside the GUI process.
3. **OAuth scopes are read-only.** Adding write functionality requires dropping `.readonly` from `src/main/auth.ts` *and* re-consenting users. Don't broaden silently.
4. **`@shared/types.ts` is the IPC contract.** Adding/removing fields ripples through main, preload, renderer. CLI socket protocol is a separate contract; see below.
5. **`app.name` resolves to `"ycal"` (lowercase, from package.json `name`).** That's the userData dir name on disk: `~/Library/Application Support/ycal/`. The `productName` `"yCal"` only affects the .app bundle name. Don't call `app.setName('yCal')` — it would orphan existing users' tokens.

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

## Where to put new code

- **Shared by main and renderer (types, pure helpers)** → `src/shared/`. Both ts-projects alias `@shared/*` here.
- **Renderer-only (React component, hook, dates helper)** → `src/renderer/src/`. Aliased as `@renderer/*` in renderer-only.
- **Main-only (Google API, IPC handler, OS integration)** → `src/main/`. Register IPC channel name in `@shared/types#IPC` first.
- **CLI subcommand** → add a `cmdFoo(args, io)` to `src/main/cli.ts`, wire into `runCli`'s switch, document in the `helpText` string and in `README.md`.

## Release flow

1. Bump `package.json` `version` (semver: bug fix → patch, new CLI command → minor).
2. `npm run typecheck && npm run build`.
3. Commit with the project's Bump format:
   ```
   Bump X.Y.Z: <short summary>

   <reasoning>
   ```
4. `git push origin main && git tag vX.Y.Z && git push origin vX.Y.Z`.
5. `GH_TOKEN=$(gh auth token) npm run dist -- --publish always`.
6. Open the resulting draft release on GitHub, click Publish. Existing installs auto-update within ~6h via `electron-updater`.

**`bin/ycal` is not in the dmg.** It's a checkout-only script. If a fix lives in `bin/ycal`, users with `~/.local/bin/ycal` already symlinked or copied need to re-copy. A version bump still helps signal that.

## User preferences (from session memory)

- **Match the user's input language.** Chinese in → Chinese out, English in → English out.
- **Direct, concise.** Lead with the answer; expand only on follow-up.
- **Frame technical decisions in business terms** when they affect users / release scope.
- **Don't ask before reading or building** (auto mode is the norm). Do ask before pushing to main, publishing releases, or any irreversible/external action.
- **`git push origin main` is blocked by harness policy** — explicit per-call confirmation needed every time, regardless of prior approvals.

## Things I learned the hard way (so future Claude doesn't have to)

- **Don't `pkill -f yCal`** — the user's GUI is part of "shared/external state" and the harness will refuse. If you need the GUI to restart, ask the user to Cmd-Q it.
- **The installed app at `/Applications/yCal.app` is the auto-update target,** so `bin/ycal`'s default behavior of preferring it over the dev checkout is almost always what's wanted.
- **`open -a yCal` activates the running instance,** it doesn't spawn a second one. Good for the "launch if not running" path.
- **`fs.existsSync` on socket files reports the file, not a live listener.** A stale socket file + no listener still passes existsSync; you have to actually try `connect()`.
- **macOS APFS is case-insensitive by default,** so `ycal/cli.sock` and `yCal/cli.sock` resolve identically — but case-sensitive volumes exist. Use the lowercase canonical path.
- **Smoke testing the socket end-to-end requires the new app to be installed.** Typecheck + build catch type errors but not runtime protocol bugs. Plan for "release a fix and iterate" rather than expecting first-shot perfection on socket changes.
