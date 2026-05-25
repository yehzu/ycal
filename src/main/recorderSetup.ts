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
const DIARIZE_VENV = path.join(os.homedir(), '.ycal', 'diarize-venv');
const DIARIZE_VENV_PY = path.join(DIARIZE_VENV, 'bin', 'python');

// Dependency stack for diarization. pyannote.audio 4.x uses the newer
// speaker-diarization-community-1 model (better accuracy than 3.1 in our
// PoC) and works with the latest torch + huggingface_hub — no version
// pins needed. Validated 2026-05-25 on Python 3.12.
const DIARIZE_PINS = [
  'pyannote.audio>=4.0',
  'torch',
  'torchaudio',
];

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

// Find a system Python suitable for the diarize venv. pyannote 3.x +
// torch <2.6 wheels exist for 3.10–3.12. 3.13+ doesn't have matching
// wheels yet; 3.9 is below pyannote's floor.
//
// Pyenv quirk: ~/.pyenv/shims/python3.X is a dispatch script that only
// works when that version is in `pyenv global` or `pyenv local`. A user
// who has 3.12.10 installed but pyenv global'd to 3.8 will see the
// shim file exist (whichOf finds it) but execution returns
// "pyenv: python3.12: command not found". So we prefer the REAL binary
// inside ~/.pyenv/versions/3.12.X/bin/python3.12 over the shim, and
// verify shims with a quick `--version` probe before accepting them.
function findCompatiblePython(): string | null {
  for (const v of ['3.12', '3.11', '3.10']) {
    const p = findPythonByMinor(v);
    if (p) return p;
  }
  // Generic `python3` last — only acceptable if it actually runs and
  // reports a version in our supported range.
  const generic = whichOf('python3');
  if (generic && verifyPythonVersion(generic, ['3.10', '3.11', '3.12'])) {
    return generic;
  }
  return null;
}

// Look for a `python3.<minor>` install, preferring direct binaries over
// pyenv shims so users with multiple versions installed but a different
// `pyenv global` setting still get a working venv.
function findPythonByMinor(minor: string): string | null {
  // 1. Direct pyenv version binaries — bypass the shim entirely.
  try {
    const versionsDir = path.join(os.homedir(), '.pyenv', 'versions');
    const versions = fs.readdirSync(versionsDir).sort().reverse();
    for (const v of versions) {
      if (!v.startsWith(`${minor}.`)) continue;
      const real = path.join(versionsDir, v, 'bin', `python${minor}`);
      try {
        const st = fs.statSync(real);
        if (st.isFile() && (st.mode & 0o111)) return real;
      } catch { /* keep looking */ }
    }
  } catch { /* no pyenv */ }

  // 2. Homebrew / system: `which python3.X` then verify it executes.
  const found = whichOf(`python${minor}`);
  if (found && verifyPythonVersion(found, [minor])) {
    return found;
  }
  return null;
}

// Run `<python> --version` and return true if it matches one of the
// allowed minor versions. Catches pyenv shims dispatching to a missing
// install (the shim file exists but `--version` exits non-zero).
function verifyPythonVersion(pythonPath: string, allowedMinors: string[]): boolean {
  try {
    const out = require('node:child_process').execFileSync(
      pythonPath,
      ['--version'],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 3000 },
    );
    const m = /Python\s+3\.(\d+)/.exec(out);
    if (!m) return false;
    return allowedMinors.some((mn) => mn === `3.${m[1]}`);
  } catch {
    return false;
  }
}

