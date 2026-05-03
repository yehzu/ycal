// Auto-update against GitHub releases.
//
// We don't ship a code-signed/notarised build (no Apple Developer Program),
// so electron-updater's swap-and-relaunch dies the moment Gatekeeper looks
// at the new bundle. Manual fix: drag the dmg into /Applications and run
// `xattr -cr /Applications/yCal.app` to strip the quarantine bit. This
// module automates that — one click, no terminal.
//
// Flow on click:
//   1. Hit GitHub's releases API for the latest tag.
//   2. Pick the arch-matched .zip asset and download it ourselves.
//      (Node's https doesn't add the LSQuarantine xattr; the Safari /
//      Chrome quarantine bit is what tripped us up before.)
//   3. Extract with `ditto` into a temp dir.
//   4. Strip xattr defensively.
//   5. Spawn a detached bash helper that:
//        - waits for our process to fully exit,
//        - moves the running bundle aside,
//        - moves the new bundle in place,
//        - clears xattrs,
//        - relaunches via `open`,
//        - rolls back on failure so the user is never appless.
//   6. app.quit().
//
// We surface lifecycle to the renderer as a single UpdateStatus stream so
// the existing toast + splash keep working.
import {
  createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync,
  renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import https from 'node:https';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile as execFileCb, spawn } from 'node:child_process';
import { promisify } from 'node:util';

import type { BrowserWindow } from 'electron';
import { app } from 'electron';

import { IPC } from '@shared/types';
import type { UpdateStatus } from '@shared/types';

const execFile = promisify(execFileCb);

const RELEASES_URL = 'https://api.github.com/repos/yehzu/ycal/releases/latest';
const RECHECK_INTERVAL_MS = 30 * 60 * 1000;
const FOCUS_CHECK_MIN_GAP_MS = 60 * 1000;

let lastCheckAt = 0;
let lastStatus: UpdateStatus = { state: 'idle', version: null };
let currentWin: BrowserWindow | null = null;
let pendingAssetUrl: string | null = null;
let pendingAssetSize: number | null = null;
let pendingVersion: string | null = null;
let pendingZipPath: string | null = null;
let prefetchPromise: Promise<void> | null = null;
let installInProgress = false;

function broadcast(status: UpdateStatus): void {
  lastStatus = status;
  if (currentWin && !currentWin.isDestroyed()) {
    currentWin.webContents.send(IPC.UpdateStatus, status);
  }
}

// Compare semver-ish "x.y.z" strings (no prerelease support — we don't ship
// any). Returns negative / 0 / positive in the usual sense.
function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

interface GhAsset {
  name: string;
  browser_download_url: string;
  size: number;
}
interface GhRelease {
  tag_name: string;
  draft?: boolean;
  prerelease?: boolean;
  assets: GhAsset[];
}

// Hard ceiling on a single GitHub API call. Without it, a half-open TCP
// connection (no RST, no FIN) leaves https.get hanging forever — and the
// renderer's "Checking for updates…" never clears.
const FETCH_JSON_TIMEOUT_MS = 15_000;

function fetchJson(url: string, redirectsLeft = 3): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': 'yCal-Updater',
          Accept: 'application/vnd.github+json',
        },
        timeout: FETCH_JSON_TIMEOUT_MS,
      },
      (res: IncomingMessage) => {
        const status = res.statusCode ?? 0;
        if ((status === 301 || status === 302) && res.headers.location && redirectsLeft > 0) {
          res.resume();
          fetchJson(res.headers.location, redirectsLeft - 1).then(resolve, reject);
          return;
        }
        if (status !== 200) {
          res.resume();
          reject(new Error(`GitHub API ${status}`));
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => { body += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(body)); }
          catch (e) { reject(e); }
        });
        res.on('error', reject);
      },
    );
    req.on('timeout', () => {
      req.destroy(new Error(`GitHub API timeout after ${FETCH_JSON_TIMEOUT_MS}ms`));
    });
    req.on('error', reject);
  });
}

// Watchdog so a stalled download (no bytes for this long) errors out
// instead of hanging the prefetch / install path forever.
const DOWNLOAD_STALL_TIMEOUT_MS = 30_000;

