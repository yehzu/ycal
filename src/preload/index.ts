import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '@shared/types';
import type {
  AccountSummary,
  CalendarSummary,
  CalendarEvent,
  GoogleColors,
  ListEventsRequest,
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
  // Auto-update: trigger an explicit check, install a downloaded update, or
  // subscribe to the lifecycle stream pushed from main.
  checkForUpdates: (): Promise<UpdateStatus> => ipcRenderer.invoke(IPC.UpdateCheck),
  installUpdate: (): Promise<void> => ipcRenderer.invoke(IPC.UpdateInstall),
  onUpdateStatus: (handler: (status: UpdateStatus) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, status: UpdateStatus): void => handler(status);
    ipcRenderer.on(IPC.UpdateStatus, listener);
    return () => ipcRenderer.removeListener(IPC.UpdateStatus, listener);
  },
};

contextBridge.exposeInMainWorld('ycal', api);

export type YCalApi = typeof api;
