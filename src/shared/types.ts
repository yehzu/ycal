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
  // Google Meet (or other conference) URL pulled from conferenceData or
  // hangoutLink. Stored without the protocol prefix so the popover can
  // render it as a label and append "https://" when opening externally.
  meetUrl?: string;
  // Pretty-printed conference name when it isn't Google Meet (e.g. Zoom).
  // Falls back to "Video call" when Google didn't tell us the type.
  meetLabel?: string;
  // Other attendees on the invite — modeled after Google's attendee object.
  // The "self" record is excluded (RSVP is on the parent CalendarEvent),
  // but the organizer is kept even when the user is the organizer so the
  // popover can show "you · organizer".
  attendees?: EventAttendee[];
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

// Attendee on a CalendarEvent. Email is the identity key (display name may be
// missing for external invitees). `additionalGuests` mirrors Google's "+N
// guests" feature so the popover counts can include the bring-along headcount.
export interface EventAttendee {
  email: string;
  name: string | null;
  organizer: boolean;
  self: boolean;
  rsvp: 'accepted' | 'tentative' | 'declined' | 'needsAction';
  optional: boolean;
  resource: boolean;
  additionalGuests: number;
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
  // Skip the in-memory events cache. Used by the renderer's focus/poll
  // refresh so a Google-side edit shows up without a full app restart.
  force?: boolean;
}

// Per-calendar (or per-account) fetch failure surfaced to the renderer so
// the UI can show "N calendars couldn't sync — retry?" rather than
// silently dropping a calendar's events when Google blips. Account-level
// failures (`calendarId: null`) happen when the OAuth refresh itself
// rejects; per-calendar failures are the common transient case (rate
// limit, 5xx, network drop).
export interface CalendarFetchFailure {
  accountId: string;
  // null = whole-account failure (auth refresh) where we never got far
  // enough to enumerate calendars.
  calendarId: string | null;
  accountEmail: string;
  calendarName: string | null;
  message: string;
  // True for failures that look retryable (HTTP 5xx, 429, transient
  // network). The renderer auto-retries these on focus + manual click.
  transient: boolean;
  // True when the failure is `invalid_grant` style — user needs to
  // remove + re-add the account in Settings before more retries make sense.
  needsReauth: boolean;
}

// Wire shape returned by ListEvents IPC. Failures live alongside events
// so a partial fetch still renders what we have AND surfaces the missing
// calendars.
export interface ListEventsResult {
  events: CalendarEvent[];
  failures: CalendarFetchFailure[];
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
  // When true, unfinished scheduled tasks from previous days are
  // automatically unscheduled and returned to the inbox. When false, they
  // stay parked on their original day with a "↻ carry" indicator.
  autoRolloverPastTasks?: boolean;
  // Window used to compute the day-load gauge (free time, energy, intensity).
  loadWindow?: LoadWindowSettings;
  // Energy thresholds for the day-load gauge intensity bands.
  loadBands?: LoadBands;
  // User-defined location/context tags surfaced as ⌘⇧Y autocomplete
  // suggestions even before they appear on any task. e.g. ['home',
  // 'computer', 'office']. Merged with locations pulled from cached
  // tasks; cache wins on duplicates.
  customTagSuggestions?: string[];
  // Color scheme. 'system' follows OS appearance via prefers-color-scheme.
  theme?: ThemeMode;
}

export type ThemeMode = 'light' | 'dark' | 'system';

// Energy bands for the day-load intensity color. Thresholds are in
// equivalent-meeting-hours: meetings count 1.0×/h, tasks scale by their
// declared energy (low 0.5×, mid 1.0×, high 1.5×). A day's energyScore
// falls into:
//   ≤ calmMax    → calm   (green)
//   ≤ steadyMax  → steady (yellow)
//   ≤ fullMax    → full   (orange)
//   > fullMax    → heavy  (red)
export interface LoadBands {
  calmMax: number;    // hours
  steadyMax: number;
  fullMax: number;
}

export const DEFAULT_LOAD_BANDS: LoadBands = {
  calmMax: 3,
  steadyMax: 6,
  fullMax: 9,
};

// Day-load calculation window. Two modes:
//   'rhythm'  — wake→sleep from the per-day rhythm. Largest window, ~16h.
//   'fixed'   — a fixed start/end (minutes from midnight). Defaults to
//               9 AM – 6 PM so the gauge reflects "work hours" rather than
//               whole-day capacity, which makes packed work days actually
//               read as packed.
export interface LoadWindowSettings {
  mode: 'rhythm' | 'fixed';
  startMin: number;  // 0..1440, only used when mode === 'fixed'
  endMin: number;
}

