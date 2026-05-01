// yCal — device-local preferences.
//
// Holds the one bit of state that CANNOT live in the cloud-routed
// settings.json: the `cloudStorage` pref itself. settings.json now
// follows the user across Macs through cloudStore, but we need to
// know where to read it from before we can read it — so this file
// stays in userData on every device, regardless of the cloud toggle.
//
// Anything else device-specific can land here later (e.g. a
// per-machine window position cache). Keep it small — most config
// belongs in settings.json so it syncs.

import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { CloudStorage } from '@shared/types';

interface DeviceState {
  cloudStorage: CloudStorage;
}

const DEFAULTS: DeviceState = { cloudStorage: 'local' };

const FILE = (): string => path.join(app.getPath('userData'), 'device.json');

function read(): DeviceState {
  const f = FILE();
  if (!existsSync(f)) return { ...DEFAULTS };
  try {
    const parsed = JSON.parse(readFileSync(f, 'utf-8')) as Partial<DeviceState>;
    return {
      cloudStorage: parsed.cloudStorage === 'icloud' ? 'icloud' : 'local',
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function write(s: DeviceState): void {
  const f = FILE();
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify(s, null, 2), 'utf-8');
}

export function getCloudStoragePref(): CloudStorage {
  return read().cloudStorage;
}

export function setCloudStoragePref(pref: CloudStorage): void {
  const cur = read();
  if (cur.cloudStorage === pref) return;
  write({ ...cur, cloudStorage: pref });
}

// One-shot: when upgrading from a build that wrote `cloudStorage` into
// settings.json, lift the value into device.json so the cloud-routed
// settings.json doesn't have to carry it. Idempotent — only fires when
// device.json doesn't exist yet.
export function adoptLegacyCloudPref(legacyPref: CloudStorage | undefined): void {
  if (existsSync(FILE())) return;
  write({ ...DEFAULTS, cloudStorage: legacyPref === 'icloud' ? 'icloud' : 'local' });
}
