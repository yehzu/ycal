// The dotted-key view of settings.json that `ycal config` reads and writes.
//
// settings.json nests some prefs (`recorderDiarize.enabled`,
// `loadWindow.startMin`), and `setUiSettings` only accepts whole-object
// patches for most of them. This registry is the one place that knows how
// to turn `ycal config set loadWindow.startMin 480` into a patch that keeps
// the sibling fields, and what a legal value for each key is.
//
// It is deliberately a closed list. A key that is not here is an error, not
// a new field silently written into settings.json — a typo such as
// `recorderDiarize.enable` would otherwise "succeed" and change nothing.
// The per-account / per-calendar maps (`accountsActive`, `calVisible`,
// `calRoles`) and the list-valued prefs stay GUI-only: their keys are opaque
// ids, and a CLI that sets them one entry at a time would invite exactly the
// wholesale-replace bugs the renderer has already been bitten by.
//
// Defaults mirror the renderer's (`App.tsx` initial state), so `config get`
// reports the value the app actually runs with when the file has no entry.
//
// Secrets: a key marked `secret` (or whose name looks like a credential) is
// NEVER printed. `list` / `get` report only whether it is set and its length.

import type { UiSettings } from '@shared/types';
import {
  DEFAULT_LOAD_BANDS, DEFAULT_LOAD_WINDOW, DEFAULT_MERGE_CRITERIA,
} from '@shared/types';
import { DEFAULT_WHISPER_MODEL_ID, WHISPER_MODELS } from '@shared/whisperModels';

export type ConfigValue = boolean | number | string | null;

export interface ConfigSnapshot {
  ui: UiSettings;
  weatherIcsUrl: string | null;
}

// A write the caller applies through the same setters the GUI uses:
// `ui` → setUiSettings(patch), `weatherIcsUrl` → setWeatherUrl.
export interface ConfigPatch {
  ui?: Partial<UiSettings>;
  weatherIcsUrl?: string | null;
}

type KeyType = 'boolean' | 'number' | 'string' | 'enum';

export interface ConfigKeyDef {
  key: string;
  type: KeyType;
  description: string;
  default: ConfigValue;
  choices?: readonly string[];
  min?: number;
  max?: number;
  integer?: boolean;
  // Empty string clears the value (stored as null / removed).
  nullable?: boolean;
  // Trim surrounding whitespace before storing (the setter does too).
  trim?: boolean;
  secret?: boolean;
  // Stored value, or undefined when settings.json has no entry.
  read(s: ConfigSnapshot): ConfigValue | undefined;
  patch(s: ConfigSnapshot, v: ConfigValue): ConfigPatch;
  // Cross-field check run on the would-be result; returns an error or null.
  check?(s: ConfigSnapshot, v: ConfigValue): string | null;
}

// Belt and braces for the `secret` flag: anything named like a credential is
// masked even if a future entry forgets to set it.
const SECRET_NAME = /token|secret|password|passwd|api[-_]?key|credential/i;

export function isSecretKey(def: ConfigKeyDef): boolean {
  return def.secret === true || SECRET_NAME.test(def.key);
}

function uiScalar<K extends keyof UiSettings>(
  key: K,
  type: KeyType,
  dflt: ConfigValue,
  description: string,
  extra: Partial<ConfigKeyDef> = {},
): ConfigKeyDef {
  return {
    key,
    type,
    default: dflt,
    description,
    ...extra,
    read: (s) => s.ui[key] as ConfigValue | undefined,
    patch: (_s, v) => ({ ui: { [key]: v } as Partial<UiSettings> }),
  };
}

const THEMES = ['system', 'light', 'dark'] as const;

