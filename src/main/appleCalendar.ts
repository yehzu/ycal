import { app } from 'electron';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { dedupEvents } from '@shared/dedup';
import type {
  AppleCalendarMutation,
  AppleCalendarSyncResult,
  AppleCalendarStatus,
  CalendarEvent,
} from '@shared/types';
import { DEFAULT_MERGE_CRITERIA } from '@shared/types';
import { listAllCalendars, listEvents } from './calendar';
import { getUiSettings } from './settings';

const execFileAsync = promisify(execFile);
const HELPER_NAME = 'apple-calendar-sync';

function helperPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'native', HELPER_NAME);
  }
  return path.join(app.getAppPath(), 'build', 'native', HELPER_NAME);
}

function unsupportedStatus(): AppleCalendarStatus {
  return {
    supported: false,
    authorization: 'unknown',
    sources: [],
    testCalendarSourceIds: [],
  };
}

async function runHelper<T>(args: string[]): Promise<T> {
  if (process.platform !== 'darwin') {
    throw new Error('Apple Calendar mirroring is only available on macOS.');
  }
  const binary = helperPath();
  try {
    const { stdout } = await execFileAsync(binary, args, {
      timeout: 2 * 60 * 1000,
      maxBuffer: 1024 * 1024,
    });
    return JSON.parse(stdout.trim()) as T;
  } catch (error) {
    const e = error as Error & { stderr?: string; code?: string };
    if (e.code === 'ENOENT') {
      throw new Error(
        'The Apple Calendar helper is missing. Rebuild yCal with native/apple-calendar-sync/build.sh.',
      );
    }
    if (e.stderr) {
      try {
        const parsed = JSON.parse(e.stderr.trim()) as { error?: string };
        if (parsed.error) throw new Error(parsed.error);
      } catch (parsedError) {
        if (parsedError instanceof Error && parsedError.message !== 'Unexpected end of JSON input') {
          throw parsedError;
        }
      }
    }
    throw e;
  }
}

interface MirrorEventPayload {
  key: string;
  color: string;
  title: string;
  startMs: number;
  endMs: number;
  allDay: boolean;
  location: string | null;
  notes: string | null;
}

interface MirrorSyncPayload {
  rangeStartMs: number;
  rangeEndMs: number;
  events: MirrorEventPayload[];
}

function calKey(accountId: string, calendarId: string): string {
  return `${accountId}|${calendarId}`;
}

function stableMirrorKey(event: CalendarEvent): string {
  const sources = event.mergedFrom && event.mergedFrom.length > 0
    ? event.mergedFrom
    : [{
        id: event.id,
        accountId: event.accountId,
        calendarId: event.calendarId,
      }];
  const identity = sources
    .map((source) => `${source.accountId}\0${source.calendarId}\0${source.id}`)
    .sort()
    .join('\n');
  return createHash('sha256').update(identity).digest('hex');
}

function normalizeColor(color: string): string {
  const hex = color.trim().toUpperCase();
  return /^#[0-9A-F]{6}$/.test(hex) ? hex : '#616161';
}

function mirrorNotes(event: CalendarEvent): string | null {
  const parts: string[] = [];
  if (event.description?.trim()) parts.push(event.description.trim());
  if (event.meetUrl) parts.push(`Video call: https://${event.meetUrl}`);
  if (event.htmlLink) parts.push(`Google Calendar: ${event.htmlLink}`);
  return parts.length > 0 ? parts.join('\n\n') : null;
}

function mirrorTimes(event: CalendarEvent): { startMs: number; endMs: number } {
  const startMs = new Date(event.start).getTime();
  const sourceEndMs = new Date(event.end).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(sourceEndMs)) {
    throw new Error(
      `Apple Calendar sync stopped because “${event.title}” has an invalid start or end time.`,
    );
  }
  if (sourceEndMs > startMs) return { startMs, endMs: sourceEndMs };

  // Google can contain zero-duration "instant" entries. yCal can render
  // those, but EventKit requires a positive interval. Preserve the event
  // instead of dropping the whole sync: one day for all-day, one minute for
  // timed entries. Negative source durations use the same defensive repair.
  const minimumDurationMs = event.allDay ? 24 * 60 * 60 * 1000 : 60 * 1000;
  console.warn(
    `[yCal Apple mirror] repaired non-positive duration for ${event.id} ` +
    `(${event.title}): ${event.start} → ${event.end}`,
  );
  return { startMs, endMs: startMs + minimumDurationMs };
}

