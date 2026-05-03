// yCal — Todoist task provider.
//
// Implements the TaskProvider interface against Todoist's unified API v1
// (the v2 REST endpoints started returning 410 Gone in late 2026; the v1
// API at https://api.todoist.com/api/v1/... is the supported successor).
//
// Auth is the user's personal API token, pasted in Settings → Tasks. The
// token is encrypted at rest with safeStorage (Keychain on macOS) — same
// treatment as the OAuth refresh tokens for Google.
//
// Response unwrapping note: v1 list endpoints return either a bare array
// (for compat) or { results, next_cursor } pages. We accept both. The
// project endpoint may also return either shape depending on the account
// state, so we normalise everywhere through `unwrapList`.

import { app, safeStorage } from 'electron';
import {
  existsSync, mkdirSync, readFileSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type {
  TaskAddInput, TaskComment, TaskFetchResult, TaskItem, TaskProjectNode,
} from '@shared/types';
import type { TaskProvider } from './types';
import { parseTaskMeta } from './labels';

const KEY_FILE = (): string => path.join(app.getPath('userData'), 'todoist.key');
const API_BASE = 'https://api.todoist.com/api/v1';

// ── Project palette ────────────────────────────────────────────────────
// Todoist's color tokens → hex. Unknown colors fall back to a neutral.
const TODOIST_COLOR_MAP: Record<string, string> = {
  berry_red: '#b8255f',
  red: '#cc3333',
  orange: '#c9572c',
  yellow: '#a39000',
  olive_green: '#7c8a39',
  lime_green: '#5f9747',
  green: '#3a8a48',
  mint_green: '#3aa17a',
  teal: '#3a8aa1',
  sky_blue: '#5897c5',
  light_blue: '#5b7a8e',
  blue: '#4870c5',
  grape: '#7b4ec5',
  violet: '#915ec5',
  lavender: '#9c7cc5',
  magenta: '#b54398',
  salmon: '#cc736e',
  charcoal: '#5b5b5b',
  grey: '#7b7b7b',
  taupe: '#8a7c5b',
};

// ── Wire types ─────────────────────────────────────────────────────────

interface RestProject {
  id: string;
  name: string;
  color: string;
  parent_id: string | null;
  child_order?: number;
  order?: number;
}

interface RestDue {
  date: string;
  string?: string;
  is_recurring?: boolean;
  datetime?: string;
}

interface RestTask {
  id: string;
  project_id: string | null;
  parent_id?: string | null;
  content: string;
  description?: string;
  is_completed?: boolean;
  due?: RestDue | null;
  comment_count?: number;
  labels?: string[];
  // Todoist priority: 1 (default) → 4 (highest, "P1" in the UI).
  priority?: number;
}

interface RestComment {
  id: string;
  task_id?: string;
  posted_at: string;
  content: string;
  posted_uid?: string;
}

interface RestLabel {
  id: string;
  name: string;
  order?: number;
}

// Cache the user's full label list — these change rarely, but we hit this
// endpoint every time the popup opens its autocomplete. 5 minutes matches
// the calendar list cache.
const LABELS_TTL_MS = 5 * 60_000;
let labelsCache: { at: number; labels: string[] } | null = null;

// v1 paginates list endpoints with a cursor. We follow it until exhausted.
interface PageResponse<T> {
  results?: T[];
  next_cursor?: string | null;
}

// ── Key storage ────────────────────────────────────────────────────────

interface KeyDisk { version: 1; key_enc: string }

function hasKeyOnDisk(): boolean {
  const f = KEY_FILE();
  if (!existsSync(f)) return false;
  try {
    const raw = readFileSync(f, 'utf-8');
    if (!raw) return false;
    const parsed = JSON.parse(raw) as KeyDisk;
    return parsed.version === 1 && !!parsed.key_enc;
  } catch {
    return false;
  }
}

function writeKey(key: string | null): void {
  const f = KEY_FILE();
  if (!key || !key.trim()) {
    if (existsSync(f)) {
      writeFileSync(f, '', { encoding: 'utf-8', mode: 0o600 });
    }
    return;
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('safeStorage encryption is unavailable; cannot persist Todoist key.');
  }
  const enc = safeStorage.encryptString(key.trim()).toString('base64');
  const payload: KeyDisk = { version: 1, key_enc: enc };
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify(payload), { encoding: 'utf-8', mode: 0o600 });
}

