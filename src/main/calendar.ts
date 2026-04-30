import { google, calendar_v3 } from 'googleapis';
import { authClientForAccount } from './auth';
import { listAccounts, getAccount } from './tokenStore';
import type {
  CalendarSummary,
  CalendarEvent,
  EventAttendee,
  GoogleColors,
  ListEventsRequest,
  AccountSummary,
} from '@shared/types';

// Cache the color palette for the lifetime of the process. It rarely changes,
// and we'd otherwise refetch it on every event load.
let colorsCache: GoogleColors | null = null;

// Calendar metadata cache. Calendar lists rarely change; refetching on every
// CLI call is the dominant cost when the user has many accounts. The CLI
// server lives inside the GUI process so the cache persists across CLI
// invocations within the same yCal session.
const CALENDAR_CACHE_TTL_MS = 5 * 60 * 1000;
let calendarCache: { at: number; data: CalendarSummary[] } | null = null;

export function invalidateCalendarCache(): void {
  calendarCache = null;
}

// Short-TTL events cache, keyed by (timeMin|timeMax|sorted calendarIds).
// Lets a follow-up `ycal today` immediately after `ycal events` skip the
// Google round trip. Kept short (~30s) because events change often and we
// don't want stale data in interactive use.
const EVENTS_CACHE_TTL_MS = 30 * 1000;
const eventsCache = new Map<string, { at: number; data: CalendarEvent[] }>();

export function invalidateEventsCache(): void {
  eventsCache.clear();
}

function cal(accountId: string): calendar_v3.Calendar {
  const acc = getAccount(accountId);
  if (!acc) throw new Error(`Unknown account: ${accountId}`);
  return google.calendar({ version: 'v3', auth: authClientForAccount(acc) });
}

export async function fetchColors(): Promise<GoogleColors> {
  if (colorsCache) return colorsCache;
  const accounts = listAccounts();
  if (accounts.length === 0) {
    return { event: {}, calendar: {} };
  }
  const c = cal(accounts[0].id);
  const res = await c.colors.get({});
  const event: GoogleColors['event'] = {};
  const calendar: GoogleColors['calendar'] = {};
  for (const [k, v] of Object.entries(res.data.event ?? {})) {
    event[k] = { background: v.background ?? '#888', foreground: v.foreground ?? '#fff' };
  }
  for (const [k, v] of Object.entries(res.data.calendar ?? {})) {
    calendar[k] = { background: v.background ?? '#888', foreground: v.foreground ?? '#fff' };
  }
  colorsCache = { event, calendar };
  return colorsCache;
}

export function listAccountSummaries(): AccountSummary[] {
  return listAccounts().map((a) => ({
    id: a.id,
    email: a.email,
    name: a.name,
    picture: a.picture,
  }));
}

export async function listAllCalendars(): Promise<CalendarSummary[]> {
  const cached = calendarCache;
  if (cached && Date.now() - cached.at < CALENDAR_CACHE_TTL_MS) {
    return cached.data;
  }
  const accounts = listAccounts();
  // Fan out per account in parallel — the GUI typically has 1–3 accounts but
  // each calendarList.list adds round-trip latency, so even small fan-out
  // matters for CLI cold-start.
  const perAccount = await Promise.all(
    accounts.map(async (acc) => {
      const rows: CalendarSummary[] = [];
      const c = google.calendar({ version: 'v3', auth: authClientForAccount(acc) });
      let pageToken: string | undefined;
      do {
        const res = await c.calendarList.list({ pageToken, maxResults: 250 });
        for (const item of res.data.items ?? []) {
          if (!item.id) continue;
          rows.push({
            id: item.id,
            accountId: acc.id,
            name: item.summaryOverride ?? item.summary ?? item.id,
            description: item.description ?? null,
            primary: !!item.primary,
            selected: item.selected !== false,
            // backgroundColor reflects the user's per-calendar customization in
            // Google Calendar; foregroundColor matches.
            color: item.backgroundColor ?? '#616161',
            foregroundColor: item.foregroundColor ?? '#ffffff',
            accessRole: item.accessRole ?? 'reader',
          });
        }
        pageToken = res.data.nextPageToken ?? undefined;
      } while (pageToken);
      return rows;
    }),
  );
  const out = perAccount.flat();
  calendarCache = { at: Date.now(), data: out };
  return out;
}

