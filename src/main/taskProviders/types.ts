// yCal — task provider interface.
//
// A provider is a backing store for tasks. To swap providers, drop a new
// file in this directory implementing this interface and register it in
// `index.ts`. The IPC layer talks to whichever provider is active; the
// renderer stays oblivious.
//
// What's in scope for a provider:
//   * Credentials (API key today; OAuth or path-to-folder later)
//   * List active tasks (with project/label metadata)
//   * Mark a task complete / reopen
//   * Post a comment on a task
//
// What's NOT in scope (lives in tasksStore + the renderer):
//   * Where the user has dropped a task on the calendar grid
//   * Whether the user marked it done "today" for the panel footer
//   * Carryover / auto-rollover

import type {
  TaskComment, TaskFetchResult, TaskProviderId, TaskProviderInfo,
} from '@shared/types';

export interface TaskProvider {
  readonly id: TaskProviderId;
  readonly displayName: string;
  readonly credentialsHint: string;

  hasCredentials(): boolean;
  setCredentials(input: string | null): void;

  listTasks(): Promise<TaskFetchResult>;
  closeTask(taskId: string): Promise<void>;
  reopenTask(taskId: string): Promise<void>;
  addComment(taskId: string, text: string): Promise<TaskComment>;
}

export function describe(p: TaskProvider): TaskProviderInfo {
  return {
    id: p.id,
    displayName: p.displayName,
    hasCredentials: p.hasCredentials(),
    credentialsHint: p.credentialsHint,
  };
}