export const CONFIG_KEYS: ConfigKeyDef[] = [
  // ── Display ─────────────────────────────────────────────────────────
  uiScalar('theme', 'enum', 'system', 'Colour scheme.', { choices: THEMES }),
  uiScalar('showWeekNums', 'boolean', true, 'Show ISO week numbers.'),
  uiScalar('showWeather', 'boolean', true, 'Show weather on each date.'),
  uiScalar('units', 'enum', 'F', 'Temperature units.', { choices: ['F', 'C'] }),
  uiScalar('hideReadOnly', 'boolean', false,
    'Hide read-only (subscribed) and Team OOO calendars.'),
  uiScalar('hideDisabledCals', 'boolean', false,
    'Hide calendar rows toggled off in the sidebar.'),
  uiScalar('autoRolloverPastTasks', 'boolean', true,
    'Return unfinished past-scheduled tasks to the inbox.'),
  ...(['matchEnd', 'matchAllDay'] as const).map((field): ConfigKeyDef => ({
    key: `mergeCriteria.${field}`,
    type: 'boolean',
    default: DEFAULT_MERGE_CRITERIA[field],
    description: field === 'matchEnd'
      ? 'Duplicate merge also requires the same end time.'
      : 'Duplicate merge also requires the same all-day flag.',
    read: (s) => s.ui.mergeCriteria?.[field],
    patch: (s, v) => ({
      ui: {
        mergeCriteria: {
          ...DEFAULT_MERGE_CRITERIA, ...(s.ui.mergeCriteria ?? {}), [field]: v as boolean,
        },
      },
    }),
  })),

  // ── Day-load gauge ──────────────────────────────────────────────────
  {
    key: 'loadWindow.mode',
    type: 'enum',
    choices: ['fixed', 'rhythm'],
    default: DEFAULT_LOAD_WINDOW.mode,
    description: 'Day-load window: fixed hours, or wake → sleep rhythm.',
    read: (s) => s.ui.loadWindow?.mode,
    patch: (s, v) => ({
      ui: { loadWindow: { ...DEFAULT_LOAD_WINDOW, ...(s.ui.loadWindow ?? {}), mode: v as 'fixed' | 'rhythm' } },
    }),
  },
  ...(['startMin', 'endMin'] as const).map((field): ConfigKeyDef => ({
    key: `loadWindow.${field}`,
    type: 'number',
    integer: true,
    min: 0,
    max: 1440,
    default: DEFAULT_LOAD_WINDOW[field],
    description: field === 'startMin'
      ? 'Fixed day-load window start, minutes from midnight.'
      : 'Fixed day-load window end, minutes from midnight.',
    read: (s) => s.ui.loadWindow?.[field],
    patch: (s, v) => ({
      ui: { loadWindow: { ...DEFAULT_LOAD_WINDOW, ...(s.ui.loadWindow ?? {}), [field]: v as number } },
    }),
    check: (s, v) => {
      const w = { ...DEFAULT_LOAD_WINDOW, ...(s.ui.loadWindow ?? {}), [field]: v as number };
      return w.startMin < w.endMin
        ? null
        : `loadWindow.startMin (${w.startMin}) must be before loadWindow.endMin (${w.endMin})`;
    },
  })),
  ...(['calmMax', 'steadyMax', 'fullMax'] as const).map((field): ConfigKeyDef => ({
    key: `loadBands.${field}`,
    type: 'number',
    min: 0,
    max: 24,
    default: DEFAULT_LOAD_BANDS[field],
    description: `Day-load band threshold, equivalent meeting hours (${field}).`,
    read: (s) => s.ui.loadBands?.[field],
    patch: (s, v) => ({
      ui: { loadBands: { ...DEFAULT_LOAD_BANDS, ...(s.ui.loadBands ?? {}), [field]: v as number } },
    }),
    // Same rule the Settings modal enforces (LoadBandsEditor.commit):
    // 0 < calmMax < steadyMax < fullMax, judged on the whole triple as it
    // would be stored. Raising all three means writing fullMax first.
    check: (s, v) => {
      const b = { ...DEFAULT_LOAD_BANDS, ...(s.ui.loadBands ?? {}), [field]: v as number };
      const broken: string[] = [];
      if (!(b.calmMax > 0)) {
        broken.push(`loadBands.calmMax (${b.calmMax}) must be greater than 0`);
      }
      if (!(b.calmMax < b.steadyMax)) {
        broken.push(`loadBands.calmMax (${b.calmMax}) must be below loadBands.steadyMax (${b.steadyMax})`);
      }
      if (!(b.steadyMax < b.fullMax)) {
        broken.push(`loadBands.steadyMax (${b.steadyMax}) must be below loadBands.fullMax (${b.fullMax})`);
      }
      return broken.length === 0 ? null : broken.join('; ');
    },
  })),

  // ── Recording ───────────────────────────────────────────────────────
  uiScalar('autoRecordMeetings', 'boolean', false, 'Auto-record meetings that have a Meet link.'),
  uiScalar('recordingTrigger', 'enum', 'calendar',
    'What starts/stops auto-record: calendar times, or an open Meet window.',
    { choices: ['calendar', 'activeMeet'] }),
  uiScalar('recordingConfirmBeforeStart', 'boolean', false,
    'Ask before auto-record starts (calendar trigger only).'),
  uiScalar('recordingWhisperModel', 'enum', DEFAULT_WHISPER_MODEL_ID,
    'whisper.cpp model used for transcription.',
    { choices: WHISPER_MODELS.map((m) => m.id) }),
  uiScalar('recordingUploadAudio', 'boolean', true,
    'Upload the .m4a to Drive alongside transcript + summary.'),
  uiScalar('recordingVoiceProcessing', 'boolean', false,
    'Capture the mic through Apple voice processing (echo cancellation).'),
  {
    key: 'recordingSummaryPrompt',
    type: 'string',
    nullable: true,
    default: null,
    description: 'Custom summary prompt. Empty string restores the built-in one.',
    read: (s) => s.ui.recordingSummaryPrompt,
    // setUiSettings maps '' to "unset", which is what clearing means here.
    patch: (_s, v) => ({ ui: { recordingSummaryPrompt: (v as string | null) ?? '' } }),
  },
  {
    key: 'recorderDiarize.enabled',
    type: 'boolean',
    default: false,
    description: 'Speaker diarization (needs the diarize venv: `ycal recorder setup`).',
    read: (s) => s.ui.recorderDiarize?.enabled,
    patch: (s, v) => ({
      ui: {
        recorderDiarize: {
          enabled: v as boolean,
          hfToken: s.ui.recorderDiarize?.hfToken ?? null,
        },
      },
    }),
  },
  {
    key: 'recorderDiarize.hfToken',
    type: 'string',
    nullable: true,
    secret: true,
    default: null,
    description: 'Legacy Hugging Face token (pyannote era; unread since Nemotron).',
    read: (s) => s.ui.recorderDiarize?.hfToken,
    patch: (s, v) => ({
      ui: {
        recorderDiarize: {
          enabled: s.ui.recorderDiarize?.enabled ?? false,
          hfToken: (v as string | null),
        },
      },
    }),
  },

  // ── Top-level ───────────────────────────────────────────────────────
  {
    key: 'weatherIcsUrl',
    type: 'string',
    nullable: true,
    trim: true,
    // Feed URLs routinely carry an access key in the query string.
    secret: true,
    default: null,
    description: 'Weather iCal feed URL. Empty string removes it.',
    read: (s) => s.weatherIcsUrl,
    patch: (_s, v) => ({ weatherIcsUrl: (v as string | null) }),
  },
];

