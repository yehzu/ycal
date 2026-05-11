import { google, calendar_v3 } from 'googleapis';
import { authClientForAccount } from './auth';
import { listAccounts, getAccount } from './tokenStore';
import type {
  CalendarSummary,
  CalendarEvent,
  CalendarFetchFailure,
  EventAttendee,
  GoogleColors,
  ListEventsRequest,
  ListEventsResult,
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

// Convert a Google auth error into something a human can act on. The dominant
// failure mode in practice is `invalid_grant` — refresh token rejected by
// Google (testing-mode 7-day TTL, manual revocation, password change, or 6
// months of inactivity). googleapis surfaces this in different shapes
// depending on transport, so check the message AND the response payload.
function friendlyAuthError(email: string, err: unknown): Error {
  const raw = err instanceof Error ? err : new Error(String(err));
  const message = raw.message ?? '';
  // Gaxios attaches the OAuth error code under response.data.error
  // for the token-refresh path.
  const data = (raw as { response?: { data?: { error?: string } } }).response?.data;
  const code = data?.error ?? '';
  const isInvalidGrant = /invalid_grant/i.test(message) || code === 'invalid_grant';
  if (isInvalidGrant) {
    const wrapped = new Error(
      `${email}: sign-in expired (invalid_grant). Open Settings → Accounts, remove this account, and add it again.`,
    );
    (wrapped as Error & { needsReauth?: boolean }).needsReauth = true;
    return wrapped;
  }
  return new Error(`${email}: ${message || 'unknown error'}`);
}

// Heuristic for "this might work on the next attempt." HTTP 429, 5xx, and
// the usual Node-level network drops fall into this bucket. We DON'T retry
// 401/403 (auth) or 404 (calendar gone) — those need user action.
function classifyTransient(err: unknown): boolean {
  const e = err as {
    code?: string | number;
    status?: number;
    response?: { status?: number };
  };
  const status = e?.response?.status ?? (typeof e?.status === 'number' ? e.status : undefined);
  if (typeof status === 'number') {
    if (status === 429) return true;
    if (status >= 500 && status <= 599) return true;
    return false;
  }
  const code = typeof e?.code === 'string' ? e.code : '';
  return /^(ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ENETUNREACH|EPIPE|ECONNREFUSED)$/.test(code);
}

function isNeedsReauth(err: unknown): boolean {
  if (err && typeof err === 'object' && 'needsReauth' in (err as object)) {
    return !!(err as { needsReauth?: boolean }).needsReauth;
  }
  const raw = err instanceof Error ? err.message : String(err ?? '');
  const data = (err as { response?: { data?: { error?: string } } } | null)?.response?.data;
  const code = data?.error ?? '';
  return /invalid_grant/i.test(raw) || code === 'invalid_grant';
}

// Sleep helper for retry backoff. Kept local — no global timer dependency.
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Wrap a flaky async fn with one retry on transient failure. 500ms wait —
// long enough that a 429 cooldown helps, short enough that the user sees
// the recovery as part of the current refresh rather than a separate
// round-trip.
async function withTransientRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!classifyTransient(err)) throw err;
    console.warn('[yCal] transient error on', label, '— retrying after 500ms:', err instanceof Error ? err.message : err);
    await delay(500);
    return fn();
  }
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
  // Try each account in turn — if accounts[0] has a dead refresh token,
  // we want accounts[1] to keep colors flowing rather than blank the UI.
  for (const acc of accounts) {
    try {
      const c = cal(acc.id);
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
    } catch (err) {
      console.error('[yCal] colors fetch failed for', acc.email, '—', err instanceof Error ? err.message : err);
    }
  }
  // No account could deliver the palette. Return an empty one — callers
  // already fall back to per-calendar defaults when an event colorId
  // doesn't resolve.
  return { event: {}, calendar: {} };
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
  // matters for CLI cold-start. Use allSettled so one bad refresh token
  // (invalid_grant) doesn't blank every other account.
  const settled = await Promise.allSettled(
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
  const out: CalendarSummary[] = [];
  const failures: Error[] = [];
  for (let i = 0; i < accounts.length; i++) {
    const acc = accounts[i];
    const result = settled[i];
    if (result.status === 'fulfilled') {
      out.push(...result.value);
    } else {
      const friendly = friendlyAuthError(acc.email, result.reason);
      failures.push(friendly);
      console.error('[yCal] calendar list failed for', acc.email, '—', friendly.message);
    }
  }
  if (out.length === 0 && accounts.length > 0 && failures.length === accounts.length) {
    // Every account failed — surface a combined, actionable message.
    throw new Error(failures.map((e) => e.message).join('\n'));
  }
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

export async function listEvents(req: ListEventsRequest): Promise<ListEventsResult> {
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
      return { events: cached.data, failures: [] };
    }
  }

  const colors = await fetchColors();
  const accounts = listAccounts();

  // Group targets by account so we can isolate auth refresh from per-cal
  // fetches: if account A's refresh dies (`invalid_grant`), we record ONE
  // account-level failure and never enumerate its calendars. If account
  // A's refresh works but one of its calendars 5xx's, only THAT calendar
  // surfaces as a failure — the rest of A's events still load. This was
  // the bug: the old code's inner `Promise.all` poisoned the entire
  // account on any single calendar reject, making "one bad calendar"
  // look like "lost half a day of events" to the user.
  const targetsByAccount = new Map<string, typeof targets>();
  for (const t of targets) {
    const list = targetsByAccount.get(t.accountId);
    if (list) list.push(t);
    else targetsByAccount.set(t.accountId, [t]);
  }
  const accountIds = Array.from(targetsByAccount.keys());

  const out: FlatEventRow[] = [];
  const failures: CalendarFetchFailure[] = [];

  await Promise.all(
    accountIds.map(async (accountId) => {
      const acc = accounts.find((a) => a.id === accountId);
      if (!acc) return;
      const client = google.calendar({ version: 'v3', auth: authClientForAccount(acc) });
      const calList = targetsByAccount.get(accountId)!;
      // Fan out per calendar within the account; per-calendar isolation
      // via allSettled.
      const perCal = await Promise.allSettled(
        calList.map(async (cal) => {
          const localRows: FlatEventRow[] = [];
          let pageToken: string | undefined;
          do {
            const pt = pageToken;
            const res = await withTransientRetry(`${acc.email}/${cal.name}`, () =>
              client.events.list({
                calendarId: cal.id,
                timeMin: req.timeMin,
                timeMax: req.timeMax,
                singleEvents: true,
                orderBy: 'startTime',
                maxResults: 2500,
                pageToken: pt,
              }),
            );
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
              localRows.push({
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
          return localRows;
        }),
      );

      for (let i = 0; i < calList.length; i++) {
        const cal = calList[i];
        const r = perCal[i];
        if (r.status === 'fulfilled') {
          out.push(...r.value);
        } else {
          const needsReauth = isNeedsReauth(r.reason);
          // An invalid_grant surfacing on a per-calendar fetch means the
          // token died mid-fan-out — record once at account scope, then
          // skip recording it again for the sibling calendars in the
          // same account (they'll all fail with the same root cause).
          if (needsReauth && failures.some((f) => f.accountId === accountId && f.calendarId === null)) {
            continue;
          }
          const friendly = friendlyAuthError(acc.email, r.reason);
          const transient = !needsReauth && classifyTransient(r.reason);
          failures.push({
            accountId,
            calendarId: needsReauth ? null : cal.id,
            accountEmail: acc.email,
            calendarName: needsReauth ? null : cal.name,
            message: friendly.message,
            transient,
            needsReauth,
          });
          console.error('[yCal] events list failed for', acc.email, '/', cal.name, '—', friendly.message);
        }
      }
    }),
  );

  // Only cache when fully successful. A partial-failure result needs to
  // retry on the next refresh — caching it would mean the user clicks
  // "Retry" and instantly gets back the same gap.
  if (failures.length === 0) {
    eventsCache.set(cacheKey, { at: Date.now(), data: out });
  }
  return { events: out, failures };
}