function downloadFile(
  url: string,
  dest: string,
  onProgress?: (percent: number) => void,
  redirectsLeft = 5,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { 'User-Agent': 'yCal-Updater' }, timeout: DOWNLOAD_STALL_TIMEOUT_MS },
      (res: IncomingMessage) => {
        const status = res.statusCode ?? 0;
        if ((status === 301 || status === 302) && res.headers.location && redirectsLeft > 0) {
          res.resume();
          downloadFile(res.headers.location, dest, onProgress, redirectsLeft - 1).then(resolve, reject);
          return;
        }
        if (status !== 200) {
          res.resume();
          reject(new Error(`Download HTTP ${status}`));
          return;
        }
        const total = Number(res.headers['content-length'] ?? 0);
        let received = 0;
        const ws = createWriteStream(dest);
        res.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (total > 0 && onProgress) onProgress((received / total) * 100);
        });
        res.pipe(ws);
        ws.on('finish', () => ws.close((err) => (err ? reject(err) : resolve())));
        ws.on('error', reject);
        res.on('error', reject);
      },
    );
    req.on('timeout', () => {
      req.destroy(new Error(`Download stalled after ${DOWNLOAD_STALL_TIMEOUT_MS}ms`));
    });
    req.on('error', reject);
  });
}

// electron-builder names the macOS zips:
//   yCal-X.Y.Z-arm64-mac.zip   (Apple Silicon)
//   yCal-X.Y.Z-mac.zip         (Intel — no arch infix)
// blockmap files share the prefix, so explicitly skip them.
function pickAsset(release: GhRelease): GhAsset | null {
  const zips = release.assets.filter(
    (a) => a.name.endsWith('.zip') && !a.name.endsWith('.blockmap'),
  );
  if (process.arch === 'arm64') {
    return zips.find((a) => a.name.includes('-arm64-mac.zip')) ?? null;
  }
  return zips.find((a) => !a.name.includes('-arm64-') && a.name.includes('-mac.zip')) ?? null;
}

function getCacheDir(): string {
  const dir = path.join(app.getPath('userData'), 'update-cache');
  mkdirSync(dir, { recursive: true });
  return dir;
}

// Wipe stale cached zips that aren't the version we currently want. Called
// on every successful check so the cache stays bounded (~one zip / ~120 MB).
function pruneCache(keepVersion: string | null): void {
  let dir: string;
  try { dir = getCacheDir(); } catch { return; }
  const keepName = keepVersion ? `yCal-${keepVersion}.zip` : null;
  for (const name of readdirSync(dir)) {
    if (name === keepName) continue;
    try { rmSync(path.join(dir, name), { force: true }); } catch { /* best-effort */ }
  }
}

// Background download. Fires when checkForUpdate detects a new version. If
// the file is already on disk and the size matches GH's content-length, we
// skip the download and jump straight to 'ready'. Errors keep us in
// 'available' so the user can still click Install (which falls back to a
// foreground download) — silent failures don't blow up the UI.
async function prefetchAsset(): Promise<void> {
  if (!pendingAssetUrl || !pendingVersion) return;
  const version = pendingVersion;
  const url = pendingAssetUrl;
  const expectedSize = pendingAssetSize;

  const cacheDir = getCacheDir();
  const target = path.join(cacheDir, `yCal-${version}.zip`);

  // Already cached and intact? Skip the download entirely.
  if (existsSync(target)) {
    try {
      const st = statSync(target);
      if (st.size > 0 && (expectedSize == null || st.size === expectedSize)) {
        pendingZipPath = target;
        broadcast({ state: 'ready', version, progress: 100 });
        return;
      }
      rmSync(target, { force: true });
    } catch { /* fall through to redownload */ }
  }

  pruneCache(version);

  const partial = target + '.partial';
  try { rmSync(partial, { force: true }); } catch { /* best-effort */ }

  try {
    await downloadFile(url, partial, (pct) => {
      const rounded = Math.min(99, Math.max(0, Math.round(pct)));
      if (installInProgress) {
        // User clicked Install while prefetch was running — feed the
        // splash so the user sees real progress instead of a frozen 0%.
        // Mirror the foreground flow's 0–90% reservation for the
        // download phase.
        broadcast({
          state: 'installing',
          version,
          progress: Math.min(Math.round(rounded * 0.9), 90),
        });
      } else {
        broadcast({ state: 'available', version, progress: rounded });
      }
    });
    renameSync(partial, target);
    pendingZipPath = target;
    // Don't downgrade the splash back to 'ready' if the user already hit
    // Install — performInstall is mid-flight and owns the state from here.
    if (!installInProgress) {
      broadcast({ state: 'ready', version, progress: 100 });
    }
  } catch {
    try { rmSync(partial, { force: true }); } catch { /* best-effort */ }
    pendingZipPath = null;
    if (!installInProgress) {
      // Stay 'available' so the user can still trigger a foreground retry.
      broadcast({ state: 'available', version });
    }
    // If install IS in progress, performInstall will handle the failure
    // and broadcast its own error.
  }
}

