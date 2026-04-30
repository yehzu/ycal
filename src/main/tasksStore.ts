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
import { readJson, writeJson } from './cloudStore';
import { clearLegacyFields, readLegacyTasks } from './settings';

const FILE = 'tasks-schedule.json';
let migrated = false;

function migrateIfNeeded(): void {
  if (migrated) return;
  migrated = true;
  const legacy = readLegacyTasks();
  if (!legacy) return;
  // If the cloud file already exists with content, prefer it — the user
  // may have already migrated on another device. Just clear settings.json.
  const existing = readJson<TasksLocalState | null>(FILE, null);
  if (existing && (Object.keys(existing.scheduled || {}).length > 0
                || Object.keys(existing.doneOn || {}).length > 0)) {
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
  const raw = readJson<TasksLocalState | null>(FILE, null);
  return {
    scheduled: raw?.scheduled ?? {},
    doneOn: raw?.doneOn ?? {},
    cache: raw?.cache,
    cacheAt: raw?.cacheAt,
  };
}

export function setTasksLocal(patch: Partial<TasksLocalState>): TasksLocalState {
  migrateIfNeeded();
  const cur = getTasksLocal();
  const next: TasksLocalState = {
    scheduled: patch.scheduled ?? cur.scheduled,
    doneOn: patch.doneOn ?? cur.doneOn,
    cache: patch.cache ?? cur.cache,
    cacheAt: patch.cacheAt ?? cur.cacheAt,
  };
  writeJson(FILE, next);
  return next;
}
