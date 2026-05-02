// yCal — Tasks panel (right rail of Week + Day views).
//
// Sits next to the calendar grid, hosts the Todoist inbox, and accepts
// drops back from the calendar to unschedule. Layout, top to bottom:
//
//   0. "Overdue" — anything whose promise date (local schedule slot or
//                  Todoist due) is before today and isn't done. Surfaced
//                  prominently so missed work doesn't silently scatter
//                  into project sections or get hidden in the collapsed
//                  Routines fold for recurring tasks.
//   1. "Today"   — anything firing today: scheduled-today, due-today, or
//                  a recurring task whose cadence lands today.
//   2. Project sections — the regular inbox grouped by Todoist project.
//      Every project (top-level and nested) is foldable; collapse state
//      persists in localStorage. Nested sub-projects render as smaller,
//      indented rows under their parent so the Todoist-style hierarchy
//      (e.g. Work › Engineering › Reviews) is visible at a glance.
//   3. "Routines" fold (collapsed) — every recurring task that isn't
//      firing today, regardless of cadence shape (weekly dow, "every 3
//      days", date-based — they all live here so they don't pollute the
//      project sections).
//
// Each card carries a small priority flag (P1 red / P2 orange / P3 blue)
// drawn from Todoist's priority field. Default-priority tasks have no
// flag.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { TaskItem, TaskProjectNode } from '@shared/types';
import { useDragSource, useDragTarget } from '../dragController';
import { DOW_SHORT, fmtDate, formatTime } from '../dates';
import { taskOccursOn } from '../tasks';
import { renderInlineCode } from '../inlineCode';

interface Props {
  open: boolean;
  today: Date;
  tasks: TaskItem[];
  // Top-level project name list — used as the fallback ordering when the
  // provider hasn't populated `projects` yet (e.g. cached-tasks-on-boot).
  projectOrder: string[];
  projectColor: Record<string, string>;
  // Project tree as a flat list with parentId pointers. When this is
  // populated we render the nested hierarchy. When empty (cache-only
  // boot, or non-Todoist providers) we fall back to a flat-by-name
  // grouping using `projectOrder`.
  projects: TaskProjectNode[];
  doneTodayCount: number;
  carryoverIds: Set<string>;
  onClose: () => void;
  onUnschedule: (taskId: string) => void;
  onToggleDone: (taskId: string) => void;
  onOpenTask: (taskId: string) => void;
  // True when the Todoist key isn't set yet — panel renders a hint instead
  // of an empty state.
  apiKeySet: boolean;
  loading: boolean;
  errorMessage?: string | null;
}

// Internal tree node assembled from the flat `TaskProjectNode[]`. The
// fallback path (when `projects` is empty) synthesises nodes keyed by
// project name, so the renderer always walks a tree.
interface TreeNode {
  id: string;
  name: string;
  color: string;
  parentId: string | null;
  children: TreeNode[];
}

const PROJ_NAME_PREFIX = '__name:';
const NULL_PROJ_KEY = '__inbox__';

function buildProjectTree(nodes: TaskProjectNode[]): TreeNode[] {
  const byId = new Map<string, TreeNode>();
  for (const n of nodes) {
    byId.set(n.id, {
      id: n.id, name: n.name, color: n.color, parentId: n.parentId,
      children: [],
    });
  }
  const sorted = [...nodes].sort((a, b) => a.childOrder - b.childOrder);
  const roots: TreeNode[] = [];
  for (const n of sorted) {
    const tn = byId.get(n.id)!;
    if (n.parentId && byId.has(n.parentId)) {
      byId.get(n.parentId)!.children.push(tn);
    } else {
      roots.push(tn);
    }
  }
  return roots;
}

