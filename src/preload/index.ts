import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '@shared/types';
import type {
  AccountSummary,
  AttendeeSuggestion,
  CalendarSummary,
  CalendarEvent,
  CalendarFetchFailure,
  CloudStorage,
  CloudStorageInfo,
  DriveSyncStatus,
  EventGlossary,
  GlossaryEntry,
  GlossaryFile,
  GoogleColors,
  ListEventsRequest,
  MeetingArchiveSummary,
  MeetingArtifactKind,
  MeetingNote,
  MeetingNoteSummary,
  NoteOverlay,
  NotesOverlayFile,
  RecentRecording,
  RecorderMeetSignal,
  RecorderSetupProgress,
  RecorderSetupStatus,
  RecordingStatus,
  RhythmData,
  SettingsPushPayload,
  TaskComment,
  TaskFetchResult,
  TaskProviderId,
  TaskProviderInfo,
  TasksLocalState,
  UiSettings,
  UpdateStatus,
  WeatherDay,
} from '@shared/types';

type Result<T> = { ok: true } & T | { ok: false; error: string };

const api = {
  isConfigured: (): Promise<boolean> => ipcRenderer.invoke(IPC.IsConfigured),
  addAccount: (): Promise<Result<{ account: AccountSummary }>> =>
    ipcRenderer.invoke(IPC.AddAccount),
  removeAccount: (id: string): Promise<{ ok: true }> =>
    ipcRenderer.invoke(IPC.RemoveAccount, id),
  listAccounts: (): Promise<AccountSummary[]> => ipcRenderer.invoke(IPC.ListAccounts),
  listCalendars: (): Promise<Result<{ calendars: CalendarSummary[] }>> =>
    ipcRenderer.invoke(IPC.ListCalendars),
  listEvents: (req: ListEventsRequest): Promise<Result<{ events: CalendarEvent[]; failures: CalendarFetchFailure[] }>> =>
    ipcRenderer.invoke(IPC.ListEvents, req),
  getColors: (): Promise<Result<{ colors: GoogleColors }>> =>
    ipcRenderer.invoke(IPC.GetColors),
  getWeatherUrl: (): Promise<string | null> => ipcRenderer.invoke(IPC.GetWeatherUrl),
  setWeatherUrl: (url: string | null): Promise<Result<{}>> =>
    ipcRenderer.invoke(IPC.SetWeatherUrl, url),
  getWeather: (): Promise<Result<{ days: WeatherDay[] }>> =>
    ipcRenderer.invoke(IPC.GetWeather),
  getUiSettings: (): Promise<UiSettings> => ipcRenderer.invoke(IPC.GetUiSettings),
  setUiSettings: (patch: Partial<UiSettings>): Promise<Result<{}>> =>
    ipcRenderer.invoke(IPC.SetUiSettings, patch),
  // Auto-update.
  checkForUpdates: (): Promise<UpdateStatus> => ipcRenderer.invoke(IPC.UpdateCheck),
  installUpdate: (): Promise<void> => ipcRenderer.invoke(IPC.UpdateInstall),
  onUpdateStatus: (handler: (status: UpdateStatus) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, status: UpdateStatus): void => handler(status);
    ipcRenderer.on(IPC.UpdateStatus, listener);
    return () => ipcRenderer.removeListener(IPC.UpdateStatus, listener);
  },

  // Tasks (provider-backed)
  tasksGetProviderInfo: (): Promise<TaskProviderInfo> =>
    ipcRenderer.invoke(IPC.TasksGetProviderInfo),
  tasksListProviders: (): Promise<TaskProviderInfo[]> =>
    ipcRenderer.invoke(IPC.TasksListProviders),
  tasksSetActiveProvider: (id: 'todoist' | 'markdown'): Promise<Result<{ info: TaskProviderInfo }>> =>
    ipcRenderer.invoke(IPC.TasksSetActiveProvider, id),
  tasksRevealStorage: (): Promise<void> => ipcRenderer.invoke(IPC.TasksRevealStorage),
  tasksSetCredentials: (key: string | null): Promise<Result<{}>> =>
    ipcRenderer.invoke(IPC.TasksSetCredentials, key),
  tasksList: (): Promise<Result<TaskFetchResult>> => ipcRenderer.invoke(IPC.TasksList),
  tasksClose: (taskId: string): Promise<Result<{}>> => ipcRenderer.invoke(IPC.TasksClose, taskId),
  tasksReopen: (taskId: string): Promise<Result<{}>> => ipcRenderer.invoke(IPC.TasksReopen, taskId),
  tasksAddComment: (taskId: string, text: string): Promise<Result<{ comment: TaskComment }>> =>
    ipcRenderer.invoke(IPC.TasksAddComment, taskId, text),
  tasksAdd: (input: { title: string; due?: string }): Promise<Result<{ id: string }>> =>
    ipcRenderer.invoke(IPC.TasksAdd, input),
  tasksListLabels: (): Promise<Result<{ labels: string[] }>> =>
    ipcRenderer.invoke(IPC.TasksListLabels),
  closeWindow: (): Promise<void> => ipcRenderer.invoke(IPC.WindowClose),
  resizeWindow: (height: number): Promise<void> =>
    ipcRenderer.invoke(IPC.WindowResize, height),
  tasksGetLocal: (): Promise<TasksLocalState> => ipcRenderer.invoke(IPC.TasksGetLocal),
  tasksSetLocal: (patch: Partial<TasksLocalState>): Promise<Result<{ state: TasksLocalState }>> =>
    ipcRenderer.invoke(IPC.TasksSetLocal, patch),

  // Day rhythm — wake/sleep with per-day overrides.
  rhythmGet: (): Promise<RhythmData> => ipcRenderer.invoke(IPC.RhythmGet),
  rhythmSetOverride: (dateStr: string, patch: { wakeMin?: number; sleepMin?: number }): Promise<Result<{ data: RhythmData }>> =>
    ipcRenderer.invoke(IPC.RhythmSetOverride, dateStr, patch),
  rhythmClearOverride: (dateStr: string): Promise<Result<{ data: RhythmData }>> =>
    ipcRenderer.invoke(IPC.RhythmClearOverride, dateStr),
  rhythmSetDefault: (fromDateStr: string, next: { wakeMin: number; sleepMin: number }): Promise<Result<{ data: RhythmData }>> =>
    ipcRenderer.invoke(IPC.RhythmSetDefault, fromDateStr, next),

  // Cloud (iCloud-or-local) storage shared by rhythm + tasks schedule.
  cloudGetStorageInfo: (): Promise<CloudStorageInfo> => ipcRenderer.invoke(IPC.CloudGetStorageInfo),
  cloudSetStorage: (pref: CloudStorage): Promise<Result<{ info: CloudStorageInfo }>> =>
    ipcRenderer.invoke(IPC.CloudSetStorage, pref),

  // Cross-device sync via Google Drive's appdata folder. Layered on
  // top of cloudStore — see main/driveSync.ts.
  driveSyncGetStatus: (): Promise<DriveSyncStatus> =>
    ipcRenderer.invoke(IPC.DriveSyncGetStatus),
  driveSyncSetEnabled: (enabled: boolean): Promise<DriveSyncStatus> =>
    ipcRenderer.invoke(IPC.DriveSyncSetEnabled, enabled),
  driveSyncSetAccount: (accountId: string | null): Promise<DriveSyncStatus> =>
    ipcRenderer.invoke(IPC.DriveSyncSetAccount, accountId),
  driveSyncPushNow: (): Promise<Result<{ status: DriveSyncStatus }>> =>
    ipcRenderer.invoke(IPC.DriveSyncPushNow),
  driveSyncPullNow: (): Promise<Result<{ status: DriveSyncStatus }>> =>
    ipcRenderer.invoke(IPC.DriveSyncPullNow),
  onDriveSyncStatusChanged: (handler: (next: DriveSyncStatus) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, payload: DriveSyncStatus): void =>
      handler(payload);
    ipcRenderer.on(IPC.DriveSyncStatusChanged, listener);
    return () => ipcRenderer.removeListener(IPC.DriveSyncStatusChanged, listener);
  },

  // Cross-device push events. Each subscribes to a main → renderer push
  // channel and returns an unsubscribe fn. Fires when iCloud Drive
  // delivers an edit from another Mac. cloudStore dedupes by content so
  // our own writes don't echo back as fake remote events.
  onSettingsChanged: (handler: (next: SettingsPushPayload) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, payload: SettingsPushPayload): void =>
      handler(payload);
    ipcRenderer.on(IPC.SettingsChanged, listener);
    return () => ipcRenderer.removeListener(IPC.SettingsChanged, listener);
  },
  onRhythmChanged: (handler: (next: RhythmData) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, payload: RhythmData): void =>
      handler(payload);
    ipcRenderer.on(IPC.RhythmChanged, listener);
    return () => ipcRenderer.removeListener(IPC.RhythmChanged, listener);
  },
  onTasksLocalChanged: (handler: (next: TasksLocalState) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, payload: TasksLocalState): void =>
      handler(payload);
    ipcRenderer.on(IPC.TasksLocalChanged, listener);
    return () => ipcRenderer.removeListener(IPC.TasksLocalChanged, listener);
  },
  onTasksProviderDataChanged: (
    handler: (info: { providerId: TaskProviderId }) => void,
  ): (() => void) => {
    const listener = (
      _e: Electron.IpcRendererEvent,
      payload: { providerId: TaskProviderId },
    ): void => handler(payload);
    ipcRenderer.on(IPC.TasksProviderDataChanged, listener);
    return () => ipcRenderer.removeListener(IPC.TasksProviderDataChanged, listener);
  },
  // Quick-add popup uses this to clear its title/state when the persistent
  // window is re-shown by a fresh ⌘⇧Y chord.
  onQuickAddReset: (handler: () => void): (() => void) => {
    const listener = (): void => handler();
    ipcRenderer.on(IPC.QuickAddReset, listener);
    return () => ipcRenderer.removeListener(IPC.QuickAddReset, listener);
  },

  // Meeting recorder — list current recordings, start/stop manually, and
  // subscribe to state-transition pushes.
  recorderList: (): Promise<RecordingStatus[]> => ipcRenderer.invoke(IPC.RecorderList),
  recorderStart: (event: CalendarEvent): Promise<Result<{}>> =>
    ipcRenderer.invoke(IPC.RecorderStart, event),
  recorderStop: (eventId: string): Promise<Result<{}>> =>
    ipcRenderer.invoke(IPC.RecorderStop, eventId),
  onRecorderStatusChanged: (handler: (next: RecordingStatus[]) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, payload: RecordingStatus[]): void =>
      handler(payload);
    ipcRenderer.on(IPC.RecorderStatusChanged, listener);
    return () => ipcRenderer.removeListener(IPC.RecorderStatusChanged, listener);
  },

  // Recording auto-setup: probe + one-click install of ffmpeg, whisper-cpp,
  // and the whisper model. Progress streams over RecorderSetupProgress.
  recorderGetSetupStatus: (): Promise<RecorderSetupStatus> =>
    ipcRenderer.invoke(IPC.RecorderGetSetupStatus),
  recorderRunSetup: (): Promise<Result<{}>> =>
    ipcRenderer.invoke(IPC.RecorderRunSetup),
  recorderRunDiarizeSetup: (): Promise<Result<{}>> =>
    ipcRenderer.invoke(IPC.RecorderRunDiarizeSetup),
  onRecorderSetupProgress: (handler: (p: RecorderSetupProgress) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, payload: RecorderSetupProgress): void =>
      handler(payload);
    ipcRenderer.on(IPC.RecorderSetupProgress, listener);
    return () => ipcRenderer.removeListener(IPC.RecorderSetupProgress, listener);
  },

  // Browse + open finished recordings on disk.
  recorderListRecent: (limit?: number): Promise<RecentRecording[]> =>
    ipcRenderer.invoke(IPC.RecorderListRecent, limit ?? 50),
  recorderOpenFile: (path: string): Promise<Result<{}>> =>
    ipcRenderer.invoke(IPC.RecorderOpenFile, path),
  recorderRevealFolder: (): Promise<Result<{}>> =>
    ipcRenderer.invoke(IPC.RecorderRevealFolder),
  recorderRevealFile: (path: string): Promise<Result<{}>> =>
    ipcRenderer.invoke(IPC.RecorderRevealFile, path),
  recorderReprocess: (
    payload: { eventId: string; audioFile: string; title: string; accountId?: string; extraContext?: string },
  ): Promise<Result<{}>> =>
    ipcRenderer.invoke(IPC.RecorderReprocess, payload),
  recorderResummarize: (
    payload: { eventId: string; audioFile: string; title: string; accountId?: string; extraContext?: string },
  ): Promise<Result<{}>> =>
    ipcRenderer.invoke(IPC.RecorderResummarize, payload),
  recorderGetPeople: (): Promise<{ ok: true; body: string } | { ok: false; error: string }> =>
    ipcRenderer.invoke(IPC.RecorderGetPeople),
  recorderSetPeople: (body: string): Promise<Result<{}>> =>
    ipcRenderer.invoke(IPC.RecorderSetPeople, body),

  // Per-event meeting archive on the event-owning Google account's Drive
  // appdata. Returns local cached path; downloads if needed.
  meetingArchiveFetch: (
    payload: { eventId: string; accountId?: string | null; kind: MeetingArtifactKind },
  ): Promise<Result<{ path: string }>> =>
    ipcRenderer.invoke(IPC.MeetingArchiveFetch, payload),
  meetingArchiveList: (
    payload?: { eventId?: string; accountId?: string | null },
  ): Promise<Result<{ archives: MeetingArchiveSummary[] }>> =>
    ipcRenderer.invoke(IPC.MeetingArchiveList, payload),

  // Active Meet detection — read the live signal, subscribe to changes,
  // and run a diagnostic dump for debugging when detection misfires.
  recorderMeetSignal: (): Promise<RecorderMeetSignal> =>
    ipcRenderer.invoke(IPC.RecorderMeetSignal),
  onRecorderMeetSignalChanged: (handler: (s: RecorderMeetSignal) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, payload: RecorderMeetSignal): void =>
      handler(payload);
    ipcRenderer.on(IPC.RecorderMeetSignalChanged, listener);
    return () => ipcRenderer.removeListener(IPC.RecorderMeetSignalChanged, listener);
  },
  recorderDiagnoseDetection: (): Promise<Result<{ dump: string }>> =>
    ipcRenderer.invoke(IPC.RecorderDiagnoseDetection),

  // Glossary — transcription correction feedback.
  glossaryGet: (): Promise<GlossaryFile> => ipcRenderer.invoke(IPC.GlossaryGet),
  glossarySet: (entries: GlossaryEntry[]): Promise<Result<{ file: GlossaryFile }>> =>
    ipcRenderer.invoke(IPC.GlossarySet, entries),
  glossaryImport: (
    payload: { body: string; format?: 'json' | 'markdown' | 'csv' | 'auto' },
  ): Promise<Result<{
    parsed: number; added: number; updated: number; file: GlossaryFile;
  }>> =>
    ipcRenderer.invoke(IPC.GlossaryImport, payload),
  glossarySuggestAttendees: (lookBackDays?: number): Promise<Result<{
    suggestions: AttendeeSuggestion[];
  }>> =>
    ipcRenderer.invoke(IPC.GlossarySuggestAttendees, lookBackDays ?? 60),
  eventGlossaryGet: (eventId: string): Promise<Result<{ glossary: EventGlossary }>> =>
    ipcRenderer.invoke(IPC.EventGlossaryGet, eventId),
  eventGlossarySet: (
    payload: { eventId: string; accountId?: string | null; entries: GlossaryEntry[] },
  ): Promise<Result<{ glossary: EventGlossary }>> =>
    ipcRenderer.invoke(IPC.EventGlossarySet, payload),
  transcriptRead: (
    payload: { path: string; eventId?: string; accountId?: string | null },
  ): Promise<Result<{ body: string; source: 'local' | 'drive' }>> =>
    ipcRenderer.invoke(IPC.TranscriptRead, payload),
  onGlossaryChanged: (handler: (next: GlossaryFile) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, payload: GlossaryFile): void =>
      handler(payload);
    ipcRenderer.on(IPC.GlossaryChanged, listener);
    return () => ipcRenderer.removeListener(IPC.GlossaryChanged, listener);
  },

  // Meeting notes — the editorial Notes view. listNotes() drives the
  // master list; noteGet() fetches one full structured note; the overlay
  // pair persists user corrections (cloudStore, cross-device).
  notesList: (): Promise<Result<{ notes: MeetingNoteSummary[] }>> =>
    ipcRenderer.invoke(IPC.NotesList),
  // Local-only fast path — paints the Notes list instantly; notesList()
  // is called right after to merge in cross-Mac Drive archives.
  notesListLocal: (): Promise<Result<{ notes: MeetingNoteSummary[] }>> =>
    ipcRenderer.invoke(IPC.NotesListLocal),
  noteGet: (
    payload: { eventId: string; accountId?: string | null },
  ): Promise<Result<{ note: MeetingNote }>> =>
    ipcRenderer.invoke(IPC.NoteGet, payload),
  notesGetOverlay: (): Promise<NotesOverlayFile> =>
    ipcRenderer.invoke(IPC.NotesGetOverlay),
  notesSetOverlay: (
    payload: { eventId: string; overlay: NoteOverlay },
  ): Promise<Result<{ file: NotesOverlayFile }>> =>
    ipcRenderer.invoke(IPC.NotesSetOverlay, payload),
  onNotesOverlayChanged: (handler: (next: NotesOverlayFile) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, payload: NotesOverlayFile): void =>
      handler(payload);
    ipcRenderer.on(IPC.NotesOverlayChanged, listener);
    return () => ipcRenderer.removeListener(IPC.NotesOverlayChanged, listener);
  },
};

contextBridge.exposeInMainWorld('ycal', api);

export type YCalApi = typeof api;
