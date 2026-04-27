// Shared types between main and renderer processes.

export interface AccountSummary {
  id: string;
  email: string;
  name: string | null;
  picture: string | null;
}

export interface CalendarSummary {
  id: string;
  accountId: string;
  name: string;
  description: string | null;
  primary: boolean;
  selected: boolean;
  // Per-Google-Calendar default. Hex string. From Google's calendarList.colorId,
  // resolved via the Colors endpoint, with backgroundColor as a fallback.
  color: string;
  foregroundColor: string;
  accessRole: string;
}

export interface CalendarEvent {
  id: string;
  calendarId: string;
  accountId: string;
  // ISO date for all-day events; ISO datetime for timed events.
  start: string;
  end: string;
  allDay: boolean;
  title: string;
  location: string | null;
  description: string | null;
  // Resolved hex color: per-event override if set, else calendar default.
  color: string;
  // Google's per-event colorId (1-11) if set, else null.
  colorId: string | null;
  htmlLink: string | null;
  status: string;
  // Google's eventType — 'default', 'workingLocation', 'outOfOffice',
  // 'focusTime', 'fromGmail', 'birthday'. Drives how we render the entry.
  eventType: string | null;
  // The current user's response to this invite, or null when there's no
  // attendee record for "self" (events you own, working location, etc.).
  // Mirrors Google's vocabulary so the renderer can switch on it directly.
  rsvp: 'accepted' | 'tentative' | 'declined' | 'needsAction' | null;
  // Resolved working-location bucket for kind='workingLocation'/'outOfOffice'.
  workingLocation?: {
    kind: 'office' | 'home' | 'ooo' | 'other';
    label: string;
  };
  // When events with the same title + slot are duplicated across calendars,
  // we collapse them into one for rendering and stash the originals here.
  // Includes the kept event itself, so length ≥ 1 after merging.
  mergedFrom?: Array<{
    id: string;
    calendarId: string;
    accountId: string;
    color: string;
    htmlLink: string | null;
  }>;
}

// Google's 11-color event palette + 24 calendar palette, fetched once per session.
export interface GoogleColors {
  event: Record<string, { background: string; foreground: string }>;
  calendar: Record<string, { background: string; foreground: string }>;
}

export interface ListEventsRequest {
  // ISO date strings, inclusive start, exclusive end.
  timeMin: string;
  timeMax: string;
  // Calendar IDs to fetch from. Empty = all selected calendars.
  calendarIds?: string[];
}

export interface WeatherDay {
  date: string; // YYYY-MM-DD
  glyph: string | null;
  hi: number | null;
  lo: number | null;
  summary: string;
}

// User-controlled UI state that survives across launches.
export type CalRolePersisted = 'normal' | 'subscribed' | 'holiday';
export type SidebarSection = 'almanac' | 'agenda' | 'calendars';
export type TempUnits = 'F' | 'C';

// Cross-calendar merge criteria. Title (lowercased + trimmed) and start moment
// always count; the rest are user-configurable. Defaults match the loose
// "same topic + same starting slot" intuition users expect from a calendar.
export interface MergeCriteria {
  matchEnd: boolean;
  matchAllDay: boolean;
}

export const DEFAULT_MERGE_CRITERIA: MergeCriteria = {
  matchEnd: false,
  matchAllDay: true,
};

export interface UiSettings {
  // accountId → on/off in the title-bar account stack
  accountsActive: Record<string, boolean>;
  // calKey (accountId|calendarId) → visible on grid
  calVisible: Record<string, boolean>;
  // calKey → display role (defaults to 'normal' when missing)
  calRoles: Record<string, CalRolePersisted>;
  // Order of sidebar sections, top to bottom
  sectionOrder: SidebarSection[];
  // Optional — older settings files may not have it; fall back to defaults.
  mergeCriteria?: MergeCriteria;
  // Show ISO week numbers in the month grid, mini-month, and time-view corner.
  showWeekNums?: boolean;
  // Show weather glyph + hi/lo on each date in month/week/day views.
  showWeather?: boolean;
  // Temperature units for in-view weather chips.
  units?: TempUnits;
  // Hide calendar rows that the user has toggled off in the sidebar.
  hideDisabledCals?: boolean;
}

// Auto-update lifecycle, mirrored from electron-updater's events into a
// renderer-friendly union. `idle` is the boot state and what we fall back
// to after a dismissal or an error.
// `available` covers both "found, downloading silently" and "downloaded,
// waiting for user". The renderer doesn't need to distinguish — the toast
// is identical. `installing` means "user clicked, splash is up, app is
// about to quit". No manual `ready` step in between.
export type UpdateState =
  | 'idle'
  | 'checking'
  | 'available'
  | 'installing'
  | 'error';

export interface UpdateStatus {
  state: UpdateState;
  version: string | null;
  // 0–100 during 'downloading'.
  progress?: number;
  // Populated when state === 'error'.
  error?: string;
}

// IPC channel names — typed once, shared.
export const IPC = {
  AddAccount: 'ycal:addAccount',
  RemoveAccount: 'ycal:removeAccount',
  ListAccounts: 'ycal:listAccounts',
  ListCalendars: 'ycal:listCalendars',
  ListEvents: 'ycal:listEvents',
  GetColors: 'ycal:getColors',
  IsConfigured: 'ycal:isConfigured',
  GetWeatherUrl: 'ycal:getWeatherUrl',
  SetWeatherUrl: 'ycal:setWeatherUrl',
  GetWeather: 'ycal:getWeather',
  GetUiSettings: 'ycal:getUiSettings',
  SetUiSettings: 'ycal:setUiSettings',
  // Auto-update.
  UpdateCheck: 'ycal:updateCheck',
  UpdateInstall: 'ycal:updateInstall',
  UpdateStatus: 'ycal:updateStatus', // main → renderer push
} as const;
