// yCal — markdown task store: parser + serializer + targeted edits.
//
// File format (everything yCal needs from a Todoist-equivalent store):
//
//   # Project name {#hexcolor}        ← top-level project (parentId = null)
//   ## Section name {#hexcolor}       ← child project (parentId = parent #)
//   ### …                             ← deeper nesting OK
//
//   - [ ] Task title  @2026-05-15 !p2 #30m #high #office  ^id
//     Indented plain text becomes the description (multiple lines allowed).
//     - [ ] Subtask title #15m  ^id
//     > [2026-05-01] First comment.
//     > [2026-05-02] Another comment.
//
//   - [x] Done task  ^id
//
// Tokens after the title:
//   @YYYY-MM-DD              due date (one)
//   @every <Mon|Tue|...>     weekday recurrence ("every Mon Wed", "every weekday")
//   @daily / @weekdays       shortcuts
//   !p1 .. !p4               priority. Mental model: !p1 = highest = Todoist 4.
//   #30m  #1h  #1h30m        duration (Troika label)
//   #low  #mid  #high        energy (Troika label)
//   #<anything-else>         location label (first wins)
//   ^xxxxxxxx                stable block id. Auto-assigned on first save
//                            when missing — the file is rewritten so the
//                            id sticks and survives renames.
//
// What lives outside this module:
//   * Local schedule overlay (where the user dropped a task in calendar)
//     stays in tasks-schedule.json. The markdown file does NOT carry it —
//     same design choice as the Todoist provider.
//   * Comments that don't have an ISO date prefix get parsed with the
//     current date — yCal can't reconstruct authoring time from plain text.

import { randomBytes } from 'node:crypto';
import type {
  TaskComment, TaskItem, TaskProjectNode,
} from '@shared/types';
import { parseTaskMeta } from './labels';

// ── Public types ─────────────────────────────────────────────────────

export interface MdDoc {
  projects: TaskProjectNode[];
  tasks: TaskItem[];
  // Top-level project name list, in document order. Drag preview + day
  // detail panel still group by name.
  projectOrder: string[];
  // project name | id → hex color.
  projectColor: Record<string, string>;
  // Original file lines, retained so we can do targeted in-place edits
  // (close/reopen/addComment) without re-emitting the whole document and
  // discarding any user-authored prose between blocks.
  lines: string[];
  // True when parse() had to assign new block-IDs to one or more tasks.
  // Caller should rewrite the file with the patched lines so the IDs stick.
  needsRewrite: boolean;
  // taskId → location data we need for in-place edits.
  taskIndex: Map<string, TaskLocation>;
}

interface TaskLocation {
  // Index into `lines` of the `- [ ] / - [x] Title …` line.
  headLine: number;
  // First and last (inclusive) line of this task's body block — children
  // (subtasks, description, comments) live in [headLine+1 .. bodyEnd].
  // bodyEnd === headLine when the task has no body.
  bodyEnd: number;
  // Indent (in spaces) of the head line. Subtask sibling indent is the
  // same; child indent is +2.
  indent: number;
}

// ── Palette for projects without an explicit color ───────────────────

const PALETTE = [
  '#5897c5', '#3a8a48', '#c9572c', '#7b4ec5', '#a39000',
  '#3aa17a', '#cc3333', '#5b7a8e', '#915ec5', '#b54398',
];

// ── Public API ───────────────────────────────────────────────────────