function loadKey(): string | null {
  const f = KEY_FILE();
  if (!existsSync(f)) return null;
  try {
    const raw = readFileSync(f, 'utf-8');
    if (!raw) return null;
    const parsed = JSON.parse(raw) as KeyDisk;
    if (parsed.version !== 1) return null;
    return safeStorage.decryptString(Buffer.from(parsed.key_enc, 'base64'));
  } catch {
    return null;
  }
}

// ── HTTP ───────────────────────────────────────────────────────────────

async function rest<T>(
  apiKey: string, method: 'GET' | 'POST',
  endpoint: string, body?: unknown,
): Promise<T> {
  const r = await fetch(API_BASE + endpoint, {
    method,
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`Todoist ${method} ${endpoint} → ${r.status} ${r.statusText}${text ? ': ' + text.slice(0, 240) : ''}`);
  }
  if (r.status === 204) return undefined as unknown as T;
  return await r.json() as T;
}

// Many v1 list endpoints page their results. Walk the cursor until done.
async function listAll<T>(apiKey: string, endpoint: string): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | null | undefined = undefined;
  let safety = 0;
  // Hard limit on cursor follows in case the server returns the same
  // cursor twice; better to truncate than to spin forever.
  while (safety++ < 50) {
    const ep: string = cursor
      ? `${endpoint}${endpoint.includes('?') ? '&' : '?'}cursor=${encodeURIComponent(cursor)}`
      : endpoint;
    const res: PageResponse<T> | T[] = await rest<PageResponse<T> | T[]>(apiKey, 'GET', ep);
    if (Array.isArray(res)) {
      // Older / compat shape — bare array, no cursor.
      out.push(...res);
      return out;
    }
    if (res.results) out.push(...res.results);
    cursor = res.next_cursor;
    if (!cursor) return out;
  }
  return out;
}

// ── Helpers ────────────────────────────────────────────────────────────

function parseRecurDow(due: RestDue | null | undefined): { dow: number[] } | null {
  if (!due?.is_recurring || !due?.string) return null;
  const s = due.string.toLowerCase();
  if (!s.includes('every')) return null;
  if (/every day|daily/.test(s)) return { dow: [0, 1, 2, 3, 4, 5, 6] };
  if (/every weekday/.test(s)) return { dow: [1, 2, 3, 4, 5] };
  if (/every weekend/.test(s)) return { dow: [0, 6] };
  const map: Record<string, number> = {
    sun: 0, sunday: 0,
    mon: 1, monday: 1,
    tue: 2, tues: 2, tuesday: 2,
    wed: 3, weds: 3, wednesday: 3,
    thu: 4, thur: 4, thurs: 4, thursday: 4,
    fri: 5, friday: 5,
    sat: 6, saturday: 6,
  };
  const dow: number[] = [];
  for (const [k, v] of Object.entries(map)) {
    if (new RegExp(`\\b${k}\\b`).test(s) && !dow.includes(v)) dow.push(v);
  }
  return dow.length > 0 ? { dow: dow.sort() } : null;
}

async function fetchCommentsForTasks(
  apiKey: string, taskIds: string[],
): Promise<Record<string, TaskComment[]>> {
  const out: Record<string, TaskComment[]> = {};
  if (taskIds.length === 0) return out;
  const responses = await Promise.allSettled(
    taskIds.map((id) =>
      listAll<RestComment>(apiKey, `/comments?task_id=${encodeURIComponent(id)}`)),
  );
  for (let i = 0; i < taskIds.length; i++) {
    const res = responses[i];
    if (res.status === 'fulfilled') {
      out[taskIds[i]] = res.value.map((c): TaskComment => ({
        id: c.id,
        author: 'Todoist',
        authorColor: '#5b7a8e',
        at: c.posted_at,
        text: c.content,
      }));
    } else {
      out[taskIds[i]] = [];
    }
  }
  return out;
}

// ── Provider impl ──────────────────────────────────────────────────────

