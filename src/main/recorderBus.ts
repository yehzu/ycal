// Small in-process bus that decouples the meetRecorder + tray modules.
//
// Why this exists: meetRecorder needs to notify the tray when recordings
// start/stop so the menubar can flip its title to "● Recording", and the
// tray needs to read the current recordings list when building its
// dropdown. Wiring those two via direct imports creates a cycle
// (meetRecorder → tray; tray → meetRecorder) that ES modules resolve
// with `undefined` exports at module-load time, which manifests as
// crashes on first use.
//
// Both modules import this bus instead. meetRecorder pushes the live
// list via `setRecordings`; the tray reads via `getRecordings` and
// subscribes to changes via `onChange` so it can refresh on transitions
// without waiting for its 60s poll.

import type { RecordingStatus } from '@shared/types';

let current: RecordingStatus[] = [];
const listeners = new Set<() => void>();

export function setRecordings(next: RecordingStatus[]): void {
  current = next;
  for (const fn of listeners) {
    try { fn(); } catch (e) { console.error('[recorderBus] listener threw', e); }
  }
}

export function getRecordings(): RecordingStatus[] {
  return current;
}

export function onRecordingsChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