function diarizeVenvOk(): boolean {
  try {
    const st = fs.statSync(DIARIZE_VENV_PY);
    if (!st.isFile() || !(st.mode & 0o111)) return false;
  } catch { return false; }
  // Cheap structural check — pyannote.audio's __init__.py presence.
  // Avoid spawning the venv to import; that would slow probe by ~3s.
  // The full install path writes a sentinel file when done; rely on that.
  return fs.existsSync(path.join(DIARIZE_VENV, '.ycal-diarize-ready'));
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
  const diarizeOk = diarizeVenvOk();

  return {
    brew: { installed: brew !== null, path: brew },
    ffmpeg: { installed: ffmpeg !== null, path: ffmpeg },
    whisperCli: { installed: whisperCli !== null, path: whisperCli },
    claude: { installed: claude !== null, path: claude },
    whisperModel: { installed: modelOk, path: model.path, sizeBytes: modelSize },
    scripts: { installed: scriptsOk },
    coreaudioTap: { installed: tapOk, path: TAP_BIN },
    diarizeVenv: {
      installed: diarizeOk,
      venvPath: DIARIZE_VENV,
      pythonPath: findCompatiblePython(),
    },
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

// Build the diarize venv: create it from a compatible system Python,
// install the pinned pyannote/torch/huggingface_hub stack, then drop a
// sentinel marker so the next status probe sees it as ready. Runs in
// the same in-flight gate as runRecorderSetup so the UI can't kick
// both at once.
export async function runDiarizeSetup(): Promise<void> {
  if (setupInFlight) {
    pushProgress({ phase: 'error', error: 'setup already in progress' });
    return;
  }
  setupInFlight = true;
  try {
    pushProgress({ phase: 'starting', line: 'Setting up diarization venv…' });

    const py = findCompatiblePython();
    if (!py) {
      pushProgress({
        phase: 'error',
        error:
          'No compatible Python found. pyannote.audio requires Python 3.10–3.12.\n' +
          'Install via Homebrew:  brew install python@3.12',
      });
      return;
    }

    pushProgress({ phase: 'diarize', line: `Using Python: ${py}` });

    // Step 1: create venv if missing.
    if (!fs.existsSync(DIARIZE_VENV_PY)) {
      pushProgress({ phase: 'diarize', line: `$ ${py} -m venv ${DIARIZE_VENV}` });
      const venv = await runStreaming(
        py,
        ['-m', 'venv', DIARIZE_VENV],
        (line) => pushProgress({ phase: 'diarize', line }),
      );
      if (!venv.ok) {
        pushProgress({
          phase: 'error',
          error: `venv creation failed (exit ${venv.code})`,
        });
        return;
      }
    } else {
      pushProgress({ phase: 'diarize', line: '(venv directory already present)' });
    }

    // Step 2: upgrade pip (keeps install logs short).
    const pip = path.join(DIARIZE_VENV, 'bin', 'pip');
    pushProgress({ phase: 'diarize', line: '$ pip install --upgrade pip' });
    const upgrade = await runStreaming(
      pip,
      ['install', '--upgrade', 'pip'],
      (line) => pushProgress({ phase: 'diarize', line }),
    );
    if (!upgrade.ok) {
      pushProgress({
        phase: 'error',
        error: `pip upgrade failed (exit ${upgrade.code})`,
      });
      return;
    }

    // Step 3: install pinned stack. ~1.5GB download for torch.
    pushProgress({
      phase: 'diarize',
      line: `$ pip install ${DIARIZE_PINS.join(' ')}  (downloads ~1.5GB)`,
    });
    const install = await runStreaming(
      pip,
      ['install', ...DIARIZE_PINS],
      (line) => pushProgress({ phase: 'diarize', line }),
    );
    if (!install.ok) {
      pushProgress({
        phase: 'error',
        error: `pyannote/torch install failed (exit ${install.code})`,
      });
      return;
    }

    // Step 4: import smoke test — catches broken wheels before the
    // user's first recording fails halfway through.
    pushProgress({ phase: 'diarize', line: 'verifying pyannote.audio import…' });
    const smoke = await runStreaming(
      DIARIZE_VENV_PY,
      ['-c', 'import pyannote.audio; import torch; print("ok", pyannote.audio.__version__, torch.__version__)'],
      (line) => pushProgress({ phase: 'diarize', line }),
    );
    if (!smoke.ok) {
      pushProgress({
        phase: 'error',
        error: `pyannote.audio import failed after install (exit ${smoke.code}). Check the log above.`,
      });
      return;
    }

    // Step 5: drop sentinel.
    try {
      fs.writeFileSync(
        path.join(DIARIZE_VENV, '.ycal-diarize-ready'),
        `${new Date().toISOString()}\nPython: ${py}\n${DIARIZE_PINS.join('\n')}\n`,
      );
    } catch (e) {
      pushProgress({
        phase: 'error',
        error: `sentinel write failed: ${e instanceof Error ? e.message : String(e)}`,
      });
      return;
    }

    pushProgress({ phase: 'done', line: 'Diarization environment ready.' });
  } catch (e) {
    pushProgress({
      phase: 'error',
      error: e instanceof Error ? e.message : String(e),
    });
  } finally {
    setupInFlight = false;
  }
}

// Path resolvers for callers (meetRecorder.postProcess passes them as
// env to post-meet.sh so the shell can decide whether to run diarize).
export function getDiarizeVenvPython(): string {
  return DIARIZE_VENV_PY;
}

export function isDiarizeVenvReady(): boolean {
  return diarizeVenvOk();
}