export function parse(md: string): MdDoc {
  const lines = md.split('\n');
  const projects: TaskProjectNode[] = [];
  const tasks: TaskItem[] = [];
  const taskIndex = new Map<string, TaskLocation>();
  const projectOrder: string[] = [];
  const projectColor: Record<string, string> = {};
  let needsRewrite = false;

  // Always-present synthetic Inbox so unparented tasks have somewhere to
  // live. Renderer hides empty projects, so users without an Inbox heading
  // see no extra noise.
  const INBOX_ID = 'proj/inbox';
  const inboxProject: TaskProjectNode = {
    id: INBOX_ID,
    name: 'Inbox',
    color: '#5b7a8e',
    parentId: null,
    childOrder: 0,
  };
  projects.push(inboxProject);
  projectOrder.push('Inbox');
  projectColor['Inbox'] = inboxProject.color;
  projectColor[INBOX_ID] = inboxProject.color;

  // Heading stack: tracks ancestors so we can resolve parentId for the
  // next heading by depth.
  interface HeadingFrame { id: string; level: number; }
  const stack: HeadingFrame[] = [];
  let currentProjectId: string | null = INBOX_ID;
  // Per-parent child index for stable childOrder values.
  const childCounts = new Map<string | null, number>();

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    const head = parseHeading(line);
    if (head) {
      while (stack.length && stack[stack.length - 1].level >= head.level) stack.pop();
      const parentId = stack.length > 0 ? stack[stack.length - 1].id : null;
      const id = projectIdFor(parentId, head.name);
      // If the user writes "# Inbox" we merge into the synthetic Inbox
      // entry rather than carry two projects with the same id. Same goes
      // for repeated headings — e.g. multiple "## Notes" sections under
      // different parents resolve to distinct ids via parentId namespacing,
      // so a true collision means the user genuinely listed the heading
      // twice; merging is still the right call.
      const existing = projects.find((p) => p.id === id);
      if (existing) {
        if (head.color) {
          existing.color = head.color;
          projectColor[existing.name] = head.color;
          projectColor[existing.id] = head.color;
        }
        stack.push({ id, level: head.level });
        currentProjectId = id;
        if (head.level === 1 && !projectOrder.includes(existing.name)) {
          projectOrder.push(existing.name);
        }
        i++;
        continue;
      }
      const childOrder = childCounts.get(parentId) ?? 0;
      childCounts.set(parentId, childOrder + 1);
      const color = head.color ?? PALETTE[projects.length % PALETTE.length];
      const project: TaskProjectNode = {
        id, name: head.name, color, parentId, childOrder,
      };
      projects.push(project);
      stack.push({ id, level: head.level });
      currentProjectId = id;
      projectColor[head.name] = color;
      projectColor[id] = color;
      if (head.level === 1) projectOrder.push(head.name);
      i++;
      continue;
    }

    // Top-level task: a `- [ ] / - [x] ` at zero indent.
    const taskHead = parseTaskHead(line, 0);
    if (taskHead) {
      const consumed = consumeTaskBlock(
        lines, i, /*indent*/ 0,
        /*parentTaskId*/ null,
        currentProjectId,
        tasks, taskIndex,
        () => { needsRewrite = true; },
      );
      i += consumed;
      continue;
    }

    i++;
  }

  // Drop projects that have no tasks AND aren't the Inbox — keeps the
  // panel quiet for placeholder headings the user has but hasn't filled.
  // (We keep Inbox even when empty so the empty-state still has a target.)
  const projectsWithTasks = new Set<string>();
  for (const t of tasks) {
    if (t.projectId) projectsWithTasks.add(t.projectId);
  }
  // Walk up the parent chain so a populated child keeps its parent visible.
  for (const id of Array.from(projectsWithTasks)) {
    let p = projects.find((q) => q.id === id);
    while (p && p.parentId) {
      projectsWithTasks.add(p.parentId);
      p = projects.find((q) => q.id === p!.parentId);
    }
  }
  const visibleProjects = projects.filter(
    (p) => p.id === INBOX_ID || projectsWithTasks.has(p.id),
  );

  // Post-parse: resolve task.project to the human-readable project name
  // for legacy callers that group by name (drag preview, day detail).
  // The renderer also has the full `projects` tree, so it can look up by
  // id when it needs the leaf name across nested projects.
  const nameById = new Map<string, string>();
  for (const p of projects) nameById.set(p.id, p.name);
  for (const t of tasks) {
    if (t.projectId && nameById.has(t.projectId)) {
      t.project = nameById.get(t.projectId)!;
    }
  }

  return {
    projects: visibleProjects,
    tasks,
    projectOrder,
    projectColor,
    lines,
    needsRewrite,
    taskIndex,
  };
}

// Mark a task complete or open. Returns the new file body when something
// changed, or null when the id couldn't be found / the state already matches.
export function setTaskDone(doc: MdDoc, taskId: string, done: boolean): string | null {
  const loc = doc.taskIndex.get(taskId);
  if (!loc) return null;
  const head = doc.lines[loc.headLine];
  const replaced = head.replace(
    /^(\s*-\s+)\[([ xX])\](\s)/,
    (_m, p1, _p2, p3) => `${p1}[${done ? 'x' : ' '}]${p3}`,
  );
  if (replaced === head) return null;
  const next = doc.lines.slice();
  next[loc.headLine] = replaced;
  return next.join('\n');
}

