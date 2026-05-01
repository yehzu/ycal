// yCal — Tasks panel (right rail of Week + Day views).
//
// Sits next to the calendar grid, hosts the Todoist inbox, and accepts
// drops back from the calendar to unschedule. Layout, top to bottom:
//
//   1. "Today"   — anything firing today: scheduled-today, due-today, or
//                  a recurring task whose cadence lands today.
//   2. Project sections — the regular inbox grouped by Todoist project.
//   3. "Routines" fold (collapsed) — every recurring task that isn't
//      firing today, regardless of cadence shape (weekly dow, "every 3
//      days", date-based — they all live here so they don't pollute the
//      project sections).
//
// Each card carries a small priority flag (P1 red / P2 orange / P3 blue)
// drawn from Todoist's priority field. Default-priority tasks have no
// flag.

import { useMemo, useRef, useState } from 'react';
import type { TaskItem } from '@shared/types';
import { useDragSource, useDragTarget } from '../dragController';
import { DOW_SHORT, fmtDate, formatTime } from '../dates';
import { taskOccursOn } from '../tasks';
import { renderInlineCode } from '../inlineCode';

interface Props {
  open: boolean;
  today: Date;
  tasks: TaskItem[];
  projectOrder: string[];
  projectColor: Record<string, string>;
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

export function TasksPanel(props: Props) {
  const {
    open, today, tasks, projectOrder, projectColor,
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

  const todayTasks = useMemo(
    () => tasks.filter(isTodayTask).sort(byPriorityDesc),
    [tasks, todayStr],
  );
  const todayIdSet = useMemo(() => new Set(todayTasks.map((t) => t.id)), [todayTasks]);

  // Routines fold: every recurring task that isn't already up in Today.
  // Sorted alphabetically so a long list reads predictably.
  const routineTasks = useMemo(() => {
    return tasks
      .filter((t) => t.isRecurring && !todayIdSet.has(t.id))
      .slice()
      .sort((a, b) => a.title.localeCompare(b.title));
  }, [tasks, todayIdSet]);
  const routineIdSet = useMemo(() => new Set(routineTasks.map((t) => t.id)), [routineTasks]);

  // Project-section pool: everything that's neither Today nor a (future)
  // routine. This is what the user thinks of as their "real" inbox.
  const projectPool = useMemo(() => {
    return tasks.filter((t) => !todayIdSet.has(t.id) && !routineIdSet.has(t.id));
  }, [tasks, todayIdSet, routineIdSet]);

  // Nesting: build a parent → children index across each visible bucket.
  // A task whose parentId points to something we don't display (parent done,
  // or parent on a hidden project) is treated as a top-level orphan so it
  // still shows up.
  const childrenByParent = useMemo(() => {
    const visibleIds = new Set<string>();
    for (const t of todayTasks) visibleIds.add(t.id);
    for (const t of projectPool) visibleIds.add(t.id);
    const m: Record<string, TaskItem[]> = {};
    for (const t of [...todayTasks, ...projectPool]) {
      if (t.parentId && visibleIds.has(t.parentId)) {
        (m[t.parentId] ??= []).push(t);
      }
    }
    return m;
  }, [todayTasks, projectPool]);
  const childIds = useMemo(() => {
    const s = new Set<string>();
    for (const arr of Object.values(childrenByParent)) {
      for (const t of arr) s.add(t.id);
    }
    return s;
  }, [childrenByParent]);

  const grouped = useMemo(() => {
    const out: Record<string, TaskItem[]> = {};
    for (const p of projectOrder) out[p] = [];
    for (const t of projectPool) {
      if (childIds.has(t.id)) continue;
      if (!out[t.project]) out[t.project] = [];
      out[t.project].push(t);
    }
    for (const p of Object.keys(out)) out[p].sort(byPriorityDesc);
    return out;
  }, [projectPool, projectOrder, childIds]);

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

        {projectOrder.map((project) => {
          const list = grouped[project] || [];
          if (list.length === 0) return null;
          const projColor = projectColor[project] || '#5b7a8e';
          return (
            <section
              key={project}
              className="tp-section"
              style={{ ['--proj' as never]: projColor }}
            >
              <div className="tp-mast">
                <span className="tp-proj">{project}</span>
                <span className="tp-rule" />
                <span className="tp-pcnt">{list.length}</span>
              </div>
              <div className="tp-stack">
                {list.map((task) => (
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
                ))}
              </div>
            </section>
          );
        })}

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
