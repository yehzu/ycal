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
  createWriteStream, mkdtempSync, rmSync, statSync, writeFileSync,
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
let pendingVersion: string | null = null;
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

function fetchJson(url: string, redirectsLeft = 3): Promise<unknown> {
  return new Promise((resolve, reject) => {
    https.get(
      url,
      {
        headers: {
          'User-Agent': 'yCal-Updater',
          Accept: 'application/vnd.github+json',
        },
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
    ).on('error', reject);
  });
}

function downloadFile(
  url: string,
  dest: string,
  onProgress?: (percent: number) => void,
  redirectsLeft = 5,
): Promise<void> {
  return new Promise((resolve, reject) => {
    https.get(
      url,
      { headers: { 'User-Agent': 'yCal-Updater' } },
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
    ).on('error', reject);
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
      pendingVersion = null;
      broadcast({ state: 'idle', version: null });
      return;
    }
    const asset = pickAsset(release);
    if (!asset) {
      broadcast({ state: 'idle', version: null });
      return;
    }
    pendingAssetUrl = asset.browser_download_url;
    pendingVersion = tagVersion;
    broadcast({ state: 'available', version: tagVersion, progress: 0 });
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
  execName: string; // e.g. "yCal"
}): string {
  const CB = shQuote(opts.currentBundle);
  const NB = shQuote(opts.newBundle);
  const TR = shQuote(opts.tmpRoot);
  const LF = shQuote(opts.logFile);
  const EN = shQuote(opts.execName);
  return `#!/bin/bash
# yCal update swap helper. Generated by main/updater.ts.
CURRENT_BUNDLE=${CB}
NEW_BUNDLE=${NB}
TMP_ROOT=${TR}
LOG_FILE=${LF}
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
    echo "[ycal-swap] old process gone after \${i}*0.1s"
    break
  fi
  sleep 0.1
done
sleep 0.4

# Move current bundle aside instead of deleting first — if anything goes
# wrong below we can restore it and the user still has a working app.
ASIDE="\${CURRENT_BUNDLE}.previous-$$"
if [ -d "$CURRENT_BUNDLE" ]; then
  if ! mv "$CURRENT_BUNDLE" "$ASIDE"; then
    echo "[ycal-swap] could not move current aside; aborting"
    exit 1
  fi
fi

# Install the new bundle.
if ! mv "$NEW_BUNDLE" "$CURRENT_BUNDLE"; then
  echo "[ycal-swap] install mv failed; restoring previous"
  if [ -d "$ASIDE" ]; then mv "$ASIDE" "$CURRENT_BUNDLE"; fi
  exit 1
fi

# Strip macOS quarantine + any other com.apple.* xattrs Gatekeeper trips on.
xattr -cr "$CURRENT_BUNDLE" || true

# Sanity-check before we toss the backup.
if [ ! -x "$CURRENT_BUNDLE/Contents/MacOS/$EXE_NAME" ]; then
  echo "[ycal-swap] new bundle missing executable; restoring"
  rm -rf "$CURRENT_BUNDLE"
  if [ -d "$ASIDE" ]; then mv "$ASIDE" "$CURRENT_BUNDLE"; fi
  exit 1
fi

# Drop the old bundle now that we're sure the new one is intact.
if [ -d "$ASIDE" ]; then rm -rf "$ASIDE"; fi

echo "[ycal-swap] launching"
open "$CURRENT_BUNDLE"

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
  const zipPath = path.join(tmpRoot, 'app.zip');
  const extractDir = path.join(tmpRoot, 'extract');
  const logFile = path.join(tmpRoot, 'swap.log');
  const swapScript = path.join(tmpRoot, 'swap.sh');

  try {
    await downloadFile(pendingAssetUrl, zipPath, (pct) => {
      // Reserve the last 10% for extract + handoff so the bar doesn't sit
      // at 100% while ditto is still chewing.
      broadcast({ state: 'installing', version, progress: Math.min(Math.round(pct * 0.9), 90) });
    });

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

    const script = buildSwapScript({
      currentBundle,
      newBundle,
      tmpRoot,
      logFile,
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