const BY_KEY = new Map(CONFIG_KEYS.map((d) => [d.key, d]));

// Resolve a key or explain why it isn't one. Never guesses: a near miss is
// reported with the suggestion, not silently corrected.
export function lookupKey(key: string): ConfigKeyDef {
  const def = BY_KEY.get(key);
  if (def) return def;
  const children = CONFIG_KEYS.filter((d) => d.key.startsWith(`${key}.`)).map((d) => d.key);
  if (children.length > 0) {
    throw new Error(`"${key}" is a group, not a key — use one of: ${children.join(', ')}`);
  }
  const ci = CONFIG_KEYS.find((d) => d.key.toLowerCase() === key.toLowerCase());
  const hint = ci ? ` Did you mean "${ci.key}"?` : '';
  throw new Error(`unknown config key "${key}".${hint} Run \`ycal config list\` for the valid keys.`);
}

const TRUE_WORDS = new Set(['true', 'on', 'yes', '1']);
const FALSE_WORDS = new Set(['false', 'off', 'no', '0']);

// Parse the command-line string into the key's type, or throw with the
// reason. Enum matching is case-insensitive but always stores the canonical
// spelling.
export function parseValue(def: ConfigKeyDef, raw: string): ConfigValue {
  switch (def.type) {
    case 'boolean': {
      const w = raw.trim().toLowerCase();
      if (TRUE_WORDS.has(w)) return true;
      if (FALSE_WORDS.has(w)) return false;
      throw new Error(`${def.key} is a boolean — expected true or false, got "${raw}"`);
    }
    case 'number': {
      const n = raw.trim() === '' ? NaN : Number(raw);
      if (!Number.isFinite(n)) throw new Error(`${def.key} is a number, got "${raw}"`);
      if (def.integer && !Number.isInteger(n)) {
        throw new Error(`${def.key} must be a whole number, got "${raw}"`);
      }
      if (def.min !== undefined && n < def.min) throw new Error(`${def.key} must be ≥ ${def.min}, got ${n}`);
      if (def.max !== undefined && n > def.max) throw new Error(`${def.key} must be ≤ ${def.max}, got ${n}`);
      return n;
    }
    case 'enum': {
      const hit = (def.choices ?? []).find((c) => c.toLowerCase() === raw.trim().toLowerCase());
      if (!hit) {
        throw new Error(`${def.key} must be one of: ${(def.choices ?? []).join(', ')} — got "${raw}"`);
      }
      return hit;
    }
    case 'string': {
      if (def.trim) raw = raw.trim();
      if (raw === '') {
        if (def.nullable) return null;
        throw new Error(`${def.key} cannot be empty`);
      }
      return raw;
    }
  }
}

// What `list` / `get` / `set` may print about a key. Secrets carry only
// `configured` + `length`; the value never leaves this function.
export interface ConfigView {
  key: string;
  type: KeyType;
  secret: boolean;
  source: 'stored' | 'default';
  value?: ConfigValue;
  configured?: boolean;
  length?: number | null;
  default?: ConfigValue;
  choices?: readonly string[];
  description: string;
}

export function viewOf(def: ConfigKeyDef, s: ConfigSnapshot): ConfigView {
  const stored = def.read(s);
  const source: ConfigView['source'] = stored === undefined ? 'default' : 'stored';
  if (isSecretKey(def)) {
    const str = typeof stored === 'string' ? stored : null;
    return {
      key: def.key,
      type: def.type,
      secret: true,
      source,
      configured: !!str,
      length: str ? str.length : null,
      description: def.description,
    };
  }
  return {
    key: def.key,
    type: def.type,
    secret: false,
    source,
    value: stored === undefined ? def.default : stored,
    default: def.default,
    ...(def.choices ? { choices: def.choices } : {}),
    description: def.description,
  };
}

// One-line human rendering of a view's value — the masked form for secrets.
export function renderViewValue(v: ConfigView): string {
  if (v.secret) return v.configured ? `<set, length ${v.length}>` : '<not set>';
  if (v.value === null || v.value === undefined) return '(none)';
  return String(v.value);
}
