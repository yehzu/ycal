// yCal — Search palette (events + todos).
//
// Spotlight-style command palette. Triggered by ⌘K / Ctrl+K, or by the
// search input in the toolbar. Searches the currently-visible calendar
// events and the full Todoist task list.
//
// Editorial vocabulary: serif type, paper background, hairline rules.
// Keyboard: ↑/↓ to move, Enter to open, Esc to dismiss, Tab toggles scope.

import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  CalendarEvent, CalendarSummary, TaskItem,
} from '@shared/types';
import {
  DOW_LONG, MONTH_SHORT, fmtDate, formatTime,
} from '../dates';

interface Props {
  open: boolean;
  onClose: () => void;
  // Already-filtered visible events from the App (active accounts × visible
  // calendars × role rules already applied). Search runs over this set so
  // results respect the user's current visibility intent.
  events: CalendarEvent[];
  calendars: CalendarSummary[];
  // Hydrated task list (with scheduledAt + done already merged).
  tasks: TaskItem[];
  today: Date;
  // Pick handlers — caller decides what to do (jump to date + open
  // popover; open task sheet; etc.). Palette closes itself before calling.
  onPickEvent: (event: CalendarEvent) => void;
  onPickTask: (taskId: string) => void;
}

// ── Scoring helpers ─────────────────────────────────────────────────────

interface Segment { text: string; hit: boolean }

function highlightSegments(text: string, query: string): Segment[] {
  if (!text) return [{ text: '', hit: false }];
  if (!query) return [{ text, hit: false }];
  const lowQ = query.toLowerCase();
  const lowT = text.toLowerCase();
  const out: Segment[] = [];
  let i = 0;
  while (i < text.length) {
    const idx = lowT.indexOf(lowQ, i);
    if (idx === -1) {
      out.push({ text: text.slice(i), hit: false });
      break;
    }
    if (idx > i) out.push({ text: text.slice(i, idx), hit: false });
    out.push({ text: text.slice(idx, idx + lowQ.length), hit: true });
    i = idx + lowQ.length;
  }
  return out;
}

function Hl({ text, q }: { text: string | null | undefined; q: string }): React.ReactNode {
  const segs = highlightSegments(text || '', q || '');
  return (
    <>
      {segs.map((s, i) => (
        s.hit ? <mark key={i} className="sp-hit">{s.text}</mark>
              : <span key={i}>{s.text}</span>
      ))}
    </>
  );
}

// Strip HTML so description-content matches against the visible text, not
// the markup. Calendar event descriptions are rich HTML from Google.
function stripHtml(html: string | null | undefined): string {
  if (!html) return '';
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function scoreEvent(event: CalendarEvent, q: string): number {
  if (!q) return 0;
  const lq = q.toLowerCase();
  let score = 0;
  const t = (event.title || '').toLowerCase();
  if (t.includes(lq)) score += t.startsWith(lq) ? 100 : 60;
  const loc = (event.location || '').toLowerCase();
  if (loc.includes(lq)) score += 30;
  const notes = stripHtml(event.description).toLowerCase();
  if (notes.includes(lq)) score += 12;
  if (event.attendees) {
    for (const a of event.attendees) {
      const n = (a.name || '').toLowerCase();
      const e = (a.email || '').toLowerCase();
      if (n.includes(lq) || e.includes(lq)) { score += 18; break; }
    }
  }
  return score;
}

function scoreTask(task: TaskItem, q: string): number {
  if (!q) return 0;
  const lq = q.toLowerCase();
  let score = 0;
  const t = (task.title || '').toLowerCase();
  if (t.includes(lq)) score += t.startsWith(lq) ? 100 : 60;
  const proj = (task.project || '').toLowerCase();
  if (proj.includes(lq)) score += 25;
  const desc = (task.description || '').toLowerCase();
  if (desc.includes(lq)) score += 12;
  const loc = (task.location || '').toLowerCase();
  if (loc.includes(lq)) score += 15;
  if (task.comments) {
    for (const c of task.comments) {
      if ((c.text || '').toLowerCase().includes(lq)) { score += 10; break; }
    }
  }
  return score;
}

function findSnippet(text: string, q: string, radius = 40): string {
  if (!text || !q) return '';
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx === -1) return '';
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + q.length + radius);
  let s = text.slice(start, end).replace(/\s+/g, ' ').trim();
  if (start > 0) s = '… ' + s;
  if (end < text.length) s = s + ' …';
  return s;
}

