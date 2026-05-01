// yCal — task provider registry.
//
// Single source of truth for "which provider does the IPC layer talk to?".
// Adding a new provider is a two-step move:
//   1. Drop a new file alongside todoist.ts implementing TaskProvider.
//   2. Register it in the PROVIDERS map below; it'll appear in Settings →
//      Tasks for the user to pick.
//
// The active id is persisted in settings.json (so it follows the user
// across Macs) and resolved lazily — getActiveProvider() re-reads on
// every call so a provider switch is picked up by the next IPC handler
// without an app restart. The renderer triggers a refresh after the
// switch IPC returns.

import type { TaskProviderId, TaskProviderInfo } from '@shared/types';
import { describe, type TaskProvider } from './types';
import { todoistProvider } from './todoist';
import { markdownProvider } from './markdown';
import { getTaskProviderId, setTaskProviderId } from '../settings';

const PROVIDERS: Record<TaskProviderId, TaskProvider> = {
  todoist: todoistProvider,
  markdown: markdownProvider,
};

export function getActiveProvider(): TaskProvider {
  const id = getTaskProviderId();
  return PROVIDERS[id] ?? PROVIDERS.todoist;
}

export function listProviders(): TaskProviderInfo[] {
  const activeId = getTaskProviderId();
  return Object.values(PROVIDERS).map((p) => ({
    ...describe(p),
    active: p.id === activeId,
  }));
}

export function getActiveProviderInfo(): TaskProviderInfo {
  const p = getActiveProvider();
  return { ...describe(p), active: true };
}

export function setActiveProvider(id: TaskProviderId): TaskProviderInfo {
  if (!(id in PROVIDERS)) {
    throw new Error(`Unknown task provider: ${id}`);
  }
  setTaskProviderId(id);
  return getActiveProviderInfo();
}

export { revealMarkdownFile } from './markdown';
