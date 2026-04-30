// yCal — task provider registry.
//
// Single source of truth for "which provider does the IPC layer talk to?".
// Adding a new provider is a two-step move:
//   1. Drop a new file alongside todoist.ts implementing TaskProvider.
//   2. Register it in the PROVIDERS map below; bump ACTIVE_ID once you
//      want it as the default. (Or expose a setting that picks at runtime.)
//
// We keep ACTIVE_ID a `let` so a future Settings → Tasks dropdown can swap
// providers without an app restart. Today, with only Todoist available,
// the variable is effectively a constant.

import type { TaskProviderId, TaskProviderInfo } from '@shared/types';
import { describe, type TaskProvider } from './types';
import { todoistProvider } from './todoist';

const PROVIDERS: Record<TaskProviderId, TaskProvider> = {
  todoist: todoistProvider,
};

let ACTIVE_ID: TaskProviderId = 'todoist';

export function getActiveProvider(): TaskProvider {
  return PROVIDERS[ACTIVE_ID];
}

export function listProviders(): TaskProviderInfo[] {
  return Object.values(PROVIDERS).map(describe);
}

export function setActiveProvider(id: TaskProviderId): void {
  if (!(id in PROVIDERS)) {
    throw new Error(`Unknown task provider: ${id}`);
  }
  ACTIVE_ID = id;
}
