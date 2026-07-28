// yCal — Things 3 task provider.
//
// Things exposes a supported AppleScript dictionary on macOS. We use that
// interface for reads and writes instead of touching Things' private SQLite
// database. The first call can therefore trigger macOS' standard
// "yCal wants to control Things" permission prompt.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  TaskAddInput, TaskComment, TaskFetchResult, TaskItem, TaskProjectNode,
} from '@shared/types';
import type { TaskProvider } from './types';
import { parseTaskMeta } from './labels';

const execFileAsync = promisify(execFile);
const OSASCRIPT = '/usr/bin/osascript';
const APP_CANDIDATES = [
  '/Applications/Things3.app',
  path.join(homedir(), 'Applications', 'Things3.app'),
];

interface ThingsRef {
  id: string;
  name: string;
}

interface ThingsTaskWire {
  id: string;
  title: string;
  notes: string;
  due: string | null;
  activation: string | null;
  status: string;
  tagNames: string;
  project: ThingsRef | null;
  area: ThingsRef | null;
}

interface ThingsProjectWire extends ThingsRef {
  area: ThingsRef | null;
}

interface ThingsListWire {
  tasks: ThingsTaskWire[];
  projects: ThingsProjectWire[];
  areas: ThingsRef[];
  tags: ThingsRef[];
}

// Kept as one static script: user-controlled titles, notes, and ids are passed
// through argv, never interpolated into executable JavaScript.
const THINGS_JXA = String.raw`
function localDate(value) {
  if (!(value instanceof Date)) return null;
  const y = value.getFullYear();
  const m = String(value.getMonth() + 1).padStart(2, "0");
  const d = String(value.getDate()).padStart(2, "0");
  return y + "-" + m + "-" + d;
}

function findToDo(app, id) {
  const candidates = [
    function () { return app.toDos.byId(id); },
    function () { return app.lists.byName("Logbook").toDos.byId(id); },
    function () { return app.lists.byName("Trash").toDos.byId(id); }
  ];
  for (let i = 0; i < candidates.length; i++) {
    try {
      const item = candidates[i]();
      if (String(item.id()) === id) return item;
    } catch (_) {}
  }
  throw new Error("Things to-do not found: " + id);
}

function run(argv) {
  const app = Application(argv[0]);
  const action = argv[1];

  if (action === "labels") {
    const tags = app.tags;
    const ids = tags.id();
    const names = tags.name();
    return JSON.stringify(ids.map(function (id, i) {
      return { id: String(id), name: String(names[i] || "") };
    }));
  }

  if (action === "list") {
    // Request each property for the whole collection. This translates to a
    // handful of batched Apple Events instead of ~10 round-trips per task.
    const areaIds = app.areas.id();
    const areaNames = app.areas.name();
    const areas = areaIds.map(function (id, i) {
      return { id: String(id), name: String(areaNames[i] || "") };
    });
    const projectIds = app.projects.id();
    const projectNames = app.projects.name();
    const projectAreaIds = app.projects.area.id();
    const projectAreaNames = app.projects.area.name();
    const projects = projectIds.map(function (id, i) {
      return {
        id: String(id),
        name: String(projectNames[i] || ""),
        area: projectAreaIds[i]
          ? { id: String(projectAreaIds[i]), name: String(projectAreaNames[i] || "") }
          : null
      };
    });
    const tagIds = app.tags.id();
    const tagNames = app.tags.name();
    const tags = tagIds.map(function (id, i) {
      return { id: String(id), name: String(tagNames[i] || "") };
    });

    const ids = app.toDos.id();
    const titles = app.toDos.name();
    const notes = app.toDos.notes();
    const dueDates = app.toDos.dueDate();
    const activationDates = app.toDos.activationDate();
    const statuses = app.toDos.status();
    const taskTagNames = app.toDos.tagNames();
    const taskProjectIds = app.toDos.project.id();
    const taskProjectNames = app.toDos.project.name();
    const taskAreaIds = app.toDos.area.id();
    const taskAreaNames = app.toDos.area.name();
    const tasks = ids.map(function (id, i) {
      return {
        id: String(id),
        title: String(titles[i] || ""),
        notes: String(notes[i] || ""),
        due: localDate(dueDates[i]),
        activation: localDate(activationDates[i]),
        status: String(statuses[i]),
        tagNames: String(taskTagNames[i] || ""),
        project: taskProjectIds[i]
          ? { id: String(taskProjectIds[i]), name: String(taskProjectNames[i] || "") }
          : null,
        area: taskAreaIds[i]
          ? { id: String(taskAreaIds[i]), name: String(taskAreaNames[i] || "") }
          : null
      };
    });
    return JSON.stringify({ tasks: tasks, projects: projects, areas: areas, tags: tags });
  }

  if (action === "status") {
    const task = findToDo(app, argv[2]);
    task.status = argv[3];
    return JSON.stringify({ id: String(task.id()) });
  }

  if (action === "add") {
    const properties = { name: argv[2] };
    if (argv[3]) properties.dueDate = new Date(argv[3] + "T12:00:00");
    const task = app.ToDo(properties);
    app.toDos.push(task);
    return JSON.stringify({ id: String(task.id()) });
  }

  if (action === "comment") {
    const task = findToDo(app, argv[2]);
    const at = new Date().toISOString();
    const existing = String(task.notes() || "");
    const spacer = existing ? "\n\n" : "";
    task.notes = existing + spacer + "<!-- ycal-comment:" + at + " -->\n" + argv[3];
    return JSON.stringify({ id: String(task.id()), at: at });
  }

  throw new Error("Unknown yCal Things action: " + action);
}
`;

