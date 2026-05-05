// yCal — local task overlay (schedule + done state) backed by cloud store.
//
// What lives here:
//   * `scheduled[id] = { date, start }` — where the user dropped a task on
//     the calendar. This is intentionally local + iCloud-mirrored — it is
//     NEVER pushed back to the source provider (Todoist), because users
//     want to schedule things in yCal without rewriting Todoist's `due`.
//   * `doneOn[id] = 'YYYY-MM-DD'` — local mirror of "user marked it done
//     today" so the panel's "Done today · N" footer works without a fresh
//     fetch. The provider gets the canonical close call when the user
//     toggles done, so the truth is still upstream.
//
// On first run with the new schema we migrate any pre-existing data out of
// settings.json into tasks-schedule.json (cloud) and scrub the legacy keys.

import type { TasksLocalState } from '@shared/types';
import { readJsonStrict, writeJson } from './cloudStore';
import { clearLegacyFields, readLegacyTasks } from './settings';

const FILE = 'tasks-schedule.json';
let migrated = false;

// How long we keep a chip on the calendar grid after a task is closed.
// Anything older is pruned at write time so the file doesn't grow forever.
const COMPLETED_RETAIN_DAYS = 30;

function isoDateMinusDays(days: number): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function pruneCompleted(
  completed: TasksLocalState['completed'],
): TasksLocalState['completed'] {
  if (!completed) return completed;
  const cutoff = isoDateMinusDays(COMPLETED_RETAIN_DAYS);
  const out: NonNullable<TasksLocalState['completed']> = {};
  let dropped = false;
  for (const [id, entry] of Object.entries(completed)) {
    if (entry.completedOn >= cutoff) out[id] = entry;
    else dropped = true;
  }
  if (!dropped) return completed;
  return out;
}

// `corrupt` mirrors the same defense used in settings.ts / rhythm.ts:
// when iCloud Drive briefly serves a 0-byte placeholder during sync, a
// blind write would clobber the user's real schedule with an empty map.
function readStrict(): { data: TasksLocalState; corrupt: boolean } {
  const result = readJsonStrict<TasksLocalState>(FILE);
  if (result.status === 'missing' || !result.data) {
    return {
      data: { scheduled: {}, doneOn: {} },
      corrupt: result.status === 'corrupt',
    };
  }
  const raw = result.data;
  return {
    data: {
      scheduled: raw.scheduled ?? {},
      doneOn: raw.doneOn ?? {},
      cache: raw.cache,
      cacheAt: raw.cacheAt,
      completed: raw.completed,
    },
    corrupt: false,
  };
}

function migrateIfNeeded(): void {
  if (migrated) return;
  migrated = true;
  const legacy = readLegacyTasks();
  if (!legacy) return;
  // If the cloud file already exists with content, prefer it — the user
  // may have already migrated on another device. Just clear settings.json.
  const { data: existing, corrupt } = readStrict();
  if (corrupt) return; // never clobber on a transient bad read
  if (Object.keys(existing.scheduled).length > 0
      || Object.keys(existing.doneOn).length > 0) {
    clearLegacyFields();
    return;
  }
  const next: TasksLocalState = {
    scheduled: legacy.scheduled,
    doneOn: legacy.doneOn,
  };
  writeJson(FILE, next);
  clearLegacyFields();
}

export function getTasksLocal(): TasksLocalState {
  migrateIfNeeded();
  return readStrict().data;
}

export function setTasksLocal(patch: Partial<TasksLocalState>): TasksLocalState {
  migrateIfNeeded();
  const { data: cur, corrupt } = readStrict();
  if (corrupt) {
    console.warn(
      '[yCal] setTasksLocal aborted — tasks-schedule.json unreadable ' +
      'right now (iCloud may be syncing). Keeping current on-disk state.',
    );
    return cur;
  }
  const next: TasksLocalState = {
    scheduled: patch.scheduled ?? cur.scheduled,
    doneOn: patch.doneOn ?? cur.doneOn,
    cache: patch.cache ?? cur.cache,
    cacheAt: patch.cacheAt ?? cur.cacheAt,
    completed: pruneCompleted(patch.completed ?? cur.completed),
  };
  // Dedupe excluding cacheAt — every TasksList poll bumps cacheAt even
  // when nothing else changed, which would otherwise echo across Macs
  // every 5 minutes via the cloud watcher. cloudStore.writeJson dedupes
  // by full body too, but with cacheAt updated the body would always
  // differ. Skip the write here when only cacheAt would change.
  if (
    JSON.stringify({ ...cur, cacheAt: undefined }) ===
      JSON.stringify({ ...next, cacheAt: undefined })
  ) {
    return cur;
  }
  writeJson(FILE, next);
  return next;
}