// Append a `- [ ] <title>` line to the user's Inbox section. If the file
// has no top-level "# Inbox" heading, we prepend one. Returns the new
// file body and the auto-assigned block id so the caller can refer to it.
//
// Insertion rules:
//   * If a "# Inbox" heading exists, insert at the END of its body —
//     immediately before the next top-level heading (or EOF). This means
//     manually-added Inbox notes / comments stay above the new task and
//     the task appears at the bottom of the Inbox list (matches the
//     "newest at the bottom" feel of an editor's append).
//   * If no Inbox heading exists, prepend one at the top of the file
//     followed by a blank line, then the task. We DON'T touch any
//     existing top of file (frontmatter, prose, other headings) — they
//     stay intact below the new Inbox.
export function appendTaskToInbox(
  body: string,
  title: string,
): { body: string; id: string } {
  const trimmed = title.replace(/\s+/g, ' ').trim();
  if (!trimmed) throw new Error('Task title is required.');
  const id = randomId(8);
  const taskLine = `- [ ] ${trimmed} ^${id}`;

  const lines = body.split('\n');
  const inboxIdx = findInboxHeadingIndex(lines);

  if (inboxIdx === -1) {
    const prefix = ['# Inbox', '', taskLine, ''];
    // If the file is empty (or just whitespace), drop the trailing blank.
    const tail = body.length === 0 ? [] : ['', ...lines];
    return { body: [...prefix, ...tail].join('\n').replace(/\n+$/, '\n'), id };
  }

  // Find end of the Inbox section: next top-level heading, or EOF.
  let endIdx = lines.length;
  for (let i = inboxIdx + 1; i < lines.length; i++) {
    if (/^#\s+/.test(lines[i])) { endIdx = i; break; }
  }
  // Walk backwards from endIdx to skip trailing blank lines so the new
  // task sticks to the end of the Inbox content rather than after a gap.
  let insertAt = endIdx;
  while (insertAt > inboxIdx + 1 && lines[insertAt - 1].trim() === '') insertAt--;

  const next = lines.slice();
  next.splice(insertAt, 0, taskLine);
  return { body: next.join('\n'), id };
}

function findInboxHeadingIndex(lines: string[]): number {
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^#\s+(.+?)(\s*\{#[0-9a-fA-F]{3,8}\})?\s*$/);
    if (m && m[1].trim().toLowerCase() === 'inbox') return i;
  }
  return -1;
}

// Append a comment to a task's block. Returns { body, comment }.
export function appendComment(
  doc: MdDoc,
  taskId: string,
  text: string,
  date: Date,
): { body: string; comment: TaskComment } | null {
  const loc = doc.taskIndex.get(taskId);
  if (!loc) return null;
  const dateStr = date.toISOString().slice(0, 10);
  const trimmed = text.replace(/\n+/g, ' ').trim();
  if (!trimmed) return null;
  const insertIndent = ' '.repeat(loc.indent + 2);
  const newLine = `${insertIndent}> [${dateStr}] ${trimmed}`;
  const next = doc.lines.slice();
  next.splice(loc.bodyEnd + 1, 0, newLine);
  const comment: TaskComment = {
    id: 'cmt-' + randomId(8),
    author: 'You',
    authorColor: '#5b7a8e',
    at: new Date(`${dateStr}T00:00:00`).toISOString(),
    text: trimmed,
  };
  return { body: next.join('\n'), comment };
}

// ── Internal helpers ─────────────────────────────────────────────────