interface SubLine { kind: string; text: string }

function eventSubLine(event: CalendarEvent, q: string): SubLine | null {
  if (event.location) return { kind: 'where', text: event.location };
  const notes = stripHtml(event.description);
  if (notes) {
    const snip = findSnippet(notes, q);
    if (snip) return { kind: 'note', text: snip };
  }
  if (event.attendees && event.attendees.length > 0) {
    const lq = (q || '').toLowerCase();
    const hit = event.attendees.find((a) =>
      (a.name || '').toLowerCase().includes(lq)
      || (a.email || '').toLowerCase().includes(lq));
    if (hit) return { kind: 'who', text: hit.name || hit.email };
    return { kind: 'who', text: `${event.attendees.length} attendees` };
  }
  if (event.meetUrl) return { kind: 'video', text: event.meetLabel || 'Google Meet' };
  return null;
}

function taskSubLine(task: TaskItem, q: string): SubLine | null {
  const snip = task.description ? findSnippet(task.description, q) : '';
  if (snip) return { kind: 'desc', text: snip };
  if (task.comments && task.comments.length > 0 && q) {
    const hit = task.comments.find((c) =>
      (c.text || '').toLowerCase().includes(q.toLowerCase()));
    if (hit) return { kind: 'comment', text: `${hit.author}: ${hit.text}` };
  }
  if (task.location) return { kind: 'where', text: task.location };
  return null;
}

