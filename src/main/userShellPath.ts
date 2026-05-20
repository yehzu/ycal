// Discover the PATH a real Terminal user would see, even though our
// Electron process is launched from /Applications and inherits a
// stripped launchd PATH (`/usr/bin:/bin:/usr/sbin:/sbin`).
//
// Symptom this fixes: probes for tools like `claude` (installed at
// non-standard places like /Applications/cmux.app/Contents/Resources/bin)
// or `ffmpeg`/`whisper-cli` (in /opt/homebrew/bin) come back empty even
// though they're plainly on the user's shell PATH. Same problem the
// HOMEBREW_BIN_DIRS hack patches, but applied broadly — anything the
// user reaches from zsh/bash, yCal can now reach too.
//
// Spawned once at boot via `/bin/zsh -ilc 'echo $PATH'`. -i = interactive
// (loads .zshrc), -l = login (loads .zprofile / path_helper). The full
// resolved PATH gets cached for the rest of the process lifetime.

import { execFileSync } from 'node:child_process';
import os from 'node:os';

let cached: string | null = null;
let probed = false;

export function getUserShellPath(): string | null {
  if (probed) return cached;
  probed = true;
  if (process.platform !== 'darwin') return null;
  // Try the user's login shell, falling back to /bin/zsh (macOS default
  // since Catalina). SHELL env is set by launchd from the user record.
  const shells = [process.env.SHELL || '', '/bin/zsh', '/bin/bash'].filter(Boolean);
  for (const sh of shells) {
    try {
      const out = execFileSync(sh, ['-ilc', 'echo "$PATH"'], {
        encoding: 'utf8',
        timeout: 4000,
        env: { HOME: os.homedir(), USER: process.env.USER || '' },
      }).trim();
      if (out && out.includes('/')) { cached = out; return cached; }
    } catch { /* try next shell */ }
  }
  return null;
}
