// yCal — settings.json (now cloud-routed).
//
// Holds UI preferences, calendar visibility, weather URL, and the active
// task provider id. The file lives wherever cloudStore points us — userData
// on a "Local" device, iCloud Drive on a synced one — so the same prefs
// follow the user across Macs.
//
// What does NOT live here:
//   * `cloudStorage` itself — that lives in `device.json` (per-device) so
//     we can read settings.json from the right location without circular
//     bootstrapping. Old builds wrote `cloudStorage` to settings.json; we
//     migrate it on first read after upgrade and drop it from the file.
//   * Encrypted credentials (Google OAuth, Todoist key) — those are device-
//     local by construction. safeStorage keys don't survive across Macs.

import type { CloudStorage, TaskProviderId, UiSettings } from '@shared/types';
import { adoptLegacyCloudPref } from './device';
import { readJsonStrict, writeJson } from './cloudStore';

const FILE = 'settings.json';

interface Settings {
  weatherIcsUrl: string | null;
  ui: UiSettings;
  // Active task provider — Todoist by default. Switching providers is a
  // user action; the renderer offers a dropdown in Settings → Tasks.
  taskProviderId: TaskProviderId;
}

const DEFAULT_UI: UiSettings = {
  accountsActive: {},
  calVisible: {},
  calRoles: {},
  sectionOrder: ['almanac', 'agenda', 'calendars'],
};

const DEFAULTS: Settings = {
  weatherIcsUrl: null,
  ui: DEFAULT_UI,
  taskProviderId: 'todoist',
};

function cloneDefaults(): Settings {
  return { ...DEFAULTS, ui: { ...DEFAULT_UI } };
}

interface RawSettings extends Partial<Settings> {
  // Legacy fields read for one-shot migration. Removed from disk after.
  rhythmStorage?: CloudStorage;
  cloudStorage?: CloudStorage;
  tasks?: {
    scheduled?: Record<string, { date: string; start: string }>;
    doneOn?: Record<string, string>;
  };
}

let migratedLegacyCloudPref = false;

// `corrupt` is true when the file existed but couldn't be parsed (iCloud
// Drive sometimes briefly serves a 0-byte placeholder during sync). All
// setters refuse to write in this state — otherwise they merge fresh
// defaults into a corrupt-read view and silently clobber the user's
// real on-disk data. `missing` (first-run / never-written) is fine:
// callers can write a fresh defaults file from scratch.
function read(): { settings: Settings; legacy: RawSettings; corrupt: boolean } {
  const result = readJsonStrict<RawSettings>(FILE);
  if (result.status === 'missing' || !result.data) {
    return {
      settings: cloneDefaults(),
      legacy: {},
      corrupt: result.status === 'corrupt',
    };
  }
  const raw = result.data;
  // First-time-after-upgrade: lift cloudStorage out of settings.json and
  // into the per-device file. Idempotent — adoptLegacyCloudPref no-ops when
  // device.json already exists.
  if (!migratedLegacyCloudPref) {
    migratedLegacyCloudPref = true;
    if (raw.cloudStorage) {
      adoptLegacyCloudPref(raw.cloudStorage);
    } else if (raw.rhythmStorage) {
      adoptLegacyCloudPref(raw.rhythmStorage);
    }
  }
  // Construct settings explicitly — do NOT spread `raw`, or legacy
  // fields (cloudStorage / rhythmStorage / tasks) hitch a ride and
  // every write re-persists them, defeating clearLegacyFields. Pull
  // only the fields that belong to the current schema.
  return {
    settings: {
      weatherIcsUrl: typeof raw.weatherIcsUrl === 'string' || raw.weatherIcsUrl === null
        ? raw.weatherIcsUrl
        : null,
      ui: { ...DEFAULT_UI, ...(raw.ui ?? {}) },
      taskProviderId: raw.taskProviderId === 'markdown' ? 'markdown' : 'todoist',
    },
    legacy: raw,
    corrupt: false,
  };
}

function write(s: Settings): void {
  writeJson<Settings>(FILE, s);
}

