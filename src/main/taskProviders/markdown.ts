// yCal — markdown task provider.
//
// Backs onto a single `tasks.md` file routed through cloudStore (so the
// file lives in iCloud Drive or userData depending on Settings → Sync).
// No credentials needed: the file is created on first list call if it
// doesn't yet exist. Editing is two-way:
//
//   * yCal toggles done state and appends comments through this provider —
//     in-place line edits, so user-authored prose between blocks survives.
//   * The user edits the file in any markdown editor — yCal picks the
//     change up on the next refresh (5-min poll + window-focus re-fetch).
//
// What this is NOT:
//   * A general markdown ingester — yCal recognises heading-as-project
//     and `- [ ]`-as-task patterns. Anything else is preserved on read
//     but not interpreted.
//   * A network call — everything happens locally on disk.

import { existsSync } from 'node:fs';
import { shell } from 'electron';
import type {
  TaskAddInput, TaskComment, TaskFetchResult, TaskItem,
} from '@shared/types';
import type { TaskProvider } from './types';
import { pathFor, readText, writeText } from '../cloudStore';
import {
  appendComment, appendTaskToInbox, parse, setTaskDone,
} from './markdownDoc';

const FILE = 'tasks.md';

// Initial scaffold for a brand-new file. The placeholder Inbox heading
// gives the user a visible target for the first task even before they
// know the format. Comment block doubles as inline help.
const SEED = `# Inbox

<!--
  yCal stores tasks in this file. The format:

    # Project Name {#hexcolor?}     ← top-level project
    ## Section Name                 ← nested project (any depth)

    - [ ] Task title  @2026-05-15 !p2 #30m #high #office  ^id
      Indented plain text becomes the description.
      - [ ] Subtask                 ← indented task = subtask
      > [2026-05-01] A comment

  After the title:
    @YYYY-MM-DD              due date
    @every Mon Wed           weekday recurrence (also: @daily, @weekdays)
    !p1 .. !p4               priority. !p1 = highest, !p4 = default.
    #30m / #1h / #1h30m      duration label
    #low / #mid / #high      energy label
    #anything-else           location label (first one wins)
    ^xxxxxxxx                stable block id — yCal auto-assigns one if
                             missing, so don't worry about it.

  Edit this file in any markdown editor. yCal picks up changes on
  refresh (5-min poll, or when the app gains focus).
-->
`;

function ensureFileExists(): void {
  const { path: p } = pathFor(FILE);
  if (existsSync(p)) return;
  writeText(FILE, SEED);
}

export const markdownProvider: TaskProvider = {
  id: 'markdown',
  displayName: 'Markdown file',
  credentialsHint: '',

  hasCredentials() {
    // Markdown is credential-free — the file is the credential. As long
    // as cloudStore can resolve a path (which it can on macOS without
    // iCloud being available too — falls back to userData), we're good.
    return true;
  },

  setCredentials(_input: string | null) {
    // No-op. The provider always writes to `tasks.md` in the cloudStore-
    // routed dir. Pointing at a different file would mean carrying a
    // path config in device.json; we'll wire that up if anyone asks.
  },

  async listTasks(): Promise<TaskFetchResult> {
    ensureFileExists();
    const md = readText(FILE, '');
    const doc = parse(md);
    if (doc.needsRewrite) {
      // The parser assigned new block-ids to tasks that didn't have them.
      // Persist so the IDs survive across runs.
      writeText(FILE, doc.lines.join('\n'));
    }

    const tasks: TaskItem[] = doc.tasks;

    // Top-level project order — name list of every level-1 heading we saw.
    // The renderer's panel groups by top-level name and walks the tree
    // separately for nested folds.
    const projectOrder = doc.projectOrder.slice();
    return {
      tasks,
      projects: doc.projects,
      projectOrder,
      projectColor: doc.projectColor,
    };
  },

  async closeTask(taskId: string): Promise<void> {
    const md = readText(FILE, '');
    const doc = parse(md);
    const next = setTaskDone(doc, taskId, true);
    if (next === null) {
      throw new Error(`closeTask: task ${taskId} not found in tasks.md`);
    }
    writeText(FILE, next);
  },

  async reopenTask(taskId: string): Promise<void> {
    const md = readText(FILE, '');
    const doc = parse(md);
    const next = setTaskDone(doc, taskId, false);
    if (next === null) {
      throw new Error(`reopenTask: task ${taskId} not found in tasks.md`);
    }
    writeText(FILE, next);
  },

  async addTask(input: TaskAddInput): Promise<{ id: string }> {
    ensureFileExists();
    const md = readText(FILE, '');
    const { body, id } = appendTaskToInbox(md, input.title);
    writeText(FILE, body);
    return { id };
  },

  async addComment(taskId: string, text: string): Promise<TaskComment> {
    const md = readText(FILE, '');
    const doc = parse(md);
    const result = appendComment(doc, taskId, text, new Date());
    if (!result) {
      throw new Error(`addComment: task ${taskId} not found in tasks.md`);
    }
    writeText(FILE, result.body);
    return result.comment;
  },
};

// Provider-specific helper for the Settings UI: open the markdown file
// in the user's default editor. Exposed via the TasksRevealStorage IPC
// when the markdown provider is active.
export function revealMarkdownFile(): void {
  ensureFileExists();
  const { path: p } = pathFor(FILE);
  void shell.openPath(p);
}
