// RecorderSetup — probe + install the recording-pipeline dependencies.
//
// Trigger story: the Settings → Recording tab calls `getRecorderSetupStatus`
// on open to render the "what's missing" grid, and `runRecorderSetup`
// when the user clicks "Install". The runner streams progress over an
// IPC push channel; the renderer keeps a transcript and updates the
// status grid live.
//
// What we DO install:
//   * Homebrew formulae (ffmpeg, whisper-cpp) via `brew install`.
//   * The whisper ggml model via `curl` (no auth, ~1.5 GB).
//
// What we DON'T install:
//   * Homebrew itself — it's a system-level commitment that should be
//     the user's explicit choice. We tell them what to run instead.
//   * The Claude CLI — it lives outside brew, ships with Claude Code.
//
// Paths are resolved at run time because Apple Silicon brew lives in
// `/opt/homebrew` and Intel brew in `/usr/local`. We also patch the
// child-process PATH so brew + curl can find git, openssl, gpg, etc.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { BrowserWindow } from 'electron';
import { IPC } from '@shared/types';
import type { RecorderSetupProgress, RecorderSetupStatus } from '@shared/types';
import { getModelById } from '@shared/whisperModels';
import { getUserShellPath } from './userShellPath';
import { getUiSettings } from './settings';

const MODELS_DIR = path.join(os.homedir(), '.ycal', 'models');
const TAP_BIN = path.join(os.homedir(), '.ycal', 'bin', 'coreaudio-tap');
const RECORD_SH = path.join(os.homedir(), '.ycal', 'record-meet.sh');
const POST_SH = path.join(os.homedir(), '.ycal', 'post-meet.sh');

// Resolve the user's chosen whisper model into a concrete path + URL.
// Reads the live settings each call so a model swap from Settings →
// Recording takes effect on the very next setup probe / install run.
function activeModel(): { path: string; url: string; sizeBytes: number; id: string } {
  const m = getModelById(getUiSettings().recordingWhisperModel);
  return {
    id: m.id,
    path: path.join(MODELS_DIR, m.filename),
    url: m.url,
    sizeBytes: m.sizeBytes,
  };
}

// Exposed for meetRecorder.postProcess so it can pass YCAL_WHISPER_MODEL
// to post-meet.sh — the script reads the env, falls back to the legacy
// hard-coded path otherwise. Keeps the model selection a one-place
// concern.
export function getActiveModelPath(): string {
  return activeModel().path;
}

// Search prefixes for binaries. Order matters — we prefer brew prefixes
// over /usr/bin because that's where the up-to-date versions live.
const SEARCH_DIRS = [
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/local/bin',
  '/usr/local/sbin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
];

function whichOf(name: string): string | null {
  const seen = new Set<string>();
  // We walk three PATH sources in priority order: our brew-prefix
  // hardcoded list, process.env.PATH (whatever launchd handed us — often
  // stripped), and the user's actual shell PATH discovered via
  // `zsh -ilc 'echo $PATH'` at boot. The third source is the only one
  // that finds tools installed in places like
  // /Applications/cmux.app/Contents/Resources/bin (claude) or
  // ~/.local/bin (user-scoped pipx installs) — anywhere the user's
  // .zshrc / .zprofile reaches.
  const userPath = getUserShellPath();
  const allDirs = [
    ...SEARCH_DIRS,
    ...(process.env.PATH ?? '').split(':'),
    ...(userPath ?? '').split(':'),
  ];
  for (const dir of allDirs) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    const p = path.join(dir, name);
    try {
      const st = fs.statSync(p);
      if (st.isFile() && (st.mode & 0o111)) return p;
    } catch { /* not present, try next */ }
  }
  return null;
}

function fileSize(p: string): number {
  try { return fs.statSync(p).size; } catch { return 0; }
}

export function getRecorderSetupStatus(): RecorderSetupStatus {
  const brew = whichOf('brew');
  const ffmpeg = whichOf('ffmpeg');
  const whisperCli = whichOf('whisper-cli');
  const claude = whichOf('claude');
  const model = activeModel();
  const modelSize = fileSize(model.path);
  // A truncated download is worse than nothing — accept only when the
  // file is within 5% of the expected size. Catches abandoned partials
  // that the user's filesystem might have kept around after a network
  // hiccup or yCal crash.
  const modelOk = modelSize > model.sizeBytes * 0.95;
  const tapOk = (() => {
    try {
      const st = fs.statSync(TAP_BIN);
      return st.isFile() && (st.mode & 0o111) !== 0;
    } catch { return false; }
  })();
  const scriptsOk = fs.existsSync(RECORD_SH) && fs.existsSync(POST_SH);

  return {
    brew: { installed: brew !== null, path: brew },
    ffmpeg: { installed: ffmpeg !== null, path: ffmpeg },
    whisperCli: { installed: whisperCli !== null, path: whisperCli },
    claude: { installed: claude !== null, path: claude },
    whisperModel: { installed: modelOk, path: model.path, sizeBytes: modelSize },
    scripts: { installed: scriptsOk },
    coreaudioTap: { installed: tapOk, path: TAP_BIN },
    ready: ffmpeg !== null && whisperCli !== null && modelOk && tapOk && scriptsOk,
  };
}

// ── Setup runner ────────────────────────────────────────────────────────