// Date label — "Today", "Tomorrow", weekday for ±6 days, otherwise Mon DD.
function fmtRelativeDate(dateStr: string, today: Date): string {
  const d = new Date(dateStr + 'T00:00:00');
  const todayMid = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const diff = Math.round((d.getTime() - todayMid.getTime()) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  if (diff > 1 && diff < 7) return DOW_LONG[d.getDay()];
  if (diff < -1 && diff > -7) return 'Last ' + DOW_LONG[d.getDay()];
  const yr = d.getFullYear() !== today.getFullYear() ? ', ' + d.getFullYear() : '';
  return MONTH_SHORT[d.getMonth()] + ' ' + d.getDate() + yr;
}

function fmtTaskDue(task: TaskItem, today: Date): string | null {
  if (!task.due) return null;
  const d = new Date(task.due + 'T00:00:00');
  const todayMid = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const diff = Math.round((d.getTime() - todayMid.getTime()) / 86_400_000);
  if (diff === 0) return 'Due today';
  if (diff === 1) return 'Due tomorrow';
  if (diff < 0) return 'Overdue · ' + MONTH_SHORT[d.getMonth()] + ' ' + d.getDate();
  if (diff < 7) return 'Due ' + DOW_LONG[d.getDay()];
  return 'Due ' + MONTH_SHORT[d.getMonth()] + ' ' + d.getDate();
}

// Collapse a calendar event's `start` (ISO datetime) into a YYYY-MM-DD
// local-time anchor, plus an HH:mm if the event is timed.
function eventDateParts(event: CalendarEvent): { date: string; timeLabel: string | null } {
  if (event.allDay) {
    // All-day events come back as a date-only string (YYYY-MM-DD) on `start`.
    const d = event.start.slice(0, 10);
    return { date: d, timeLabel: null };
  }
  const d = new Date(event.start);
  return {
    date: fmtDate(d),
    timeLabel: formatTime(d),
  };
}

// ── Main palette ────────────────────────────────────────────────────────

type Scope = 'all' | 'events' | 'todos';

interface Item {
  kind: 'header' | 'event' | 'task';
  // header
  label?: string;
  count?: number;
  // event
  event?: CalendarEvent;
  // task
  task?: TaskItem;
}

export function SearchPalette({
  open, onClose, events, calendars, tasks, today,
  onPickEvent, onPickTask,
}: Props): React.ReactElement | null {
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<Scope>('all');
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // Reset on open / close.
  useEffect(() => {
    if (open) {
      setActiveIdx(0);
      const t = setTimeout(() => inputRef.current?.focus(), 30);
      return () => clearTimeout(t);
    }
    setQuery('');
    setScope('all');
    return undefined;
  }, [open]);

  const calById = useMemo(() => {
    const m: Record<string, CalendarSummary> = {};
    for (const c of calendars) m[c.id] = c;
    return m;
  }, [calendars]);

  // Build the flat result list (section headers + items).
  const { items, eventCount, taskCount } = useMemo(() => {
    if (!open) return { items: [] as Item[], eventCount: 0, taskCount: 0 };
    const q = query.trim();
    const todayStr = fmtDate(today);

    let evResults: { kind: 'event'; event: CalendarEvent; score: number }[];
    let tkResults: { kind: 'task'; task: TaskItem; score: number }[];

    if (!q) {
      // Empty query → show upcoming events (today+) and open tasks.
      evResults = events
        .filter((e) => {
          const { date } = eventDateParts(e);
          return date >= todayStr;
        })
        .sort((a, b) => a.start.localeCompare(b.start))
        .slice(0, 6)
        .map((event) => ({ kind: 'event' as const, event, score: 0 }));
      tkResults = tasks
        .filter((t) => !t.done)
        .sort((a, b) => {
          const ad = a.due || '9999';
          const bd = b.due || '9999';
          if (ad !== bd) return ad.localeCompare(bd);
          return (a.title || '').localeCompare(b.title || '');
        })
        .slice(0, 6)
        .map((task) => ({ kind: 'task' as const, task, score: 0 }));
    } else {
      evResults = events
        .map((event) => ({ kind: 'event' as const, event, score: scoreEvent(event, q) }))
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 30);
      tkResults = tasks
        .map((task) => ({ kind: 'task' as const, task, score: scoreTask(task, q) }))
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 30);
    }

    const showEvents = scope !== 'todos';
    const showTasks = scope !== 'events';
    const out: Item[] = [];
    if (showEvents && evResults.length > 0) {
      out.push({ kind: 'header', label: q ? 'Events' : 'Upcoming events', count: evResults.length });
      for (const r of evResults) out.push({ kind: 'event', event: r.event });
    }
    if (showTasks && tkResults.length > 0) {
      out.push({ kind: 'header', label: q ? 'Todos' : 'Open todos', count: tkResults.length });
      for (const r of tkResults) out.push({ kind: 'task', task: r.task });
    }
    return { items: out, eventCount: evResults.length, taskCount: tkResults.length };
  }, [open, query, scope, events, tasks, today]);

  // Indices of selectable rows (skip headers).
  const selectableIdx = useMemo(
    () => items.map((it, i) => (it.kind === 'header' ? -1 : i)).filter((i) => i >= 0),
    [items],
  );

  useEffect(() => {
    if (selectableIdx.length === 0) { setActiveIdx(0); return; }
    if (!selectableIdx.includes(activeIdx)) setActiveIdx(selectableIdx[0]);
  }, [selectableIdx]);

  useEffect(() => {
    if (selectableIdx.length > 0) setActiveIdx(selectableIdx[0]);
  }, [query, scope]);

  // Scroll the active row into view as the user navigates.
  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(`[data-row-idx="${activeIdx}"]`);
    if (!el) return;
    const lr = listRef.current.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    if (er.top < lr.top) listRef.current.scrollTop -= (lr.top - er.top) + 4;
    else if (er.bottom > lr.bottom) listRef.current.scrollTop += (er.bottom - lr.bottom) + 4;
  }, [activeIdx]);

  if (!open) return null;

  const moveActive = (dir: 1 | -1) => {
    if (selectableIdx.length === 0) return;
    const cur = selectableIdx.indexOf(activeIdx);
    const next = (cur + dir + selectableIdx.length) % selectableIdx.length;
    setActiveIdx(selectableIdx[next]);
  };

  const commit = (idx: number) => {
    const it = items[idx];
    if (!it) return;
    if (it.kind === 'event' && it.event) onPickEvent(it.event);
    else if (it.kind === 'task' && it.task) onPickTask(it.task.id);
    onClose();
  };

  const onKeyDown = (ev: React.KeyboardEvent<HTMLInputElement>) => {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      onClose();
    } else if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      moveActive(1);
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      moveActive(-1);
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      commit(activeIdx);
    } else if (ev.key === 'Tab') {
      ev.preventDefault();
      const order: Scope[] = ['all', 'events', 'todos'];
      const cur = order.indexOf(scope);
      const next = (cur + (ev.shiftKey ? -1 : 1) + order.length) % order.length;
      setScope(order[next]);
    }
  };

  const q = query.trim();
  const showEmpty = q.length > 0 && items.length === 0;

  return (
    <>
      <div className="sp-backdrop" onMouseDown={onClose} />
      <div className="sp-shell" role="dialog" aria-label="Search">
        <div className="sp-header">
          <span className="sp-icon" aria-hidden="true">
            <svg
              width="16" height="16" viewBox="0 0 16 16" fill="none"
              stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"
            >
              <circle cx="7" cy="7" r="4.5" />
              <path d="M10.5 10.5L14 14" />
            </svg>
          </span>
          <input
            ref={inputRef}
            className="sp-input"
            type="text"
            placeholder="Search events and todos…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            spellCheck="false"
            autoComplete="off"
          />
          <kbd className="sp-kbd sp-kbd-esc" onClick={onClose}>esc</kbd>
        </div>

        <div className="sp-scopes">
          {([
            { id: 'all',    label: 'All',    n: eventCount + taskCount },
            { id: 'events', label: 'Events', n: eventCount },
            { id: 'todos',  label: 'Todos',  n: taskCount },
          ] as const).map((s) => (
            <button
              key={s.id}
              className={'sp-scope ' + (scope === s.id ? 'on' : '')}
              onClick={() => setScope(s.id)}
            >
              <span>{s.label}</span>
              <span className="sp-scope-n">{s.n}</span>
            </button>
          ))}
          <span className="sp-hint">
            <kbd>↑</kbd><kbd>↓</kbd> move · <kbd>↵</kbd> open · <kbd>tab</kbd> scope
          </span>
        </div>

        <div className="sp-list" ref={listRef}>
          {items.length === 0 && !showEmpty && (
            <div className="sp-empty">
              <div className="sp-empty-rule">Nothing here yet</div>
              <div className="sp-empty-sub">Type to search across calendars and todos.</div>
            </div>
          )}
          {showEmpty && (
            <div className="sp-empty">
              <div className="sp-empty-rule">No matches for &ldquo;{q}&rdquo;</div>
              <div className="sp-empty-sub">Try a name, project, or place.</div>
            </div>
          )}
          {items.map((it, idx) => {
            if (it.kind === 'header') {
              return (
                <div key={'h' + idx} className="sp-section">
                  <span className="sp-section-label">{it.label}</span>
                  <span className="sp-section-rule" />
                  <span className="sp-section-count">{it.count}</span>
                </div>
              );
            }
            if (it.kind === 'event' && it.event) {
              const ev = it.event;
              const cal = calById[ev.calendarId];
              const sub = eventSubLine(ev, q);
              const isActive = idx === activeIdx;
              const { date, timeLabel } = eventDateParts(ev);
              return (
                <button
                  key={'e' + ev.id + idx}
                  data-row-idx={idx}
                  className={'sp-row sp-row-event ' + (isActive ? 'active' : '')}
                  onMouseEnter={() => setActiveIdx(idx)}
                  onClick={() => commit(idx)}
                >
                  <span className="sp-cal-tab" style={{ background: ev.color }} />
                  <span className="sp-row-body">
                    <span className="sp-row-line1">
                      <span className="sp-row-title"><Hl text={ev.title} q={q} /></span>
                      <span className="sp-row-meta">
                        <span className="sp-when">
                          {fmtRelativeDate(date, today)}
                          {timeLabel && <span className="sp-time"> · {timeLabel}</span>}
                          {!timeLabel && <span className="sp-time sp-allday"> · all day</span>}
                        </span>
                      </span>
                    </span>
                    <span className="sp-row-line2">
                      {cal && <span className="sp-cal-name"><Hl text={cal.name} q={q} /></span>}
                      {sub && (
                        <>
                          <span className="sp-dot">·</span>
                          <span className={'sp-sub sp-sub-' + sub.kind}>
                            <Hl text={sub.text} q={q} />
                          </span>
                        </>
                      )}
                    </span>
                  </span>
                  <span className="sp-row-kind">Event</span>
                </button>
              );
            }
            if (it.kind === 'task' && it.task) {
              const tk = it.task;
              const due = fmtTaskDue(tk, today);
              const isOverdue = due ? due.startsWith('Overdue') : false;
              const sub = taskSubLine(tk, q);
              const isActive = idx === activeIdx;
              const sched = tk.scheduledAt;
              return (
                <button
                  key={'t' + tk.id + idx}
                  data-row-idx={idx}
                  className={'sp-row sp-row-task ' + (isActive ? 'active' : '') + (tk.done ? ' done' : '')}
                  onMouseEnter={() => setActiveIdx(idx)}
                  onClick={() => commit(idx)}
                >
                  <span className="sp-task-check" aria-hidden="true">
                    <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
                      <rect
                        x="1" y="1" width="11" height="11" rx="2"
                        stroke="currentColor" strokeWidth="1" fill="none"
                      />
                      {tk.done && (
                        <path
                          d="M3.5 6.8 L5.6 8.9 L9.5 4.5"
                          stroke="currentColor" strokeWidth="1.4"
                          strokeLinecap="round" strokeLinejoin="round" fill="none"
                        />
                      )}
                    </svg>
                  </span>
                  <span className="sp-row-body">
                    <span className="sp-row-line1">
                      <span className="sp-row-title"><Hl text={tk.title} q={q} /></span>
                      <span className="sp-row-meta">
                        {due && (
                          <span className={'sp-due ' + (isOverdue ? 'overdue' : '')}>{due}</span>
                        )}
                        {sched && !due && (
                          <span className="sp-due">
                            Scheduled {fmtRelativeDate(sched.date, today)}
                          </span>
                        )}
                      </span>
                    </span>
                    <span className="sp-row-line2">
                      <span className="sp-task-proj">
                        <Hl text={tk.project} q={q} />
                      </span>
                      {tk.dur > 0 && (
                        <>
                          <span className="sp-dot">·</span>
                          <span className="sp-sub">{tk.dur} min</span>
                        </>
                      )}
                      {sub && (
                        <>
                          <span className="sp-dot">·</span>
                          <span className={'sp-sub sp-sub-' + sub.kind}>
                            <Hl text={sub.text} q={q} />
                          </span>
                        </>
                      )}
                    </span>
                  </span>
                  <span className="sp-row-kind">Todo</span>
                </button>
              );
            }
            return null;
          })}
        </div>

        <div className="sp-footer">
          <span className="sp-footer-l">
            <span className="sp-footer-ic">
              <svg
                width="11" height="11" viewBox="0 0 16 16" fill="none"
                stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"
              >
                <circle cx="7" cy="7" r="4.5" />
                <path d="M10.5 10.5L14 14" />
              </svg>
            </span>
            yCal search
          </span>
          <span className="sp-footer-r">
            {q ? `${eventCount} events · ${taskCount} todos`
                : `${eventCount + taskCount} suggestions`}
          </span>
        </div>
      </div>
    </>
  );
}