interface FlatEventRow extends CalendarEvent {}

// Map Google's working-location / OOO events into one of four icon buckets.
// workingLocationProperties.type = 'homeOffice' | 'officeLocation' | 'customLocation'.
// 'outOfOffice' eventType always lands in the OOO bucket.
function resolveWorkingLocation(
  ev: calendar_v3.Schema$Event,
  eventType: string,
): { kind: 'office' | 'home' | 'ooo' | 'other'; label: string } | undefined {
  if (eventType === 'outOfOffice') {
    return { kind: 'ooo', label: ev.summary ?? 'Out of office' };
  }
  if (eventType !== 'workingLocation') return undefined;
  const wl = ev.workingLocationProperties;
  if (!wl) {
    // Fall back to title-keyword heuristic when the API omitted the field.
    return { kind: kindFromTitle(ev.summary ?? ''), label: ev.summary ?? 'Working location' };
  }
  if (wl.homeOffice !== undefined) {
    return { kind: 'home', label: ev.summary ?? 'Working from home' };
  }
  if (wl.officeLocation) {
    const label = wl.officeLocation.label ?? wl.officeLocation.buildingId
      ?? wl.officeLocation.deskId ?? wl.officeLocation.floorId ?? 'Office';
    return { kind: 'office', label };
  }
  if (wl.customLocation) {
    return { kind: 'other', label: wl.customLocation.label ?? ev.summary ?? 'Other location' };
  }
  return { kind: 'other', label: ev.summary ?? 'Working location' };
}

function kindFromTitle(title: string): 'office' | 'home' | 'ooo' | 'other' {
  const t = title.toLowerCase();
  if (/(wfh|home|remote)/.test(t)) return 'home';
  if (/(office|hq)/.test(t)) return 'office';
  if (/(ooo|out|pto|vacation|travel|trip)/.test(t)) return 'ooo';
  return 'other';
}

// Map Google's attendee.responseStatus on the "self" attendee into our rsvp
// vocabulary. Events with no attendees-for-self (e.g. ones you own outright,
// working location, birthdays) get null and render with no visual hint.
function resolveRsvp(
  ev: calendar_v3.Schema$Event,
): CalendarEvent['rsvp'] {
  const self = (ev.attendees ?? []).find((a) => a.self);
  if (!self || !self.responseStatus) return null;
  switch (self.responseStatus) {
    case 'accepted':
    case 'tentative':
    case 'declined':
    case 'needsAction':
      return self.responseStatus;
    default:
      return null;
  }
}

// Extract a Google Meet (or other) conference link plus a label. We prefer
// `conferenceData` when present (it carries entryPoints with explicit URIs and
// a solution name), and fall back to the legacy `hangoutLink` field. The URL
// is stored without protocol so the popover can render it as a compact label.
function resolveMeet(
  ev: calendar_v3.Schema$Event,
): { meetUrl?: string; meetLabel?: string } {
  const cd = ev.conferenceData;
  if (cd) {
    const entries = cd.entryPoints ?? [];
    const video = entries.find((e) => e.entryPointType === 'video');
    if (video?.uri) {
      const solution = cd.conferenceSolution?.name ?? null;
      return {
        meetUrl: stripProto(video.uri),
        ...(solution ? { meetLabel: solution } : {}),
      };
    }
  }
  if (ev.hangoutLink) {
    return { meetUrl: stripProto(ev.hangoutLink), meetLabel: 'Google Meet' };
  }
  return {};
}

