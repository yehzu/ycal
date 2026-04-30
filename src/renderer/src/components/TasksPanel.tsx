// yCal — Tasks panel (right rail of Week + Day views).
//
// Sits next to the calendar grid, hosts the Todoist inbox, and accepts
// drops back from the calendar to unschedule. Routines that don't fire
// today fold under a collapsed "Routines" group at the bottom.

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

  const fireToday = (task: TaskItem) => task.recur && taskOccursOn(task, today);

  const inboxTasks = tasks.filter((t) => !t.recur || fireToday(t));
  const routineTasks = tasks.filter((t) => t.recur && !fireToday(t));

  // Nesting: build a parent → children index across the visible inbox set.
  // A task whose parentId points to something we don't display (parent done,
  // or parent on a hidden project) is treated as a top-level orphan so it
  // still shows up.
  const inboxIds = useMemo(() => {
    const s = new Set<string>();
    for (const t of inboxTasks) s.add(t.id);
    return s;
  }, [inboxTasks]);
  const childrenByParent = useMemo(() => {
    const m: Record<string, TaskItem[]> = {};
    for (const t of inboxTasks) {
      if (t.parentId && inboxIds.has(t.parentId)) {
        (m[t.parentId] ??= []).push(t);
      }
    }
    return m;
  }, [inboxTasks, inboxIds]);

  const grouped = useMemo(() => {
    const out: Record<string, TaskItem[]> = {};
    for (const p of projectOrder) out[p] = [];
    for (const t of inboxTasks) {
      if (t.parentId && inboxIds.has(t.parentId)) continue;
      if (!out[t.project]) out[t.project] = [];
      out[t.project].push(t);
    }
    return out;
  }, [inboxTasks, projectOrder, inboxIds]);

  const totalOpen = inboxTasks.length;
  const totalAll = inboxTasks.length + doneTodayCount;
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
                        {renderInlineCode(task.title)}
                      </span>
                      <span className="tp-routine-dow">{formatRecurDow(task.recur)}</span>
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
        <div className="tp-ttl">{renderInlineCode(task.title)}</div>
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

export function TasksEdgeTab({ onOpen }: { onOpen: () => void }) {
  return (
    <button className="tp-edge-tab" onClick={onOpen} title="Show tasks (T)">
      <span>▸ Tasks</span>
    </button>
  );
}