function consumeTaskBlock(
  lines: string[],
  start: number,
  indent: number,
  parentTaskId: string | null,
  projectId: string | null,
  out: TaskItem[],
  index: Map<string, TaskLocation>,
  flagRewrite: () => void,
): number {
  const head = parseTaskHead(lines[start], indent);
  if (!head) return 1; // Caller invariant; just skip if mismatched.

  let id = head.id;
  if (!id) {
    id = randomId(8);
    flagRewrite();
    // Patch the head line in-place so the rewritten file carries the id.
    lines[start] = appendBlockId(lines[start], id);
  }

  // Push the task into `out` early so children that come from recursion
  // appear AFTER their parent — preserves document order in the panel.
  // We mutate description/comments/done/etc as we go.
  const item: TaskItem = {
    id,
    projectId,
    parentId: parentTaskId,
    // `project` is filled in post-parse via the projects array. Inbox is
    // a safe placeholder — it gets overwritten before we return to the
    // caller of parse() unless this task's project really is Inbox.
    project: 'Inbox',
    title: head.title,
    description: '',
    energy: 'mid',
    location: '',
    dur: 0,
    due: head.due,
    recur: head.recur,
    isRecurring: head.isRecurring,
    priority: head.priority,
    comments: [],
    done: head.done,
    scheduledAt: null,
  };
  out.push(item);

  const description: string[] = [];

  const bodyIndent = indent + 2;
  let i = start + 1;
  let trailingBlankCount = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === '') {
      // Defer blank lines — include them in description ONLY if more body
      // content follows. Stop counting them on a sibling/dedented line.
      trailingBlankCount++;
      i++;
      continue;
    }

    const leading = countLeadingSpaces(line);
    if (leading < bodyIndent) {
      // Dedented — task block ends. Don't consume this line.
      break;
    }

    // We've decided this line belongs to the task block. Flush any
    // accumulated blank lines into the description as paragraph breaks.
    if (description.length > 0 && trailingBlankCount > 0) {
      description.push('');
    }
    trailingBlankCount = 0;

    const rest = line.slice(bodyIndent);

    // Subtask?
    const subHead = parseTaskHead(line, bodyIndent);
    if (subHead) {
      const consumed = consumeTaskBlock(
        lines, i, bodyIndent, id, projectId, out, index, flagRewrite,
      );
      i += consumed;
      continue;
    }

    // Comment line ("> [date] text" or just "> text").
    const cm = rest.match(/^>\s*(\[(\d{4}-\d{2}-\d{2})\]\s*)?(.*)$/);
    if (cm) {
      const at = cm[2]
        ? new Date(`${cm[2]}T00:00:00`).toISOString()
        : new Date().toISOString();
      const ctext = (cm[3] ?? '').trim();
      if (ctext.length > 0) {
        item.comments.push({
          id: 'cmt-' + randomId(6),
          author: 'You',
          authorColor: '#5b7a8e',
          at,
          text: ctext,
        });
      }
      i++;
      continue;
    }

    // Plain description line.
    description.push(rest.trim());
    i++;
  }

  const bodyEnd = (() => {
    // Find the last non-blank in-block line that belongs to this task.
    let last = start;
    for (let j = start + 1; j < i; j++) {
      const line = lines[j];
      if (line.trim() === '') continue;
      const leading = countLeadingSpaces(line);
      if (leading < bodyIndent) continue;
      last = j;
    }
    return last;
  })();

  index.set(id, { headLine: start, bodyEnd, indent });

  const meta = parseTaskMeta(head.title, description.join('\n'), head.labels);
  item.title = meta.title || head.title;
  item.description = description.join('\n').trim();
  item.energy = meta.energy;
  item.location = meta.location;
  item.dur = meta.durMin;

  return i - start;
}

interface ParsedHeading {
  level: number;
  name: string;
  color: string | null;
}

