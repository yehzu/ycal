import { google, calendar_v3 } from 'googleapis';
import { authClientForAccount } from './auth';
import { listAccounts, getAccount } from './tokenStore';
import type {
  CalendarSummary,
  CalendarEvent,
  GoogleColors,
  ListEventsRequest,
  AccountSummary,
} from '@shared/types';

// Cache the color palette for the lifetime of the process. It rarely changes,
// and we'd otherwise refetch it on every event load.
let colorsCache: GoogleColors | null = null;

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
  const accounts = listAccounts();
  const out: CalendarSummary[] = [];
  for (const acc of accounts) {
    const c = google.calendar({ version: 'v3', auth: authClientForAccount(acc) });
    let pageToken: string | undefined;
    do {
      const res = await c.calendarList.list({ pageToken, maxResults: 250 });
      for (const item of res.data.items ?? []) {
        if (!item.id) continue;
        out.push({
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
  }
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
  const colors = await fetchColors();
  const accounts = listAccounts();

  // Build the set of (accountId, calendarId) we need to query.
  const calendars = await listAllCalendars();
  const filterIds = req.calendarIds && req.calendarIds.length > 0
    ? new Set(req.calendarIds)
    : null;

  const targets = calendars.filter((c) => {
    if (filterIds && !filterIds.has(c.id)) return false;
    return true;
  });

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
          });
        }
        pageToken = res.data.nextPageToken ?? undefined;
      } while (pageToken);
    }),
  );

  return out;
}
