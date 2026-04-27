import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { UiSettings } from '@shared/types';

interface Settings {
  weatherIcsUrl: string | null;
  ui: UiSettings;
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
};

const FILE = () => path.join(app.getPath('userData'), 'settings.json');

function cloneDefaults(): Settings {
  return { ...DEFAULTS, ui: { ...DEFAULT_UI } };
}

function read(): Settings {
  const f = FILE();
  if (!existsSync(f)) return cloneDefaults();
  try {
    const parsed = JSON.parse(readFileSync(f, 'utf-8')) as Partial<Settings>;
    return {
      ...DEFAULTS,
      ...parsed,
      ui: { ...DEFAULT_UI, ...(parsed.ui ?? {}) },
    };
  } catch {
    return cloneDefaults();
  }
}

function write(s: Settings): void {
  const f = FILE();
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify(s, null, 2), 'utf-8');
}

export function getWeatherUrl(): string | null {
  return read().weatherIcsUrl;
}

export function setWeatherUrl(url: string | null): void {
  const s = read();
  s.weatherIcsUrl = url && url.trim() ? url.trim() : null;
  write(s);
}

export function getUiSettings(): UiSettings {
  return read().ui;
}

// Patch-merge: callers send only the keys they want to change. Maps merge by
// key (so adding one role doesn't drop existing visibility entries), arrays
// replace wholesale.
export function setUiSettings(patch: Partial<UiSettings>): void {
  const s = read();
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
  if (patch.showWeekNums !== undefined) {
    next.showWeekNums = patch.showWeekNums;
  }
  if (patch.showWeather !== undefined) {
    next.showWeather = patch.showWeather;
  }
  if (patch.units !== undefined) {
    next.units = patch.units;
  }
  s.ui = next;
  write(s);
}
