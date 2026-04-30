// yCal — Task detail sheet (slides in from the right edge).
//
// Mounted at the App level so it can overlay the entire window, not just
// the tasks panel. Shows description + Todoist comments thread, with a
// composer at the bottom that posts back to Todoist.

import { useEffect, useRef, useState } from 'react';
import type { TaskItem } from '@shared/types';
import { DOW_SHORT, MONTH_SHORT, fmtDate, formatTime } from '../dates';

interface Props {
  task: TaskItem | null;
  today: Date;
  projColor: string;
  isDone: boolean;
  onClose: () => void;
  onAddComment: (taskId: string, text: string) => Promise<unknown>;
  onToggleDone: (taskId: string) => void;
}

export function TaskSheet({
  task, today, projColor, isDone, onClose, onAddComment, onToggleDone,
}: Props) {
  const [draft, setDraft] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const sheetRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!task) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [task, onClose]);

  useEffect(() => {
    setDraft('');
    if (sheetRef.current) sheetRef.current.scrollTop = 0;
  }, [task?.id]);

  if (!task) return null;

  const dur = task.dur
    ? (task.dur < 60
      ? task.dur + 'm'
      : Math.floor(task.dur / 60) + 'h' + (task.dur % 60 ? ' ' + (task.dur % 60) + 'm' : ''))
    : '';
  const comments = task.comments;
  const desc = task.description;

  const submit = async (e?: React.FormEvent | React.KeyboardEvent) => {
    if (e) e.preventDefault();
    const text = draft.trim();
    if (!text || submitting) return;
    setSubmitting(true);
    try {
      await onAddComment(task.id, text);
      setDraft('');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <div className="ts-scrim" onClick={onClose} />
      <aside
        className="ts-sheet"
        ref={sheetRef as React.RefObject<HTMLElement>}
        style={{ ['--proj' as never]: projColor }}
        data-screen-label="Task Sheet"
      >
        <header className="ts-head">
          <div className="ts-eyebrow">
            <span className="ts-proj-dot" />
            <span className="ts-proj-label">{task.project}</span>
            {task.recur && <span className="ts-routine-tag">routine</span>}
          </div>
          <button className="ts-close" onClick={onClose} title="Close (Esc)">×</button>
        </header>

        <div className="ts-titlerow">
          <button
            className={'ts-tbox' + (isDone ? ' done' : '')}
            onClick={() => onToggleDone(task.id)}
            aria-label="Toggle done"
            title="Mark done"
          />
          <h2 className={'ts-title' + (isDone ? ' done' : '')}>{task.title}</h2>
        </div>

        <div className="ts-meta">
          {dur && <span className="ts-meta-pill">{dur}</span>}
          {task.energy && (
            <span className={'ts-meta-pill ts-energy-' + task.energy}>{task.energy} energy</span>
          )}
          {task.location && <span className="ts-meta-pill">@ {task.location}</span>}
          {task.due && <DueLabel due={task.due} today={today} />}
          {task.scheduledAt && (
            <span className="ts-meta-pill ts-sched">
              {formatScheduledLabel(task.scheduledAt)}
            </span>
          )}
        </div>

        <section className="ts-section">
          <div className="ts-section-label">Description</div>
          {desc ? (
            <div className="ts-desc">
              {desc.split('\n').map((line, i) => (
                <p key={i}>{line || ' '}</p>
              ))}
            </div>
          ) : (
            <button
              className="ts-desc-empty"
              onClick={() => composerRef.current?.focus()}
            >
              Add a description in Todoist…
            </button>
          )}
        </section>

        <section className="ts-section">
          <div className="ts-section-label">
            Comments <span className="ts-count">{comments.length}</span>
          </div>
          {comments.length === 0 ? (
            <div className="ts-empty">No comments yet.</div>
          ) : (
            <ol className="ts-thread">
              {comments.map((c) => (
                <li key={c.id} className="ts-comment">
                  <div
                    className="ts-cmt-avatar"
                    style={{ background: c.authorColor || '#5b7a8e' }}
                  >
                    {c.author && c.author[0]}
                  </div>
                  <div className="ts-cmt-body">
                    <div className="ts-cmt-meta">
                      <span className="ts-cmt-author">{c.author}</span>
                      <span className="ts-cmt-when">{formatCommentWhen(c.at, today)}</span>
                    </div>
                    <div className="ts-cmt-text">{c.text}</div>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </section>

        <form className="ts-composer" onSubmit={submit}>
          <div className="ts-cmt-avatar ts-cmt-avatar-me">Y</div>
          <textarea
            ref={composerRef}
            className="ts-composer-input"
            placeholder="Comment on this task…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit(e);
            }}
            rows={2}
          />
          <button
            type="submit"
            className="ts-composer-submit"
            disabled={!draft.trim() || submitting}
            title="Post (⌘↵)"
          >
            {submitting ? '…' : 'Post'}
          </button>
        </form>
      </aside>
    </>
  );
}

function DueLabel({ due, today }: { due: string; today: Date }) {
  const todayStr = fmtDate(today);
  let label = 'Due ' + due;
  let cls = 'ts-meta-pill ts-due';
  if (due < todayStr) { label = 'Overdue'; cls += ' overdue'; }
  else if (due === todayStr) { label = 'Due today'; cls += ' today'; }
  else {
    const d = new Date(due + 'T00:00:00');
    const diff = Math.round((d.getTime() - new Date(todayStr + 'T00:00:00').getTime()) / 86_400_000);
    if (diff <= 6) {
      const dow = DOW_SHORT[d.getDay()];
      label = 'Due ' + dow;
    }
  }
  return <span className={cls}>{label}</span>;
}

function formatScheduledLabel(slot: { date: string; start: string }): string {
  const d = new Date(slot.date + 'T00:00:00');
  const dow = DOW_SHORT[d.getDay()];
  const mon = MONTH_SHORT[d.getMonth()];
  if (!slot.start) return 'Scheduled · ' + dow + ' ' + mon + ' ' + d.getDate();
  const [h, m] = slot.start.split(':').map((n) => parseInt(n, 10));
  const fake = new Date(2000, 0, 1, h || 0, m || 0);
  return 'Scheduled · ' + dow + ' ' + mon + ' ' + d.getDate() + ' · ' + formatTime(fake);
}

function formatCommentWhen(iso: string, today: Date): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const todayStr = fmtDate(today);
  const dStr = fmtDate(d);
  const fake = new Date(2000, 0, 1, d.getHours(), d.getMinutes());
  const time = formatTime(fake);
  if (dStr === todayStr) return 'Today · ' + time;
  const yest = new Date(today);
  yest.setDate(yest.getDate() - 1);
  if (fmtDate(yest) === dStr) return 'Yesterday · ' + time;
  const dow = DOW_SHORT[d.getDay()];
  const mon = MONTH_SHORT[d.getMonth()];
  return dow + ' ' + mon + ' ' + d.getDate() + ' · ' + time;
}