function stripProto(url: string): string {
  return url.replace(/^https?:\/\//, '');
}

function resolveAttendees(ev: calendar_v3.Schema$Event): EventAttendee[] | undefined {
  const list = ev.attendees;
  if (!list || list.length === 0) return undefined;
  const out: EventAttendee[] = [];
  for (const a of list) {
    if (!a.email && !a.displayName) continue;
    const status = a.responseStatus;
    const rsvp: EventAttendee['rsvp']
      = status === 'accepted' || status === 'tentative'
        || status === 'declined' || status === 'needsAction'
        ? status
        : 'needsAction';
    out.push({
      email: a.email ?? '',
      name: a.displayName ?? null,
      organizer: !!a.organizer,
      self: !!a.self,
      rsvp,
      optional: !!a.optional,
      resource: !!a.resource,
      additionalGuests: a.additionalGuests ?? 0,
    });
  }
  return out.length > 0 ? out : undefined;
}

function isoFromGoogleDate(g: calendar_v3.Schema$EventDateTime | undefined): {
  iso: string;
  allDay: boolean;
} {
  if (!g) return { iso: new Date(0).toISOString(), allDay: false };
  if (g.date) {
    // All-day. Google sends YYYY-MM-DD as a date with no time.
    return { iso: `${g.date}T00:00:00`, allDay: true };
  }
  return { iso: g.dateTime ?? new Date(0).toISOString(), allDay: false };
}

export async function listEvents(req: ListEventsRequest): Promise<CalendarEvent[]> {
  // Build the set of (accountId, calendarId) we need to query.
  const calendars = await listAllCalendars();
  const filterIds = req.calendarIds && req.calendarIds.length > 0
    ? new Set(req.calendarIds)
    : null;

  const targets = calendars.filter((c) => {
    if (filterIds && !filterIds.has(c.id)) return false;
    return true;
  });

  // Cache key: stable across calendarIds order so back-to-back queries with
  // the same set hit the cache.
  const cacheKey = JSON.stringify({
    timeMin: req.timeMin,
    timeMax: req.timeMax,
    ids: targets.map((c) => `${c.accountId}|${c.id}`).sort(),
  });
  if (!req.force) {
    const cached = eventsCache.get(cacheKey);
    if (cached && Date.now() - cached.at < EVENTS_CACHE_TTL_MS) {
      return cached.data;
    }
  }

  const colors = await fetchColors();
  const accounts = listAccounts();

  const out: FlatEventRow[] = [];

  // Fetch in parallel per calendar; stagger isn't necessary at this scale.
  await Promise.all(
    targets.map(async (cal) => {
      const acc = accounts.find((a) => a.id === cal.accountId);
      if (!acc) return;
      const client = google.calendar({ version: 'v3', auth: authClientForAccount(acc) });
      let pageToken: string | undefined;
      do {
        const res = await client.events.list({
          calendarId: cal.id,
          timeMin: req.timeMin,
          timeMax: req.timeMax,
          singleEvents: true,
          orderBy: 'startTime',
          maxResults: 2500,
          pageToken,
        });
        for (const ev of res.data.items ?? []) {
          if (!ev.id || !ev.start || !ev.end) continue;
          if (ev.status === 'cancelled') continue;
          const { iso: startIso, allDay } = isoFromGoogleDate(ev.start);
          const { iso: endIso } = isoFromGoogleDate(ev.end);
          // Resolve color: per-event override → per-calendar default.
          const eventColor = ev.colorId
            ? colors.event[ev.colorId]?.background ?? cal.color
            : cal.color;
          const eventType = ev.eventType ?? 'default';
          const workingLocation = resolveWorkingLocation(ev, eventType);
          const meet = resolveMeet(ev);
          const attendees = resolveAttendees(ev);
          out.push({
            id: ev.id,
            calendarId: cal.id,
            accountId: cal.accountId,
            start: startIso,
            end: endIso,
            allDay,
            title: ev.summary ?? '(no title)',
            location: ev.location ?? null,
            description: ev.description ?? null,
            color: eventColor,
            colorId: ev.colorId ?? null,
            htmlLink: ev.htmlLink ?? null,
            status: ev.status ?? 'confirmed',
            eventType,
            rsvp: resolveRsvp(ev),
            ...(workingLocation ? { workingLocation } : {}),
            ...(meet.meetUrl ? { meetUrl: meet.meetUrl } : {}),
            ...(meet.meetLabel ? { meetLabel: meet.meetLabel } : {}),
            ...(attendees ? { attendees } : {}),
          });
        }
        pageToken = res.data.nextPageToken ?? undefined;
      } while (pageToken);
    }),
  );

  eventsCache.set(cacheKey, { at: Date.now(), data: out });
  return out;
}