function abortIfCorrupt(corrupt: boolean, op: string): boolean {
  if (!corrupt) return false;
  console.warn(
    `[yCal] ${op} aborted — settings.json unreadable right now ` +
    '(iCloud may be syncing). Keeping current on-disk state.',
  );
  return true;
}

export function getWeatherUrl(): string | null {
  return read().settings.weatherIcsUrl;
}

export function setWeatherUrl(url: string | null): void {
  const { settings: s, corrupt } = read();
  if (abortIfCorrupt(corrupt, 'setWeatherUrl')) return;
  s.weatherIcsUrl = url && url.trim() ? url.trim() : null;
  write(s);
}

export function getUiSettings(): UiSettings {
  return read().settings.ui;
}

export function setUiSettings(patch: Partial<UiSettings>): void {
  const { settings: s, corrupt } = read();
  if (abortIfCorrupt(corrupt, 'setUiSettings')) return;
  const next: UiSettings = { ...s.ui };
  if (patch.accountsActive) {
    next.accountsActive = { ...next.accountsActive, ...patch.accountsActive };
  }
  if (patch.calVisible) {
    next.calVisible = { ...next.calVisible, ...patch.calVisible };
  }
  if (patch.calRoles) {
    next.calRoles = { ...next.calRoles, ...patch.calRoles };
  }
  if (patch.sectionOrder) {
    next.sectionOrder = patch.sectionOrder.slice();
  }
  if (patch.mergeCriteria) {
    next.mergeCriteria = { ...patch.mergeCriteria };
  }
  if (patch.showWeekNums !== undefined) next.showWeekNums = patch.showWeekNums;
  if (patch.showWeather !== undefined) next.showWeather = patch.showWeather;
  if (patch.units !== undefined) next.units = patch.units;
  if (patch.hideDisabledCals !== undefined) next.hideDisabledCals = patch.hideDisabledCals;
  if (patch.autoRolloverPastTasks !== undefined) {
    next.autoRolloverPastTasks = patch.autoRolloverPastTasks;
  }
  if (patch.loadWindow !== undefined) next.loadWindow = patch.loadWindow;
  if (patch.loadBands !== undefined) next.loadBands = patch.loadBands;
  if (patch.theme !== undefined) next.theme = patch.theme;
  s.ui = next;
  write(s);
}

export function getTaskProviderId(): TaskProviderId {
  return read().settings.taskProviderId;
}

// Single read for the cross-device sync push payload. Returns null when
// settings.json is currently corrupt (parse failed), so the watcher
// handler can skip the broadcast instead of pushing fresh DEFAULTS to
// the renderer — which would wipe the user's in-memory visibility maps.
export function getSettingsSnapshotStrict(): {
  ui: UiSettings; weatherIcsUrl: string | null; taskProviderId: TaskProviderId;
} | null {
  const { settings, corrupt } = read();
  if (corrupt) return null;
  return {
    ui: settings.ui,
    weatherIcsUrl: settings.weatherIcsUrl,
    taskProviderId: settings.taskProviderId,
  };
}

export function setTaskProviderId(id: TaskProviderId): void {
  const { settings: s, corrupt } = read();
  if (abortIfCorrupt(corrupt, 'setTaskProviderId')) return;
  s.taskProviderId = id;
  write(s);
}

// Legacy bridge: returns any pre-migration `tasks` block from settings.json.
// Caller (tasksStore) consumes this once, then the next save scrubs the
// settings.json file of legacy fields.
export function readLegacyTasks(): {
  scheduled: Record<string, { date: string; start: string }>;
  doneOn: Record<string, string>;
} | null {
  const { legacy } = read();
  if (!legacy.tasks) return null;
  return {
    scheduled: legacy.tasks.scheduled ?? {},
    doneOn: legacy.tasks.doneOn ?? {},
  };
}

export function clearLegacyFields(): void {
  const { settings: s, legacy, corrupt } = read();
  if (abortIfCorrupt(corrupt, 'clearLegacyFields')) return;
  if (!legacy.tasks && !legacy.rhythmStorage && !legacy.cloudStorage) return;
  // Re-write without the legacy keys (they only existed in `legacy`).
  write(s);
}
