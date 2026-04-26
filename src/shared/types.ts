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
export type SidebarSection = 'almanac' | 'agenda' | 'calendars' | 'forecast';

export interface UiSettings {
  // accountId → on/off in the title-bar account stack
  accountsActive: Record<string, boolean>;
  // calKey (accountId|calendarId) → visible on grid
  calVisible: Record<string, boolean>;
  // calKey → display role (defaults to 'normal' when missing)
  calRoles: Record<string, CalRolePersisted>;
  // Order of sidebar sections, top to bottom
  sectionOrder: SidebarSection[];
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
} as const;