export const DEFAULT_LOAD_WINDOW: LoadWindowSettings = {
  mode: 'fixed',
  startMin: 9 * 60,
  endMin: 18 * 60,
};

// Auto-update lifecycle. The updater (src/main/updater.ts) maps its
// internal phases onto this renderer-friendly union. `idle` is the boot
// state and what we fall back
// to after a dismissal or an error.
// `available` means "we found an update and the background prefetch is
// in progress" — toast appears immediately so the user knows about it,
// but clicking Install will block on the in-flight download.
// `ready` means "prefetch finished, the zip is on disk" — clicking
// Install jumps straight to extract + swap, so it feels instant.
// `installing` means "user clicked, splash is up, app is about to quit".
export type UpdateState =
  | 'idle'
  | 'checking'
  | 'available'
  | 'ready'
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

// ── Tasks (provider-backed) ──────────────────────────────────────────
// A task provider is a backing store for tasks. The renderer doesn't
// know which provider is active — it just sees `TaskItem`s flowing through
// IPC. To swap providers, drop a new file under `src/main/taskProviders/`
// implementing the same interface and register it in the index.
//
// Providers shipped today:
//   * todoist  — talks to Todoist's API v1; credentials are an API key.
//   * markdown — reads/writes a `tasks.md` file in cloudStore. No auth;
//                the file is created on demand and follows the user across
//                devices via iCloud Drive (or stays local-only).
export type TaskProviderId = 'todoist' | 'markdown';

export interface TaskProviderInfo {
  id: TaskProviderId;
  displayName: string;
  // True when credentials are configured (e.g. an API key has been set).
  // Markdown provider returns true once the file is reachable.
  hasCredentials: boolean;
  // Human-friendly hint shown alongside the credentials field. Empty
  // string when the provider doesn't need credentials (markdown).
  credentialsHint: string;
  // Marks the provider that's actively serving IPC right now. Renderer
  // uses this for the segmented control + the panel's "no credentials"
  // state. Exactly one provider in `listProviders()` will be active.
  active?: boolean;
}

// We don't try to model every Todoist field. Just what the panel + sheet
// need to render, plus whatever round-trips back to the provider's API.
export interface TaskItem {
  id: string;          // Todoist task id, kept as string
  projectId: string | null;
  // Parent task id when this is a subtask, else null. Provider-supplied —
  // the renderer builds the nesting tree from this. Children inherit
  // `project` from their parent on the wire.
  parentId: string | null;
  project: string;     // resolved project name (used for grouping + color)
  title: string;
  description: string;
  // Energy is purely a yCal nicety — the user can prefix the title with
  // [low]/[mid]/[high] to drive the chip color. Default is 'mid'.
  energy: 'low' | 'mid' | 'high';
  location: string;    // pulled from a `@<text>` chunk in the Todoist content
  // Estimated duration in minutes. Pulled from a `~30m` / `~1h` chunk in the
  // Todoist content. 0 means "no estimate" — chip will use a default height.
  dur: number;
  // Todoist's due date string (YYYY-MM-DD) when present, else null.
  due: string | null;
  // recur.dow: array of 0–6 (Sun–Sat) when the task is a Todoist recurring
  // task that fires on specific weekdays. null when either non-recurring OR
  // when the recurrence cadence isn't parsable as a weekday set ("every 3
  // days", "every 2 weeks") — those still set `isRecurring` below so the
  // panel can fold them away.
  recur: { dow: number[] } | null;
  // True when Todoist marks this task as recurring (regardless of whether
  // we managed to parse a dow). The Routines fold uses this so cadences
  // like "every 3 days" don't leak into the regular project sections.
  isRecurring: boolean;
  // Todoist priority on the wire: 1 = none/default, 2 = P3, 3 = P2,
  // 4 = P1 (highest). We pass it through unchanged so the Todoist user's
  // mental model stays intact.
  priority: 1 | 2 | 3 | 4;
  // Comments inlined from Todoist's /comments endpoint.
  comments: TaskComment[];
  // True if Todoist marks the task complete. The panel hides these.
  done: boolean;
  // The local-only schedule slot, mirrored back to settings.json so it
  // survives reloads and so the renderer doesn't need to refetch every time.
  // null = unscheduled (lives in the inbox).
  scheduledAt: { date: string; start: string } | null;
}