function mirrorWindow(): { start: Date; end: Date } {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - 30);
  const end = new Date();
  end.setHours(0, 0, 0, 0);
  end.setDate(end.getDate() + 366);
  return { start, end };
}

async function canonicalMirrorEvents(
  start: Date,
  end: Date,
): Promise<CalendarEvent[]> {
  const calendars = await listAllCalendars();
  const ui = getUiSettings();
  const targets = calendars.filter((calendar) => {
    if (ui.accountsActive[calendar.accountId] === false) return false;
    return ui.calVisible[calKey(calendar.accountId, calendar.id)] ?? calendar.selected;
  });
  if (targets.length === 0) {
    throw new Error(
      'Apple Calendar sync stopped because yCal has no enabled, visible calendars. ' +
      'No mirror events were changed.',
    );
  }

  const targetPairs = new Set(
    targets.map((calendar) => calKey(calendar.accountId, calendar.id)),
  );
  const calendarIds = Array.from(new Set(targets.map((calendar) => calendar.id)));
  const fetched = await listEvents({
    timeMin: start.toISOString(),
    timeMax: end.toISOString(),
    calendarIds,
    force: true,
  });
  if (fetched.failures.length > 0) {
    const failed = fetched.failures
      .map((failure) => failure.calendarName
        ? `${failure.accountEmail}/${failure.calendarName}`
        : failure.accountEmail)
      .join(', ');
    throw new Error(
      `Apple Calendar sync stopped because yCal could not fully refresh: ${failed}. ` +
      'No mirror events were changed.',
    );
  }

  const visible = fetched.events.filter((event) => {
    if (!targetPairs.has(calKey(event.accountId, event.calendarId))) return false;
    // Google working-location entries ("Office", "Home", custom location)
    // are date-adjacent context chips in yCal, not appointments. Keep OOO
    // events — including timed OOO blocks — but never mirror workingLocation
    // into Apple Calendar as a conventional event.
    return event.eventType !== 'workingLocation';
  });
  return dedupEvents(
    visible,
    calendars,
    ui.mergeCriteria ?? DEFAULT_MERGE_CRITERIA,
  );
}

async function runMirrorHelper(
  sourceId: string,
  payload: MirrorSyncPayload,
): Promise<AppleCalendarSyncResult> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'ycal-apple-mirror-'));
  const payloadPath = path.join(tempDir, 'mirror.json');
  try {
    await writeFile(payloadPath, JSON.stringify(payload), {
      encoding: 'utf8',
      mode: 0o600,
    });
    return await runHelper<AppleCalendarSyncResult>([
      'sync-mirror',
      sourceId,
      payloadPath,
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function probeAppleCalendar(): Promise<AppleCalendarStatus> {
  if (process.platform !== 'darwin') return unsupportedStatus();
  return runHelper<AppleCalendarStatus>(['probe']);
}

export async function requestAppleCalendarAccess(): Promise<AppleCalendarStatus> {
  return runHelper<AppleCalendarStatus>(['request-access']);
}

export async function createAppleCalendarSpike(
  sourceId: string,
): Promise<AppleCalendarMutation> {
  if (!sourceId) throw new Error('Select an iCloud calendar source first.');
  return runHelper<AppleCalendarMutation>(['create-spike', sourceId]);
}

export async function removeAppleCalendarSpike(
  sourceId: string,
): Promise<AppleCalendarMutation> {
  if (!sourceId) throw new Error('Select an iCloud calendar source first.');
  return runHelper<AppleCalendarMutation>(['remove-spike', sourceId]);
}

export async function syncAppleCalendarMirror(
  sourceId: string,
): Promise<AppleCalendarSyncResult> {
  if (!sourceId) throw new Error('Select an iCloud calendar source first.');
  const { start, end } = mirrorWindow();
  const events = await canonicalMirrorEvents(start, end);
  const payload: MirrorSyncPayload = {
    rangeStartMs: start.getTime(),
    rangeEndMs: end.getTime(),
    events: events.map((event) => {
      const times = mirrorTimes(event);
      return {
        key: stableMirrorKey(event),
        color: normalizeColor(event.color),
        title: event.title,
        startMs: times.startMs,
        endMs: times.endMs,
        allDay: event.allDay,
        location: event.location,
        notes: mirrorNotes(event),
      };
    }),
  };
  return runMirrorHelper(sourceId, payload);
}
