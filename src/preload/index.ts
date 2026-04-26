import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '@shared/types';
import type {
  AccountSummary,
  CalendarSummary,
  CalendarEvent,
  GoogleColors,
  ListEventsRequest,
  UiSettings,
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
};

contextBridge.exposeInMainWorld('ycal', api);

export type YCalApi = typeof api;