let setupInFlight = false;
let mainWindowRef: BrowserWindow | null = null;

export function bindRecorderSetup(win: BrowserWindow): void {
  mainWindowRef = win;
}

function pushProgress(payload: RecorderSetupProgress): void {
  const win = mainWindowRef;
  if (!win || win.isDestroyed()) return;
  try { win.webContents.send(IPC.RecorderSetupProgress, payload); } catch { /* best-effort */ }
}

function streamLine(line: string): void {
  if (!line.trim()) return;
  pushProgress({ phase: 'brew', line });   // phase replaced per-call below
}

// Run an external command with PATH set to the brew dirs so brew can
// shell out to its own helpers. Streams stdout + stderr line-by-line via
// `onLine` so the UI can render incrementally. Resolves with exit code.
function runStreaming(
  cmd: string,
  args: string[],
  onLine: (line: string) => void,
): Promise<{ code: number; ok: boolean }> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: [...SEARCH_DIRS, process.env.PATH ?? ''].filter(Boolean).join(':'),
      // brew is interactive by default — disable analytics prompts +
      // hint suppression to keep output focused on the work.
      HOMEBREW_NO_AUTO_UPDATE: '1',
      HOMEBREW_NO_ANALYTICS: '1',
      HOMEBREW_NO_ENV_HINTS: '1',
      HOMEBREW_NO_INSTALL_CLEANUP: '1',
    };
    const proc = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const decode = (chunk: Buffer): void => {
      const text = chunk.toString();
      for (const line of text.split(/\r?\n/)) {
        if (line) onLine(line);
      }
    };
    proc.stdout.on('data', decode);
    proc.stderr.on('data', decode);
    proc.on('error', (e) => {
      onLine(`error: ${e.message}`);
      resolve({ code: -1, ok: false });
    });
    proc.on('exit', (code) => resolve({ code: code ?? -1, ok: code === 0 }));
  });
}

// Download to a temp file then rename — so a half-completed download
// isn't picked up as "model installed" on the next probe. Reports a
// rough 0..100 percentage based on Content-Length when curl supplies it
// (we count `%` glyphs from --progress-bar output). Uses whichever
// model the user has selected in UiSettings, falling back to the
// large-v3-turbo default.
async function downloadModel(): Promise<{ ok: boolean; error?: string }> {
  const model = activeModel();
  fs.mkdirSync(path.dirname(model.path), { recursive: true });
  const tmp = `${model.path}.partial`;
  const result = await runStreaming(
    '/usr/bin/curl',
    ['-L', '--fail', '--retry', '3', '--retry-delay', '2',
     '--progress-bar', '-o', tmp, model.url],
    (line) => {
      const m = /(\d+(?:\.\d+)?)\s*%/.exec(line);
      const pct = m ? Math.min(100, Math.max(0, parseFloat(m[1]))) : undefined;
      pushProgress({ phase: 'model', line, modelPercent: pct });
    },
  );
  if (!result.ok) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best-effort */ }
    return { ok: false, error: `curl exited with code ${result.code}` };
  }
  try {
    fs.renameSync(tmp, model.path);
  } catch (e) {
    return { ok: false, error: `rename failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  return { ok: true };
}

export async function runRecorderSetup(): Promise<void> {
  if (setupInFlight) {
    pushProgress({ phase: 'error', error: 'setup already in progress' });
    return;
  }
  setupInFlight = true;
  try {
    pushProgress({ phase: 'starting' });

    const status = getRecorderSetupStatus();

    if (!status.brew.installed) {
      const msg = 'Homebrew is not installed. yCal won\'t install it for you — '
        + 'open Terminal and run:\n  /bin/bash -c "$(curl -fsSL '
        + 'https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"';
      pushProgress({ phase: 'error', error: msg });
      return;
    }

    // Step 1: brew install whatever's missing among ffmpeg + whisper-cpp.
    const formulae: string[] = [];
    if (!status.ffmpeg.installed)     formulae.push('ffmpeg');
    if (!status.whisperCli.installed) formulae.push('whisper-cpp');
    if (formulae.length > 0) {
      pushProgress({ phase: 'brew', line: `$ brew install ${formulae.join(' ')}` });
      const brewResult = await runStreaming(
        status.brew.path!,
        ['install', ...formulae],
        (line) => pushProgress({ phase: 'brew', line }),
      );
      if (!brewResult.ok) {
        pushProgress({
          phase: 'error',
          error: `brew install ${formulae.join(' ')} exited with code ${brewResult.code}`,
        });
        return;
      }
    } else {
      pushProgress({ phase: 'brew', line: '(no brew formulae missing)' });
    }

    // Step 2: download whisper model if absent or truncated.
    if (!status.whisperModel.installed) {
      pushProgress({ phase: 'model', line: `Downloading model → ${activeModel().path}` });
      const dl = await downloadModel();
      if (!dl.ok) {
        pushProgress({ phase: 'error', error: dl.error ?? 'model download failed' });
        return;
      }
    } else {
      pushProgress({ phase: 'model', line: '(model already present)' });
    }

    pushProgress({ phase: 'done' });
  } catch (e) {
    pushProgress({
      phase: 'error',
      error: e instanceof Error ? e.message : String(e),
    });
  } finally {
    setupInFlight = false;
  }
}