async function checkForUpdate(): Promise<void> {
  if (!app.isPackaged) return;
  if (installInProgress) return;
  broadcast({ state: 'checking', version: null });
  try {
    const release = (await fetchJson(RELEASES_URL)) as GhRelease;
    if (release.draft || release.prerelease) {
      broadcast({ state: 'idle', version: null });
      return;
    }
    const tagVersion = release.tag_name.replace(/^v/, '');
    if (compareVersions(tagVersion, app.getVersion()) <= 0) {
      pendingAssetUrl = null;
      pendingAssetSize = null;
      pendingVersion = null;
      pendingZipPath = null;
      prefetchPromise = null;
      pruneCache(null);
      broadcast({ state: 'idle', version: null });
      return;
    }
    const asset = pickAsset(release);
    if (!asset) {
      broadcast({ state: 'idle', version: null });
      return;
    }
    // If we already have this version queued, don't re-prefetch — but DO
    // restore the renderer to the right post-check state. Otherwise the
    // 'checking' broadcast we fired at the top of this function leaves
    // the UI stuck at "Checking for updates…" forever.
    if (pendingVersion === tagVersion && (pendingZipPath || prefetchPromise)) {
      if (pendingZipPath) {
        broadcast({ state: 'ready', version: tagVersion, progress: 100 });
      } else {
        // Prefetch still in flight — its onProgress callback owns the
        // numeric progress, so just nudge the state back to 'available'.
        broadcast({ state: 'available', version: tagVersion });
      }
      return;
    }
    pendingAssetUrl = asset.browser_download_url;
    pendingAssetSize = asset.size || null;
    pendingVersion = tagVersion;
    pendingZipPath = null;
    broadcast({ state: 'available', version: tagVersion, progress: 0 });
    prefetchPromise = prefetchAsset();
  } catch (e) {
    broadcast({
      state: 'error',
      version: lastStatus.version,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

// Quote a string for safe inclusion as a single-quoted bash literal.
function shQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function buildSwapScript(opts: {
  currentBundle: string;
  newBundle: string;
  tmpRoot: string;
  logFile: string;
  persistentLog: string;
  execName: string; // e.g. "yCal"
}): string {
  const CB = shQuote(opts.currentBundle);
  const NB = shQuote(opts.newBundle);
  const TR = shQuote(opts.tmpRoot);
  const LF = shQuote(opts.logFile);
  const PL = shQuote(opts.persistentLog);
  const EN = shQuote(opts.execName);
  return `#!/bin/bash
# yCal update swap helper. Generated by main/updater.ts.
CURRENT_BUNDLE=${CB}
NEW_BUNDLE=${NB}
TMP_ROOT=${TR}
LOG_FILE=${LF}
PERSISTENT_LOG=${PL}
EXE_NAME=${EN}
EXE="$CURRENT_BUNDLE/Contents/MacOS/$EXE_NAME"

exec >"$LOG_FILE" 2>&1
echo "[ycal-swap] $(date): start"
echo "[ycal-swap] current=$CURRENT_BUNDLE"
echo "[ycal-swap] new=$NEW_BUNDLE"

# Wait up to ~10s for the running yCal to exit so we don't fight it for the
# bundle path. After 10s we proceed anyway — APFS lets us mv a running
# bundle's directory; the existing process keeps its open file handles.
for i in $(seq 1 100); do
  if ! pgrep -f "$EXE" >/dev/null 2>&1; then
    echo "[ycal-swap] old process gone after $i*0.1s"
    break
  fi
  sleep 0.1
done
sleep 0.4

# Move current bundle aside instead of deleting first — if anything goes
# wrong below we can restore it and the user still has a working app.
ASIDE="$CURRENT_BUNDLE.previous-$$"
if [ -d "$CURRENT_BUNDLE" ]; then
  if ! mv "$CURRENT_BUNDLE" "$ASIDE"; then
    echo "[ycal-swap] could not move current aside; aborting"
    cp "$LOG_FILE" "$PERSISTENT_LOG" 2>/dev/null || true
    exit 1
  fi
fi

# Install the new bundle.
if ! mv "$NEW_BUNDLE" "$CURRENT_BUNDLE"; then
  echo "[ycal-swap] install mv failed; restoring previous"
  if [ -d "$ASIDE" ]; then mv "$ASIDE" "$CURRENT_BUNDLE"; fi
  cp "$LOG_FILE" "$PERSISTENT_LOG" 2>/dev/null || true
  exit 1
fi

# Strip macOS quarantine + any other com.apple.* xattrs Gatekeeper trips on.
xattr -cr "$CURRENT_BUNDLE" || true

# Sanity-check before we toss the backup.
if [ ! -x "$CURRENT_BUNDLE/Contents/MacOS/$EXE_NAME" ]; then
  echo "[ycal-swap] new bundle missing executable; restoring"
  rm -rf "$CURRENT_BUNDLE"
  if [ -d "$ASIDE" ]; then mv "$ASIDE" "$CURRENT_BUNDLE"; fi
  cp "$LOG_FILE" "$PERSISTENT_LOG" 2>/dev/null || true
  exit 1
fi

# Drop the old bundle now that we're sure the new one is intact.
if [ -d "$ASIDE" ]; then rm -rf "$ASIDE"; fi

# Refresh LaunchServices' cache. After we replace the bundle on disk LSi
# can hold a stale entry pointing at the (just-deleted) inode, which makes
# a subsequent \`open\` resolve to nothing and the relaunch silently fail.
# Re-registering the path forces LSi to pick up the new Info.plist.
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
if [ -x "$LSREGISTER" ]; then
  "$LSREGISTER" -f "$CURRENT_BUNDLE" >/dev/null 2>&1 || true
fi

# Give LSi (and the Dock) a beat to settle after the re-register before
# launching. Without this gap, \`open\` can race the registration update
# and either no-op or spawn a duplicate dock entry.
sleep 1.0

# Try plain \`open\` first. \`open -n\` (force new instance) was needed
# previously because LSi sometimes thought the old yCal was still running
# right after we quit; it had the side effect of registering a SECOND
# entry in the Dock. With the longer wait above plus re-register, plain
# \`open\` reliably reuses the existing dock slot.
echo "[ycal-swap] launching"
LAUNCHED=0
for attempt in 1 2 3; do
  if open "$CURRENT_BUNDLE"; then
    sleep 0.8
    if pgrep -f "$EXE" >/dev/null 2>&1; then
      echo "[ycal-swap] plain open succeeded on attempt $attempt"
      LAUNCHED=1
      break
    fi
    echo "[ycal-swap] plain open returned 0 but no process; retrying"
  else
    echo "[ycal-swap] plain open attempt $attempt failed (rc=$?)"
  fi
  sleep 0.5
done
# Fall back to \`open -n\` only if the friendly path didn't actually bring
# up a process. Better a duplicate dock icon than no app.
if [ $LAUNCHED -eq 0 ]; then
  echo "[ycal-swap] falling back to open -n"
  open -n "$CURRENT_BUNDLE" || echo "[ycal-swap] open -n failed too (rc=$?)"
fi

# Mirror the log to a stable spot the user can find. The tmp dir is wiped
# soon after, so without this a failed relaunch leaves no trace.
cp "$LOG_FILE" "$PERSISTENT_LOG" 2>/dev/null || true

# Self-clean the temp dir after a beat (keep briefly so the log survives a
# tail if the user wants to debug).
( sleep 10 && rm -rf "$TMP_ROOT" ) &
echo "[ycal-swap] done"
`;
}

async function performInstall(): Promise<void> {
  if (installInProgress) return;
  if (!app.isPackaged) return;
  if (!pendingAssetUrl || !pendingVersion) {
    // No update queued. Try one fresh check, then bail if there's nothing.
    await checkForUpdate();
    if (!pendingAssetUrl || !pendingVersion) return;
  }
  installInProgress = true;

  const version = pendingVersion;
  broadcast({ state: 'installing', version, progress: 0 });

  const tmpRoot = mkdtempSync(path.join(tmpdir(), 'ycal-update-'));
  const fallbackZip = path.join(tmpRoot, 'app.zip');
  const extractDir = path.join(tmpRoot, 'extract');
  const logFile = path.join(tmpRoot, 'swap.log');
  const swapScript = path.join(tmpRoot, 'swap.sh');

  try {
    // Wait for any in-flight prefetch so we don't race the rename.
    if (prefetchPromise) {
      try { await prefetchPromise; } catch { /* fall through */ }
    }

    let zipPath: string;
    if (pendingZipPath && existsSync(pendingZipPath)
        && statSync(pendingZipPath).size > 0) {
      // Pre-fetched: skip the slow download step entirely.
      zipPath = pendingZipPath;
      broadcast({ state: 'installing', version, progress: 90 });
    } else {
      zipPath = fallbackZip;
      await downloadFile(pendingAssetUrl, zipPath, (pct) => {
        // Reserve the last 10% for extract + handoff so the bar doesn't sit
        // at 100% while ditto is still chewing.
        broadcast({
          state: 'installing', version,
          progress: Math.min(Math.round(pct * 0.9), 90),
        });
      });
    }

    broadcast({ state: 'installing', version, progress: 92 });

    // Use macOS's `ditto` rather than `unzip`: it's the same tool electron-
    // builder uses on the creating side, preserves resource forks/xattrs
    // exactly, and is always present.
    await execFile('/usr/bin/ditto', ['-x', '-k', zipPath, extractDir]);

    // Find the unzipped .app — usually `yCal.app` at the top of extractDir.
    const newBundle = path.join(extractDir, 'yCal.app');
    statSync(newBundle); // throws if missing — surfaces a clear error

    // Defensive xattr strip on the freshly-extracted bundle. Node's https
    // shouldn't add quarantine, but ditto preserves source xattrs and
    // future transports (Safari, AirDrop) might.
    await execFile('/usr/bin/xattr', ['-cr', newBundle]);

    broadcast({ state: 'installing', version, progress: 95 });

    // process.execPath → .../yCal.app/Contents/MacOS/yCal
    // Walk three dirname()s up to get the bundle root, regardless of where
    // the user actually installed yCal (/Applications, ~/Applications, etc).
    const exePath = process.execPath;
    const currentBundle = path.dirname(path.dirname(path.dirname(exePath)));
    const execName = path.basename(exePath);

    // Stable log location so a failed relaunch can be diagnosed after the
    // tmp dir is cleaned up. ~/Library/Logs is the conventional macOS spot.
    const persistentLogDir = path.join(
      app.getPath('home'), 'Library', 'Logs', 'yCal',
    );
    mkdirSync(persistentLogDir, { recursive: true });
    const persistentLog = path.join(persistentLogDir, 'swap.log');

    const script = buildSwapScript({
      currentBundle,
      newBundle,
      tmpRoot,
      logFile,
      persistentLog,
      execName,
    });
    writeFileSync(swapScript, script, { mode: 0o755 });

    const child = spawn('/bin/bash', [swapScript], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();

    broadcast({ state: 'installing', version, progress: 100 });

    // Brief pause so the splash can render the "100% / closing" frame
    // before Electron tears the window down.
    setTimeout(() => app.quit(), 600);
  } catch (e) {
    installInProgress = false;
    broadcast({
      state: 'error',
      version,
      error: e instanceof Error ? e.message : String(e),
    });
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

export function setupAutoUpdater(win: BrowserWindow): void {
  currentWin = win;
  if (!app.isPackaged) return;

  // Initial check.
  void checkForUpdate();

  // Periodic background re-check.
  setInterval(() => {
    lastCheckAt = Date.now();
    void checkForUpdate();
  }, RECHECK_INTERVAL_MS);

  // Focus-driven check — coalesced so rapid alt-tabbing doesn't hammer
  // GitHub's API rate limit.
  win.on('focus', () => {
    const now = Date.now();
    if (now - lastCheckAt < FOCUS_CHECK_MIN_GAP_MS) return;
    lastCheckAt = now;
    void checkForUpdate();
  });
}

export function getLastUpdateStatus(): UpdateStatus {
  return lastStatus;
}

export async function checkForUpdatesNow(): Promise<void> {
  if (!app.isPackaged) return;
  lastCheckAt = Date.now();
  await checkForUpdate();
}

export function requestInstall(): void {
  void performInstall();
}