function thingsAppPath(): string | null {
  return APP_CANDIDATES.find((candidate) => existsSync(candidate)) ?? null;
}

async function runThings<T>(action: string, ...args: string[]): Promise<T> {
  const appPath = thingsAppPath();
  if (!appPath) {
    throw new Error('Things 3 is not installed in Applications.');
  }
  try {
    const { stdout } = await execFileAsync(
      OSASCRIPT,
      ['-l', 'JavaScript', '-e', THINGS_JXA, appPath, action, ...args],
      { timeout: 20_000, maxBuffer: 8 * 1024 * 1024 },
    );
    return JSON.parse(stdout.trim()) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/not authorized|permission|AppleEvent|(-1743)/i.test(message)) {
      throw new Error(
        'yCal needs permission to control Things 3. Enable yCal → Things in ' +
        'System Settings → Privacy & Security → Automation, then refresh.',
      );
    }
    throw new Error(`Things 3 integration failed: ${message}`);
  }
}

const PROJECT_COLORS = [
  '#4870c5', '#3a8a48', '#c9572c', '#915ec5',
  '#3a8aa1', '#b8255f', '#7c8a39', '#8a7c5b',
];

function colorFor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0;
  }
  return PROJECT_COLORS[Math.abs(hash) % PROJECT_COLORS.length];
}

function splitTags(input: string): string[] {
  return input.split(',').map((tag) => tag.trim()).filter(Boolean);
}

function parseComments(notes: string, taskId: string): {
  description: string;
  comments: TaskComment[];
} {
  const marker = /\n*<!-- ycal-comment:([^>\n]+) -->\n([\s\S]*?)(?=\n+<!-- ycal-comment:|$)/g;
  const comments: TaskComment[] = [];
  let firstMarker = notes.length;
  let match: RegExpExecArray | null;
  while ((match = marker.exec(notes)) !== null) {
    firstMarker = Math.min(firstMarker, match.index);
    comments.push({
      id: `things:${taskId}:${match[1]}`,
      author: 'You',
      authorColor: '#4870c5',
      at: match[1],
      text: match[2].trimEnd(),
    });
  }
  return {
    description: notes.slice(0, firstMarker).trimEnd(),
    comments,
  };
}