export const todoistProvider: TaskProvider = {
  id: 'todoist',
  displayName: 'Todoist',
  credentialsHint:
    'Paste your personal API token from Todoist → Settings → Integrations → Developer.',

  hasCredentials() {
    return hasKeyOnDisk();
  },
  setCredentials(input: string | null) {
    writeKey(input);
  },

  async listTasks(): Promise<TaskFetchResult> {
    const key = loadKey();
    if (!key) throw new Error('Todoist API key not set.');

    const [tasksRaw, projectsRaw] = await Promise.all([
      listAll<RestTask>(key, '/tasks'),
      listAll<RestProject>(key, '/projects'),
    ]);

    const projById = new Map<string, RestProject>();
    for (const p of projectsRaw) projById.set(p.id, p);

    // Top-level project order — only roots, in the user's manual order.
    const projectOrder = projectsRaw
      .filter((p) => !p.parent_id)
      .slice()
      .sort((a, b) => (a.child_order ?? a.order ?? 0) - (b.child_order ?? b.order ?? 0))
      .map((p) => p.name);

    const projectColor: Record<string, string> = {};
    for (const p of projectsRaw) {
      const hex = TODOIST_COLOR_MAP[p.color] ?? '#5b7a8e';
      projectColor[p.name] = hex;
      // Also index by id so renderers that group by leaf project (rather
      // than top-level name) get the right color when two leaves share a
      // name across different parents.
      projectColor[p.id] = hex;
    }

    const projects: TaskProjectNode[] = projectsRaw.map((p) => ({
      id: p.id,
      name: p.name,
      color: TODOIST_COLOR_MAP[p.color] ?? '#5b7a8e',
      parentId: p.parent_id ?? null,
      childOrder: p.child_order ?? p.order ?? 0,
    }));

    const taskIdsWithComments = tasksRaw
      .filter((t) => (t.comment_count ?? 0) > 0)
      .map((t) => t.id);
    const commentsByTask = await fetchCommentsForTasks(key, taskIdsWithComments);

    const tasks: TaskItem[] = tasksRaw.map((t) => {
      const proj = t.project_id ? projById.get(t.project_id) : null;
      const meta = parseTaskMeta(
        t.content ?? '',
        t.description ?? '',
        t.labels ?? [],
      );
      const rawPri = typeof t.priority === 'number' ? t.priority : 1;
      const priority = (rawPri >= 1 && rawPri <= 4 ? rawPri : 1) as 1 | 2 | 3 | 4;
      return {
        id: t.id,
        projectId: t.project_id,
        parentId: t.parent_id ?? null,
        project: proj?.name ?? 'Inbox',
        title: meta.title || (t.content ?? ''),
        description: t.description ?? '',
        energy: meta.energy,
        location: meta.location,
        dur: meta.durMin,
        due: t.due?.date ?? null,
        recur: parseRecurDow(t.due),
        isRecurring: !!t.due?.is_recurring,
        priority,
        comments: commentsByTask[t.id] ?? [],
        done: !!t.is_completed,
        scheduledAt: null, // overlaid in renderer from local state
      };
    });

    return { tasks, projects, projectOrder, projectColor };
  },

  async closeTask(taskId: string): Promise<void> {
    const key = loadKey();
    if (!key) throw new Error('Todoist API key not set.');
    await rest<void>(key, 'POST', `/tasks/${encodeURIComponent(taskId)}/close`);
  },

  async reopenTask(taskId: string): Promise<void> {
    const key = loadKey();
    if (!key) throw new Error('Todoist API key not set.');
    await rest<void>(key, 'POST', `/tasks/${encodeURIComponent(taskId)}/reopen`);
  },

  async addTask(input: TaskAddInput): Promise<{ id: string }> {
    const key = loadKey();
    if (!key) throw new Error('Todoist API key not set.');
    const title = (input.title ?? '').trim();
    if (!title) throw new Error('Task title is required.');
    // No project_id → Todoist routes to Inbox by default.
    const created = await rest<{ id: string }>(key, 'POST', '/tasks', {
      content: title,
    });
    return { id: created.id };
  },

  async listLabels(): Promise<string[]> {
    const key = loadKey();
    if (!key) return [];
    const now = Date.now();
    if (labelsCache && now - labelsCache.at < LABELS_TTL_MS) {
      return labelsCache.labels;
    }
    try {
      const raw = await listAll<RestLabel>(key, '/labels');
      const labels = raw
        .slice()
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
        .map((l) => l.name)
        .filter((n) => n && n.length > 0);
      labelsCache = { at: now, labels };
      return labels;
    } catch {
      // Network blip — fall through to whatever the popup can derive from
      // the cached open tasks instead of failing the autocomplete entirely.
      return labelsCache?.labels ?? [];
    }
  },

  async addComment(taskId: string, text: string): Promise<TaskComment> {
    const key = loadKey();
    if (!key) throw new Error('Todoist API key not set.');
    const created = await rest<RestComment>(key, 'POST', '/comments', {
      task_id: taskId,
      content: text,
    });
    return {
      id: created.id,
      author: 'You',
      authorColor: '#5b7a8e',
      at: created.posted_at,
      text: created.content,
    };
  },
};
