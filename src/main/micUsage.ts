// micUsage — asks native/mic-usage whether a browser on this Mac is
// capturing the microphone. The activeMeet detector pairs this with the
// Meet-tab probe: the tab says a meeting page exists, the mic says
// somebody is actually in the call here (see browserCapturingMic).
//
// The binary is mirrored into ~/.ycal/bin by meetRecorder's
// ensureHelpersInstalled, like coreaudio-tap. Missing binary, pre-14
// macOS, a timeout or unparseable output all answer null, and the
// detector falls back to the tab-only signal it used before.

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { browserCapturingMic, type AudioProcess } from '@shared/activeMeetPresence';

export const MIC_USAGE_BIN = path.join(os.homedir(), '.ycal', 'bin', 'mic-usage');

export function listAudioProcesses(): Promise<AudioProcess[] | null> {
  if (!fs.existsSync(MIC_USAGE_BIN)) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(MIC_USAGE_BIN, [], { timeout: 3_000 }, (err, stdout) => {
      if (err) { resolve(null); return; }
      try {
        const parsed = JSON.parse(String(stdout)) as { processes?: AudioProcess[] };
        resolve(Array.isArray(parsed.processes) ? parsed.processes : null);
      } catch {
        resolve(null);
      }
    });
  });
}

/** true / false from the probe, null when it couldn't answer. */
export async function probeBrowserMic(): Promise<boolean | null> {
  const procs = await listAudioProcesses();
  return procs === null ? null : browserCapturingMic(procs);
}