function priorityFromTags(tags: string[]): 1 | 2 | 3 | 4 {
  const values = new Set(tags.map((tag) => tag.toLowerCase()));
  if (values.has('p1')) return 4;
  if (values.has('p2')) return 3;
  if (values.has('p3')) return 2;
  return 1;
}

export const thingsProvider: TaskProvider = {
  id: 'things',
  displayName: 'Things 3',
  credentialsHint: '',

  hasCredentials() {
    // There is no token. Installation plus the one-time macOS Automation
    // grant is all that is required; listTasks surfaces a useful grant error.
    return thingsAppPath() !== null;
  },

  setCredentials(_input: string | null) {
    // Credential-free.
  },

  async listTasks(): Promise<TaskFetchResult> {
    const wire = await runThings<ThingsListWire>('list');
    const inboxId = 'things:inbox';
    const projects: TaskProjectNode[] = [{
      id: inboxId,
      name: 'Inbox',
      color: '#5b7a8e',
      parentId: null,
      childOrder: -1,
    }];

    for (let i = 0; i < wire.areas.length; i++) {
      const area = wire.areas[i];
      projects.push({
        id: area.id,
        name: area.name,
        color: colorFor(area.id),
        parentId: null,
        childOrder: i,
      });
    }
    for (let i = 0; i < wire.projects.length; i++) {
      const project = wire.projects[i];
      projects.push({
        id: project.id,
        name: project.name,
        color: colorFor(project.id),
        parentId: project.area?.id ?? null,
        childOrder: i,
      });
    }

    const projectColor: Record<string, string> = {
      [inboxId]: '#5b7a8e',
      Inbox: '#5b7a8e',
    };
    for (const project of projects) {
      projectColor[project.id] = project.color;
      projectColor[project.name] = project.color;
    }

    const tasks: TaskItem[] = wire.tasks.map((task) => {
      const tags = splitTags(task.tagNames);
      const { description, comments } = parseComments(task.notes, task.id);
      const meta = parseTaskMeta(task.title, description, tags);
      const container = task.project ?? task.area;
      return {
        id: task.id,
        projectId: container?.id ?? inboxId,
        parentId: null,
        project: container?.name ?? 'Inbox',
        title: meta.title || task.title,
        description,
        energy: meta.energy,
        location: meta.location,
        dur: meta.durMin,
        // Things' activation date ("When") determines when a task appears
        // in Today/Upcoming. Deadline is a fallback when no When is set.
        due: task.activation ?? task.due,
        recur: null,
        isRecurring: false,
        priority: priorityFromTags(tags),
        comments,
        done: task.status !== 'open',
        scheduledAt: null,
      };
    });

    return {
      tasks,
      projects,
      projectOrder: projects.filter((project) => !project.parentId).map((project) => project.name),
      projectColor,
    };
  },

  async closeTask(taskId: string): Promise<void> {
    await runThings<{ id: string }>('status', taskId, 'completed');
  },

  async reopenTask(taskId: string): Promise<void> {
    await runThings<{ id: string }>('status', taskId, 'open');
  },

  async addTask(input: TaskAddInput): Promise<{ id: string }> {
    const title = input.title.trim();
    if (!title) throw new Error('Task title is required.');
    const due = input.due && /^\d{4}-\d{2}-\d{2}$/.test(input.due) ? input.due : '';
    return await runThings<{ id: string }>('add', title, due);
  },

  async listLabels(): Promise<string[]> {
    const tags = await runThings<ThingsRef[]>('labels');
    return tags.map((tag) => tag.name).filter(Boolean);
  },

  async addComment(taskId: string, text: string): Promise<TaskComment> {
    const body = text.trim();
    if (!body) throw new Error('Comment cannot be empty.');
    const result = await runThings<{ id: string; at: string }>('comment', taskId, body);
    return {
      id: `things:${result.id}:${result.at}`,
      author: 'You',
      authorColor: '#4870c5',
      at: result.at,
      text: body,
    };
  },
};
