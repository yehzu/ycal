import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { CloudStorage, UiSettings } from '@shared/types';

interface Settings {
  weatherIcsUrl: string | null;
  ui: UiSettings;
  // Where rhythm.json + tasks-schedule.json live. iCloud Drive when picked
  // and available; local userData otherwise.
  cloudStorage: CloudStorage;
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
  cloudStorage: 'local',
};

const FILE = (): string => path.join(app.getPath('userData'), 'settings.json');

function cloneDefaults(): Settings {
  return { ...DEFAULTS, ui: { ...DEFAULT_UI } };
}

interface RawSettings extends Partial<Settings> {
  // Legacy fields read for one-shot migration on first launch with the new
  // schema. Removed from disk after migration.
  rhythmStorage?: CloudStorage;
  tasks?: {
    scheduled?: Record<string, { date: string; start: string }>;
    doneOn?: Record<string, string>;
  };
}

function read(): { settings: Settings; legacy: RawSettings } {
  const f = FILE();
  if (!existsSync(f)) return { settings: cloneDefaults(), legacy: {} };
  try {
    const parsed = JSON.parse(readFileSync(f, 'utf-8')) as RawSettings;
    const cloud: CloudStorage =
      parsed.cloudStorage === 'icloud' || parsed.rhythmStorage === 'icloud'
        ? 'icloud'
        : 'local';
    return {
      settings: {
        ...DEFAULTS,
        ...parsed,
        ui: { ...DEFAULT_UI, ...(parsed.ui ?? {}) },
        cloudStorage: cloud,
      },
      legacy: parsed,
    };
  } catch {
    return { settings: cloneDefaults(), legacy: {} };
  }
}

function write(s: Settings): void {
  const f = FILE();
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify(s, null, 2), 'utf-8');
}

export function getWeatherUrl(): string | null {
  return read().settings.weatherIcsUrl;
}

export function setWeatherUrl(url: string | null): void {
  const { settings: s } = read();
  s.weatherIcsUrl = url && url.trim() ? url.trim() : null;
  write(s);
}

export function getUiSettings(): UiSettings {
  return read().settings.ui;
}

export function setUiSettings(patch: Partial<UiSettings>): void {
  const { settings: s } = read();
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
  s.ui = next;
  write(s);
}

export function getCloudStoragePref(): CloudStorage {
  return read().settings.cloudStorage;
}

export function setCloudStoragePref(pref: CloudStorage): void {
  const { settings: s } = read();
  s.cloudStorage = pref;
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
  const { settings: s, legacy } = read();
  if (!legacy.tasks && !legacy.rhythmStorage) return;
  // Re-write without the legacy keys (they only existed in `legacy`).
  write(s);
}