function parseHeading(line: string): ParsedHeading | null {
  // Up to 6 `#` characters then a space then content.
  const m = line.match(/^(#{1,6})\s+(.+?)\s*$/);
  if (!m) return null;
  let name = m[2];
  let color: string | null = null;
  // Optional trailing color tag: " {#3a8a48}".
  const cm = name.match(/^(.*?)\s*\{#([0-9a-fA-F]{3,8})\}\s*$/);
  if (cm) {
    name = cm[1].trim();
    color = '#' + cm[2].toLowerCase();
  }
  if (!name) return null;
  return { level: m[1].length, name, color };
}

interface TaskHead {
  done: boolean;
  title: string;
  due: string | null;
  recur: { dow: number[] } | null;
  isRecurring: boolean;
  priority: 1 | 2 | 3 | 4;
  labels: string[];
  id: string | null;
}

function parseTaskHead(line: string, expectIndent: number): TaskHead | null {
  // Match optional leading spaces, but require they equal `expectIndent`.
  const indent = countLeadingSpaces(line);
  if (indent !== expectIndent) return null;
  const rest = line.slice(indent);
  const m = rest.match(/^-\s+\[([ xX])\]\s+(.*)$/);
  if (!m) return null;
  const done = m[1] === 'x' || m[1] === 'X';
  let body = m[2];

  // Pull out the trailing block id: "^xxxxxxxx" at end (Obsidian-style).
  let id: string | null = null;
  const idMatch = body.match(/\s+\^([A-Za-z0-9_-]{3,32})\s*$/);
  if (idMatch) {
    id = idMatch[1];
    body = body.slice(0, idMatch.index!).trimEnd();
  }

  // Pull labels (#tag tokens). Whitespace-separated; skip code spans.
  const labels: string[] = [];
  body = body.replace(/(^|\s)#([A-Za-z0-9][\w./-]*)\b/g, (_full, lead, tag) => {
    labels.push(tag);
    return lead;
  });

  // Pull priority: !p1..!p4. !p1 = highest = Todoist priority 4.
  let priority: 1 | 2 | 3 | 4 = 1;
  body = body.replace(/(^|\s)!p([1-4])\b/i, (_full, lead, n) => {
    const v = parseInt(n, 10);
    // Map mental model → Todoist wire: !p1 → 4, !p2 → 3, !p3 → 2, !p4 → 1.
    priority = (5 - v) as 1 | 2 | 3 | 4;
    return lead;
  });

  // Pull due / recurrence: "@YYYY-MM-DD" or "@every <words>" or "@daily" / "@weekdays".
  let due: string | null = null;
  // Explicit annotation: TS narrows mutations inside the regex callback
  // to the initial `null` type otherwise.
  let recurDow: number[] | null = null as number[] | null;
  let isRecurring = false;
  body = body.replace(/(^|\s)@(\S(?:[^\n@]*\S)?)/g, (full, lead, token) => {
    const t = token.trim();
    const isoDate = t.match(/^(\d{4}-\d{2}-\d{2})/);
    if (isoDate && !due) {
      due = isoDate[1];
      return lead;
    }
    const lower = t.toLowerCase();
    if (lower === 'today') { due = today(); return lead; }
    if (lower === 'tomorrow') { due = addDaysIso(today(), 1); return lead; }
    if (lower === 'daily' || lower === 'every-day' || lower === 'every day') {
      isRecurring = true;
      recurDow = [0, 1, 2, 3, 4, 5, 6];
      return lead;
    }
    if (lower === 'weekdays' || lower === 'every weekday' || lower === 'every-weekday') {
      isRecurring = true;
      recurDow = [1, 2, 3, 4, 5];
      return lead;
    }
    if (lower === 'weekend' || lower === 'every weekend' || lower === 'every-weekend') {
      isRecurring = true;
      recurDow = [0, 6];
      return lead;
    }
    if (lower.startsWith('every ') || lower.startsWith('every-')) {
      isRecurring = true;
      const dows = parseDowList(lower);
      if (dows.length > 0) recurDow = dows;
      return lead;
    }
    // Unknown @token — leave as part of the title.
    return full;
  });

  const title = body.replace(/\s+/g, ' ').trim();
  return {
    done, title, due,
    recur: recurDow ? { dow: recurDow.sort() } : null,
    isRecurring,
    priority,
    labels,
    id,
  };
}

function parseDowList(s: string): number[] {
  const map: Record<string, number> = {
    sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2,
    wed: 3, weds: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4,
    fri: 5, friday: 5, sat: 6, saturday: 6,
  };
  const out: number[] = [];
  for (const [k, v] of Object.entries(map)) {
    if (new RegExp(`\\b${k}\\b`).test(s) && !out.includes(v)) out.push(v);
  }
  return out.sort();
}

function countLeadingSpaces(line: string): number {
  let n = 0;
  while (n < line.length && line[n] === ' ') n++;
  return n;
}

function projectIdFor(parentId: string | null, name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^\w\s-]+/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 64);
  const base = parentId ? parentId : 'proj';
  return `${base}/${slug || 'untitled'}`;
}

function appendBlockId(line: string, id: string): string {
  // Insert ` ^id` at end of trimmed-right line.
  const rtrim = line.replace(/\s+$/, '');
  return `${rtrim} ^${id}`;
}

function randomId(n: number): string {
  // 6–10 alphanum chars; collisions are vanishingly unlikely for a
  // single-user task list.
  return randomBytes(n).toString('base64url').slice(0, n);
}

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map((s) => parseInt(s, 10));
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}