export function TasksPanel(props: Props) {
  const {
    open, today, tasks, projectOrder, projectColor, projects,
    doneTodayCount, carryoverIds, onClose, onUnschedule, onToggleDone,
    onOpenTask, apiKeySet, loading, errorMessage,
  } = props;

  const todayStr = fmtDate(today);

  // "Fires today" covers three signals: parsed weekday recurrence (Mon/Wed),
  // a Todoist-recurring task whose next due-date is today (catches "every 3
  // days" / date cadences that we can't shape into a dow array), or a flat
  // due === today.
  const firesToday = (task: TaskItem): boolean => {
    if (task.recur && taskOccursOn(task, today)) return true;
    if (task.isRecurring && task.due === todayStr) return true;
    return false;
  };

  const isTodayTask = (task: TaskItem): boolean => {
    if (task.scheduledAt && task.scheduledAt.date === todayStr) return true;
    if (task.due === todayStr) return true;
    return firesToday(task);
  };

  // Overdue takes priority over every other bucket. Sort by oldest
  // promise date first, then by Todoist priority — gives the user a
  // top-down view of what's been waiting longest.
  const overdueTasks = useMemo(() => {
    const promiseOf = (t: TaskItem): string =>
      t.scheduledAt?.date ?? t.due ?? '';
    return tasks
      .filter((t) => carryoverIds.has(t.id))
      .slice()
      .sort((a, b) => {
        const pa = promiseOf(a);
        const pb = promiseOf(b);
        if (pa !== pb) return pa.localeCompare(pb);
        return b.priority - a.priority;
      });
  }, [tasks, carryoverIds]);
  const overdueIdSet = useMemo(
    () => new Set(overdueTasks.map((t) => t.id)),
    [overdueTasks],
  );

  const todayTasks = useMemo(
    () => tasks
      .filter((t) => !overdueIdSet.has(t.id) && isTodayTask(t))
      .sort(byPriorityDesc),
    [tasks, todayStr, overdueIdSet],
  );
  const todayIdSet = useMemo(() => new Set(todayTasks.map((t) => t.id)), [todayTasks]);

  // Routines fold: every recurring task that isn't already up in Today
  // or Overdue. Sorted alphabetically so a long list reads predictably.
  const routineTasks = useMemo(() => {
    return tasks
      .filter((t) =>
        t.isRecurring && !todayIdSet.has(t.id) && !overdueIdSet.has(t.id))
      .slice()
      .sort((a, b) => a.title.localeCompare(b.title));
  }, [tasks, todayIdSet, overdueIdSet]);
  const routineIdSet = useMemo(() => new Set(routineTasks.map((t) => t.id)), [routineTasks]);

  // Project-section pool: everything that's neither Overdue, Today, nor
  // a (future) routine. This is what the user thinks of as their "real"
  // inbox.
  const projectPool = useMemo(() => {
    return tasks.filter((t) =>
      !overdueIdSet.has(t.id)
      && !todayIdSet.has(t.id)
      && !routineIdSet.has(t.id),
    );
  }, [tasks, overdueIdSet, todayIdSet, routineIdSet]);

  // Nesting: build a parent → children index across each visible bucket.
  // A task whose parentId points to something we don't display (parent done,
  // or parent on a hidden project) is treated as a top-level orphan so it
  // still shows up.
  const childrenByParent = useMemo(() => {
    const visibleIds = new Set<string>();
    for (const t of overdueTasks) visibleIds.add(t.id);
    for (const t of todayTasks) visibleIds.add(t.id);
    for (const t of projectPool) visibleIds.add(t.id);
    const m: Record<string, TaskItem[]> = {};
    for (const t of [...overdueTasks, ...todayTasks, ...projectPool]) {
      if (t.parentId && visibleIds.has(t.parentId)) {
        (m[t.parentId] ??= []).push(t);
      }
    }
    return m;
  }, [overdueTasks, todayTasks, projectPool]);
  const childIds = useMemo(() => {
    const s = new Set<string>();
    for (const arr of Object.values(childrenByParent)) {
      for (const t of arr) s.add(t.id);
    }
    return s;
  }, [childrenByParent]);

  // Build the project tree we render. When the provider gave us a real
  // hierarchy (Todoist nested projects), use it. Otherwise fall back to a
  // flat list of name-keyed roots so cached-tasks-on-boot still groups.
  const projectTree = useMemo<TreeNode[]>(() => {
    if (projects.length > 0) return buildProjectTree(projects);
    return projectOrder.map((name) => ({
      id: PROJ_NAME_PREFIX + name,
      name,
      color: projectColor[name] ?? '#5b7a8e',
      parentId: null,
      children: [],
    }));
  }, [projects, projectOrder, projectColor]);

  // Pick a stable bucket key for each task. With the tree we group by
  // projectId so two leaves named the same don't collide. Without it we
  // group by display name (the legacy flat path).
  const tasksByNodeId = useMemo(() => {
    const useIds = projects.length > 0;
    const out: Record<string, TaskItem[]> = {};
    for (const t of projectPool) {
      if (childIds.has(t.id)) continue;
      const key = useIds
        ? (t.projectId || NULL_PROJ_KEY)
        : (PROJ_NAME_PREFIX + t.project);
      (out[key] ??= []).push(t);
    }
    for (const k of Object.keys(out)) out[k].sort(byPriorityDesc);
    return out;
  }, [projectPool, childIds, projects.length]);

  // Subtree count per node — own tasks + every descendant's. A 0 here
  // means we skip rendering that subtree entirely so empty Todoist
  // projects don't clutter the panel.
  const subtreeCount = useMemo(() => {
    const out: Record<string, number> = {};
    const walk = (node: TreeNode): number => {
      let n = (tasksByNodeId[node.id] ?? []).length;
      for (const c of node.children) n += walk(c);
      out[node.id] = n;
      return n;
    };
    for (const r of projectTree) walk(r);
    return out;
  }, [projectTree, tasksByNodeId]);

  // Persisted collapse state, keyed by project id (or synth name id for
  // the fallback path). Default = expanded for everyone — the user opts
  // into folding rather than the panel hiding things by default.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    try {
      const raw = localStorage.getItem('ycal:tp-collapsed');
      if (raw) return JSON.parse(raw) as Record<string, boolean>;
    } catch { /* fall through to default */ }
    return {};
  });
  useEffect(() => {
    try {
      localStorage.setItem('ycal:tp-collapsed', JSON.stringify(collapsed));
    } catch { /* localStorage may be unavailable in some contexts */ }
  }, [collapsed]);
  const toggleCollapsed = (id: string) =>
    setCollapsed((c) => ({ ...c, [id]: !c[id] }));

  const totalOpen = tasks.filter((t) => !routineIdSet.has(t.id)).length;
  const totalAll = totalOpen + doneTodayCount;
  const [routinesOpen, setRoutinesOpen] = useState(false);

  const [dropActive, setDropActive] = useState(false);
  const panelRef = useRef<HTMLElement | null>(null);
  useDragTarget(panelRef as React.RefObject<HTMLElement>, {
    accept: 'task',
    onEnter: ({ payload }) => {
      const p = payload as { source?: string };
      if (p.source === 'scheduled') setDropActive(true);
    },
    onLeave: () => setDropActive(false),
    onDrop: ({ payload }) => {
      setDropActive(false);
      const p = payload as { taskId: string; source?: string };
      if (p.source === 'scheduled') onUnschedule(p.taskId);
    },
  });

  if (!open) return null;

  // Recursively render a project node. depth=0 keeps the masthead (the
  // existing visual rhythm of the panel); deeper nodes render as smaller
  // indented rows with their own caret + count + guide rail.
  const renderNode = (node: TreeNode, depth: number, inheritedColor: string): React.ReactNode => {
    const total = subtreeCount[node.id] ?? 0;
    if (total === 0) return null;
    const color = node.color || inheritedColor;
    const isCollapsed = !!collapsed[node.id];
    const ownTasks = tasksByNodeId[node.id] ?? [];

    if (depth === 0) {
      return (
        <section
          key={node.id}
          className={'tp-section' + (isCollapsed ? ' is-collapsed' : '')}
          style={{ ['--proj' as never]: color }}
        >
          <button
            className="tp-mast tp-mast-btn"
            onClick={() => toggleCollapsed(node.id)}
            aria-expanded={!isCollapsed}
            title={isCollapsed ? 'Expand ' + node.name : 'Collapse ' + node.name}
          >
            <span
              className={'tp-fold-caret ' + (isCollapsed ? 'closed' : 'open')}
              aria-hidden="true"
            >▾</span>
            <span className="tp-proj">{node.name}</span>
            <span className="tp-rule" />
            <span className="tp-pcnt">{total}</span>
          </button>
          {!isCollapsed && (
            <div className="tp-section-body">
              {ownTasks.length > 0 && (
                <div className="tp-stack">
                  {ownTasks.map((task) => (
                    <TaskTree
                      key={task.id}
                      task={task}
                      today={today}
                      projColor={color}
                      carryoverIds={carryoverIds}
                      childrenByParent={childrenByParent}
                      onToggleDone={onToggleDone}
                      onOpenTask={onOpenTask}
                      depth={0}
                    />
                  ))}
                </div>
              )}
              {node.children.map((c) => renderNode(c, depth + 1, color))}
            </div>
          )}
        </section>
      );
    }

    return (
      <div
        key={node.id}
        className={`tp-sub depth-${depth}` + (isCollapsed ? ' is-collapsed' : '')}
        style={{ ['--proj' as never]: color, ['--ind' as never]: depth + 'em' }}
      >
        <button
          className="tp-sub-head"
          onClick={() => toggleCollapsed(node.id)}
          aria-expanded={!isCollapsed}
          title={isCollapsed ? 'Expand ' + node.name : 'Collapse ' + node.name}
        >
          <span className="tp-sub-rail" aria-hidden="true" />
          <span
            className={'tp-fold-caret tp-fold-caret-sm ' + (isCollapsed ? 'closed' : 'open')}
            aria-hidden="true"
          >▾</span>
          <span className="tp-sub-chev" aria-hidden="true">›</span>
          <span className="tp-sub-name">{node.name}</span>
          <span className="tp-sub-rule" />
          <span className="tp-sub-cnt">{total}</span>
        </button>
        {!isCollapsed && (
          <div className="tp-sub-body">
            {ownTasks.length > 0 && (
              <div className="tp-stack tp-sub-stack">
                {ownTasks.map((task) => (
                  <TaskTree
                    key={task.id}
                    task={task}
                    today={today}
                    projColor={color}
                    carryoverIds={carryoverIds}
                    childrenByParent={childrenByParent}
                    onToggleDone={onToggleDone}
                    onOpenTask={onOpenTask}
                    depth={0}
                  />
                ))}
              </div>
            )}
            {node.children.map((c) => renderNode(c, depth + 1, color))}
          </div>
        )}
      </div>
    );
  };

  return (
    <aside
      ref={panelRef as React.RefObject<HTMLElement>}
      className={'tasks-panel' + (dropActive ? ' drop-active' : '')}
      data-screen-label="Tasks Panel"
    >
      <header className="tp-head">
        <div>
          <div className="tp-eyebrow">Inbox</div>
          <h2 className="tp-title">This week</h2>
        </div>
        <div className="tp-meta">
          <span className="tp-cnt">
            {totalOpen - doneTodayCount} / {totalAll}
          </span>
          <button className="tp-close" onClick={onClose} title="Hide tasks (T)">×</button>
        </div>
      </header>

      <div className="tp-body">
        {!apiKeySet && (
          <div className="tp-empty-state">
            Connect Todoist in <em>Settings → Tasks</em> to load your inbox.
          </div>
        )}
        {apiKeySet && totalOpen === 0 && !loading && !errorMessage && (
          <div className="tp-empty-state">No open tasks. Inbox zero.</div>
        )}
        {apiKeySet && errorMessage && (
          <div className="tp-empty-state tp-error">{errorMessage}</div>
        )}

        {overdueTasks.length > 0 && (
          <section className="tp-section tp-overdue">
            <div className="tp-mast">
              <span className="tp-eyebrow-tag tp-eyebrow-overdue">Overdue</span>
              <span className="tp-rule" />
              <span className="tp-pcnt">{overdueTasks.length}</span>
            </div>
            <div className="tp-stack">
              {overdueTasks.map((task) => {
                if (childIds.has(task.id)) return null;
                const projColor = projectColor[task.project] || '#5b7a8e';
                return (
                  <TaskTree
                    key={task.id}
                    task={task}
                    today={today}
                    projColor={projColor}
                    carryoverIds={carryoverIds}
                    childrenByParent={childrenByParent}
                    onToggleDone={onToggleDone}
                    onOpenTask={onOpenTask}
                    depth={0}
                  />
                );
              })}
            </div>
          </section>
        )}

        {todayTasks.length > 0 && (
          <section className="tp-section tp-today">
            <div className="tp-mast">
              <span className="tp-eyebrow-tag">Today</span>
              <span className="tp-rule" />
              <span className="tp-pcnt">{todayTasks.length}</span>
            </div>
            <div className="tp-stack">
              {todayTasks.map((task) => {
                if (childIds.has(task.id)) return null;
                const projColor = projectColor[task.project] || '#5b7a8e';
                return (
                  <TaskTree
                    key={task.id}
                    task={task}
                    today={today}
                    projColor={projColor}
                    carryoverIds={carryoverIds}
                    childrenByParent={childrenByParent}
                    onToggleDone={onToggleDone}
                    onOpenTask={onOpenTask}
                    depth={0}
                  />
                );
              })}
            </div>
          </section>
        )}

        {projectTree.map((root) => renderNode(root, 0, root.color || '#5b7a8e'))}

        {routineTasks.length > 0 && (
          <section className={'tp-routines' + (routinesOpen ? ' open' : '')}>
            <button
              className="tp-routines-head"
              onClick={() => setRoutinesOpen((o) => !o)}
              title={routinesOpen ? 'Collapse routines' : 'Expand routines'}
            >
              <span className="tp-routines-caret">{routinesOpen ? '▾' : '▸'}</span>
              <span className="tp-routines-label">Routines</span>
              <span className="tp-rule" />
              <span className="tp-routines-cnt">{routineTasks.length}</span>
            </button>
            {routinesOpen && (
              <div className="tp-stack tp-routines-stack">
                {routineTasks.map((task) => {
                  const projColor = projectColor[task.project] || '#5b7a8e';
                  const cadence = formatRoutineCadence(task, today);
                  return (
                    <button
                      key={task.id}
                      type="button"
                      className="tp-routine-row"
                      style={{ ['--proj' as never]: projColor }}
                      onClick={() => onOpenTask(task.id)}
                      title="Open task"
                    >
                      <span className="tp-routine-glyph" />
                      <span className="tp-routine-title">
                        {task.priority > 1 && (
                          <span className={'tp-pri-flag pri-' + task.priority} />
                        )}
                        {renderInlineCode(task.title)}
                      </span>
                      <span className="tp-routine-dow">{cadence}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </section>
        )}
      </div>

      {doneTodayCount > 0 && (
        <div className="tp-doneFoot">Done today · {doneTodayCount}</div>
      )}
    </aside>
  );
}

interface TreeProps {
  task: TaskItem;
  today: Date;
  projColor: string;
  carryoverIds: Set<string>;
  childrenByParent: Record<string, TaskItem[]>;
  onToggleDone: (taskId: string) => void;
  onOpenTask: (taskId: string) => void;
  depth: number;
}

function TaskTree(props: TreeProps) {
  const {
    task, today, projColor, carryoverIds, childrenByParent,
    onToggleDone, onOpenTask, depth,
  } = props;
  const kids = childrenByParent[task.id] ?? [];
  return (
    <div className={'tp-tree' + (depth > 0 ? ' nested' : '')}>
      <TaskCard
        task={task}
        today={today}
        projColor={projColor}
        carry={carryoverIds.has(task.id)}
        nested={depth > 0}
        onToggleDone={() => onToggleDone(task.id)}
        onOpen={() => onOpenTask(task.id)}
      />
      {kids.length > 0 && (
        <div className="tp-children">
          {kids.map((c) => (
            <TaskTree
              key={c.id}
              task={c}
              today={today}
              projColor={projColor}
              carryoverIds={carryoverIds}
              childrenByParent={childrenByParent}
              onToggleDone={onToggleDone}
              onOpenTask={onOpenTask}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface CardProps {
  task: TaskItem;
  today: Date;
  projColor: string;
  carry: boolean;
  nested?: boolean;
  onToggleDone: () => void;
  onOpen: () => void;
}

function TaskCard({ task, today, projColor, carry, nested, onToggleDone, onOpen }: CardProps) {
  const dur = formatDur(task.dur);
  const dueLabel = formatDueLabel(task.due, today);
  const isScheduled = !!task.scheduledAt;
  const cls = ['tp-card'];
  if (carry) cls.push('carry');
  if (isScheduled) cls.push('scheduled');
  if (nested) cls.push('nested');
  cls.push('pri-' + task.priority);

  const drag = useDragSource({
    type: 'task',
    payload: {
      taskId: task.id,
      source: isScheduled ? 'scheduled' : 'inbox',
    },
    makePreview: () => (
      <div className="drag-preview-task" style={{ ['--proj' as never]: projColor }}>
        <span className="drag-preview-glyph" />
        <span className="drag-preview-ttl">{task.title}</span>
        {dur && <span className="drag-preview-dur">{dur}</span>}
      </div>
    ),
  });

  const onClickCard = (e: React.MouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('.tp-tbox')) return;
    onOpen();
  };

  return (
    <div
      className={cls.join(' ')}
      draggable={drag.draggable}
      onDragStart={drag.onDragStart}
      onPointerDown={drag.onPointerDown}
      onClick={onClickCard}
      title={isScheduled
        ? 'Scheduled — click to open · drag back here to unschedule'
        : 'Click to open · drag onto the calendar to schedule'}
    >
      <div className="tp-left">
        <button
          className="tp-tbox"
          onClick={(e) => { e.stopPropagation(); onToggleDone(); }}
          aria-label="Mark done"
          title="Mark done"
        />
      </div>
      <div className="tp-center">
        <div className="tp-ttl">
          {task.priority > 1 && (
            <span
              className={'tp-pri-flag pri-' + task.priority}
              title={'Priority P' + (5 - task.priority)}
            />
          )}
          {renderInlineCode(task.title)}
        </div>
        {(task.energy || task.location || dueLabel || isScheduled
          || task.description || task.comments.length > 0) && (
          <div className="tp-meta">
            {isScheduled && task.scheduledAt && (
              <span className="tp-label sched">
                <span className="tp-glyph tp-glyph-sched" />
                {formatScheduled(task.scheduledAt)}
              </span>
            )}
            {!isScheduled && task.energy && (
              <span className={'tp-label energy-' + task.energy}>
                <span className="tp-glyph" />{task.energy}
              </span>
            )}
            {!isScheduled && task.location && (
              <span className="tp-label loc">{task.location}</span>
            )}
            {!isScheduled && dueLabel && (
              <span className="tp-label due-near">{dueLabel}</span>
            )}
            {(task.description || task.comments.length > 0) && (
              <span
                className="tp-label tp-has-thread"
                title={`${task.comments.length} comment(s)`}
              >
                <span className="tp-thread-glyph" />
                {task.comments.length > 0 ? task.comments.length : 'note'}
              </span>
            )}
          </div>
        )}
      </div>
      <div className="tp-right">{dur && <span className="tp-dur">{dur}</span>}</div>
    </div>
  );
}

export function formatDur(min: number): string {
  if (!min) return '';
  if (min < 60) return min + 'm';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? h + 'h' : h + 'h ' + m + 'm';
}

function formatDueLabel(due: string | null, today: Date): string {
  if (!due) return '';
  const todayStr = fmtDate(today);
  if (due < todayStr) return 'overdue';
  if (due === todayStr) return 'due today';
  const d = new Date(due + 'T00:00:00');
  const diff = Math.round((d.getTime() - new Date(todayStr + 'T00:00:00').getTime()) / 86_400_000);
  if (diff > 0 && diff <= 6) return 'due ' + DOW_SHORT[d.getDay()];
  return '';
}

function formatScheduled(slot: { date: string; start: string }): string {
  const d = new Date(slot.date + 'T00:00:00');
  const dow = DOW_SHORT[d.getDay()];
  if (!slot.start) return dow;
  const [h, m] = slot.start.split(':').map((n) => parseInt(n, 10));
  const fake = new Date(2000, 0, 1, h || 0, m || 0);
  return dow + ' ' + formatTime(fake);
}

function formatRecurDow(recur: TaskItem['recur']): string {
  if (!recur || !recur.dow) return '';
  const dow = recur.dow;
  if (dow.length === 7) return 'every day';
  if (dow.length === 5 && dow.every((d) => d >= 1 && d <= 5)) return 'weekdays';
  if (dow.length === 2 && dow.includes(0) && dow.includes(6)) return 'weekends';
  return dow.map((d) => DOW_SHORT[d]).join(' · ');
}

// What to print on the right edge of a Routines row. Prefers a parsed
// weekday cadence ("Mon · Wed"); falls back to the next due date so
// "every 3 days" tasks still show *when* they next fire.
function formatRoutineCadence(task: TaskItem, today: Date): string {
  const dow = formatRecurDow(task.recur);
  if (dow) return dow;
  if (!task.due) return 'recurring';
  const todayStr = fmtDate(today);
  if (task.due === todayStr) return 'today';
  const d = new Date(task.due + 'T00:00:00');
  const diff = Math.round(
    (d.getTime() - new Date(todayStr + 'T00:00:00').getTime()) / 86_400_000,
  );
  if (diff < 0) return 'overdue';
  if (diff <= 6) return 'next ' + DOW_SHORT[d.getDay()];
  return 'in ' + diff + 'd';
}

// Sort comparator for task lists. Higher Todoist priority surfaces first.
// Within a priority bucket we keep Todoist's original order — that's
// already meaningful (manual ranking inside a project).
function byPriorityDesc(a: TaskItem, b: TaskItem): number {
  return b.priority - a.priority;
}

export function TasksEdgeTab({ onOpen }: { onOpen: () => void }) {
  return (
    <button className="tp-edge-tab" onClick={onOpen} title="Show tasks (T)">
      <span>▸ Tasks</span>
    </button>
  );
}