export interface TaskComment {
  id: string;
  author: string;
  authorColor: string;
  at: string;        // ISO datetime
  text: string;
}

// Tasks store on disk — local schedule overlay + last-known cached tasks
// so we can render instantly before the Todoist fetch resolves.
export interface TasksLocalState {
  // taskId → { date, start } (15-min snap)
  scheduled: Record<string, { date: string; start: string }>;
  // taskId → 'YYYY-MM-DD' the user marked it done (mirror of Todoist's
  // completion state for the "Done today" footer; rebuilt on each fetch).
  doneOn: Record<string, string>;
  // Cache of last fetched tasks so the panel renders without a flash on
  // restart. Refreshed in the background by the Todoist client.
  cache?: TaskItem[];
  cacheAt?: string;  // ISO timestamp
  // Snapshots of completed tasks so the calendar grid keeps showing their
  // chips even after the upstream provider drops them from the active list.
  // We keep these for ~30 days post-completion (see COMPLETED_RETAIN_DAYS),
  // pruning lazily on each write.
  completed?: Record<string, { snapshot: TaskItem; completedOn: string }>;
}

// Project node from the provider. Todoist supports nested projects up to
// ~4 levels; we model the tree as a flat list with parentId pointers so the
// renderer can walk it without round-tripping recursive payloads. Order is
// the user's manual ordering inside their parent (Todoist's `child_order`).
export interface TaskProjectNode {
  id: string;
  name: string;
  color: string;
  parentId: string | null;
  childOrder: number;
}

// Input for adding a task. Quick-add carries the title plus an optional
// due date (resolved YYYY-MM-DD by the popup so providers don't have to
// re-interpret "today"/"tomorrow" against shifting clocks). Both providers
// route the task to the user's Inbox / default project.
export interface TaskAddInput {
  title: string;
  // ISO date YYYY-MM-DD. Set when the user typed @today / @tomorrow /
  // @YYYY-MM-DD in the quick-add popup. Providers translate to their
  // native due-date field — Todoist's `due_date`, markdown's `@<date>`
  // token. Without it, no due is set.
  due?: string;
}

// Result of a Todoist fetch — note it returns ALL tasks regardless of
// whether they're complete; renderer filters via the `done` flag.
export interface TaskFetchResult {
  tasks: TaskItem[];
  // Project tree (flat list with parentId). The renderer walks this to
  // render nested folds. Includes every project the user has, even empty
  // ones — the renderer skips them when their subtree count is zero.
  projects: TaskProjectNode[];
  // Top-level project name list — kept for legacy callers (drag preview,
  // day detail panel) that still group by name. New code should walk the
  // `projects` tree instead.
  projectOrder: string[];
  // project → hex color, keyed by both project name (legacy) and project
  // id, so callers can index by whichever they have.
  projectColor: Record<string, string>;
}

// ── Day rhythm (wake / sleep) ─────────────────────────────────────────
// Rhythm changes are time-versioned: the user can swap their default at
// any point and dates BEFORE the change keep their old default. Days
// after the change pick up the new one. Per-day overrides win above both.
export interface RhythmDefault {
  // YYYY-MM-DD; this default applies to dates >= fromDate, until superseded
  // by a later entry. The first entry in the list is the historical
  // baseline (typically fromDate '0000-01-01').
  fromDate: string;
  wakeMin: number;   // minutes from midnight (0..1440)
  sleepMin: number;
}

export interface RhythmOverride {
  wakeMin?: number;
  sleepMin?: number;
}

export interface RhythmData {
  defaults: RhythmDefault[];                 // sorted ascending by fromDate
  overrides: Record<string, RhythmOverride>; // YYYY-MM-DD → override
}

// Push payload for `IPC.SettingsChanged`. We send the full settings.json
// shape so the renderer can apply slices without bouncing back to fetch.
export interface SettingsPushPayload {
  ui: UiSettings;
  weatherIcsUrl: string | null;
  taskProviderId: TaskProviderId;
}

// Where to keep yCal's cloud-synced files (rhythm.json, tasks-schedule.json).
// iCloud Drive on macOS lets the files follow the user across devices via
// the system iCloud sync. Falls back to the local userData dir when
// unavailable (non-macOS, or iCloud Drive disabled).
export type CloudStorage = 'icloud' | 'local';

