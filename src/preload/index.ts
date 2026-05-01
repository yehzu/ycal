import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '@shared/types';
import type {
  AccountSummary,
  CalendarSummary,
  CalendarEvent,
  CloudStorage,
  CloudStorageInfo,
  GoogleColors,
  ListEventsRequest,
  RhythmData,
  TaskComment,
  TaskFetchResult,
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
  listEvents: (req: ListEventsRequest): Promise<Result<{ events: CalendarEvent[] }>> =>
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
};

contextBridge.exposeInMainWorld('ycal', api);

export type YCalApi = typeof api;