export interface CloudStorageInfo {
  // Effective storage in use right now. May differ from preference if iCloud
  // Drive isn't available.
  effective: CloudStorage;
  // Preference the user picked. Always reflects the toggle's state.
  preferred: CloudStorage;
  // Resolved absolute directory holding cloud-stored yCal files.
  dir: string;
  // True if the iCloud Drive folder exists and is writable on this machine.
  icloudAvailable: boolean;
}

/// Status of cross-device Drive sync. Mirrors what iOS DriveSyncStore
/// surfaces so the desktop and iOS panels can read consistently. Drive
/// sync is layered on top of cloudStore — files still live on disk per
/// cloudStorage, this struct just describes the round-trip with Drive.
export interface DriveSyncStatus {
  enabled: boolean;
  accountId: string | null;
  state: 'idle' | 'syncing' | 'error';
  lastError: string | null;
  lastPushedAt: number | null;   // epoch ms
  lastPulledAt: number | null;
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
  // Tasks (active provider does the talking)
  TasksGetProviderInfo: 'ycal:tasksGetProviderInfo',
  TasksListProviders: 'ycal:tasksListProviders',
  TasksSetActiveProvider: 'ycal:tasksSetActiveProvider',
  TasksSetCredentials: 'ycal:tasksSetCredentials',
  TasksList: 'ycal:tasksList',
  TasksClose: 'ycal:tasksClose',
  TasksReopen: 'ycal:tasksReopen',
  TasksAddComment: 'ycal:tasksAddComment',
  TasksAdd: 'ycal:tasksAdd',
  // Quick-add tag autocomplete pulls labels from the active provider
  // (Todoist /labels, or unique labels mined from tasks.md). Cached in
  // main with a short TTL so the popup feels instant.
  TasksListLabels: 'ycal:tasksListLabels',
  // Quick-add popup uses these to know the active provider's display name
  // (for the placeholder text), to dismiss itself, and to grow/shrink as
  // the suggestion dropdown opens / closes.
  WindowClose: 'ycal:windowClose',
  WindowResize: 'ycal:windowResize',
  TasksGetLocal: 'ycal:tasksGetLocal',     // schedule + done overlay (cloud)
  TasksSetLocal: 'ycal:tasksSetLocal',
  TasksRevealStorage: 'ycal:tasksRevealStorage',  // markdown provider only
  // Day rhythm
  RhythmGet: 'ycal:rhythmGet',
  RhythmSetOverride: 'ycal:rhythmSetOverride',
  RhythmClearOverride: 'ycal:rhythmClearOverride',
  RhythmSetDefault: 'ycal:rhythmSetDefault',
  // Cloud (iCloud / local) — covers rhythm + task schedule + future files.
  CloudGetStorageInfo: 'ycal:cloudGetStorageInfo',
  CloudSetStorage: 'ycal:cloudSetStorage',
  // Cross-device sync via Google Drive's appdata folder. Layered on top
  // of cloudStore so users can keep iCloud (Mac↔Mac) AND Drive (Mac↔
  // iPhone) sync at once. See main/driveSync.ts.
  DriveSyncGetStatus: 'ycal:driveSyncGetStatus',
  DriveSyncSetEnabled: 'ycal:driveSyncSetEnabled',
  DriveSyncSetAccount: 'ycal:driveSyncSetAccount',
  DriveSyncPushNow: 'ycal:driveSyncPushNow',
  DriveSyncPullNow: 'ycal:driveSyncPullNow',
  DriveSyncStatusChanged: 'ycal:driveSyncStatusChanged',  // main → renderer push
  // Cross-device sync — main → renderer pushes when a synced file changes
  // on disk (typically because iCloud Drive just delivered an edit from
  // another Mac). Payload is the new state for the affected slice; the
  // renderer applies it idempotently. cloudStore dedupes by content so
  // we don't churn writes when a remote update equals what we already
  // have. See `cloudStore.startCloudWatcher()`.
  SettingsChanged: 'ycal:settingsChanged',
  RhythmChanged: 'ycal:rhythmChanged',
  TasksLocalChanged: 'ycal:tasksLocalChanged',
  TasksProviderDataChanged: 'ycal:tasksProviderDataChanged',
  // Sent to the persistent quick-add popup when it's about to be re-shown,
  // so the renderer can clear the input field and reset suggestion state
  // before the user sees the window again.
  QuickAddReset: 'ycal:quickAddReset',
} as const;
