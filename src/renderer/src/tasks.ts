// yCal — tasks store hook.
//
// Owns Todoist fetch + the local schedule overlay. Rendering split:
//
//   * `tasks`        — full server tasks, possibly stale, with `scheduledAt`
//                      hydrated from local state.
//   * `inboxTasks`   — what the right-rail panel should show (undone +
//                      either unscheduled OR scheduled-but-overdue).
//   * `scheduledById`— map for the calendar grid to look up the chip slot.
//
// AUTO-ROLLOVER: any task scheduled to a date earlier than today that
// hasn't been completed is surfaced in the inbox's Overdue bucket. The
// `scheduledAt` slot is preserved either way — wiping it makes the task
// indistinguishable from a brand-new inbox row, which lets overdue items
// silently scatter into project sections (or worse, into the collapsed
// Routines fold for recurring tasks). With `autoRollover` on (default),
// the calendar chip is suppressed on its original past column at render
// time so the grid still feels rolled-over; with it off, the chip stays
// parked on its original day. Either way, the task remains visible in
// the side panel under "Overdue".

import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  TaskComment,
  TaskItem,
  TaskProjectNode,
  TaskProviderInfo,
  TasksLocalState,
} from '@shared/types';
import { fmtDate } from './dates';

const PROJECT_FALLBACK_COLOR = '#5b7a8e';

// Days to keep showing a checked-off task's chip on the calendar after
// completion. The disk-side prune in tasksStore.ts uses the same constant
// (kept independently to avoid a renderer→main import dance).
const COMPLETED_RETAIN_DAYS = 30;

function isoDateMinusDays(base: string, days: number): string {
  const d = new Date(base + 'T00:00:00');
  d.setDate(d.getDate() - days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export interface TasksStore {
  provider: TaskProviderInfo | null;
  // All registered providers, with `.active` set on the one currently in
  // use. Settings → Tasks renders this as a segmented control. Empty
  // until the first IPC roundtrip resolves.
  providers: TaskProviderInfo[];
  setActiveProvider: (id: 'todoist' | 'markdown') => Promise<void>;
  setCredentials: (key: string | null) => Promise<void>;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  // Server tasks merged with local schedule. Ordered as Todoist returned them.
  tasks: TaskItem[];
  // Project ordering for the masthead. Empty until the first fetch lands.
  projectOrder: string[];
  projectColor: Record<string, string>;
  // Project tree (flat list with parentId). Empty until the first fetch.
  projects: TaskProjectNode[];
  // Carryover ids — scheduled in the past, still not done.
  carryoverIds: Set<string>;
  // Tasks to show in the right-rail panel (undone, plus carryover).
  inboxTasks: TaskItem[];
  // taskId → schedule slot, for chip rendering on the time grid.
  scheduledById: Record<string, { date: string; start: string }>;
  // Set of taskIds the user marked done today — drives the panel's
  // "Done today · N" footer + transient strike-through.
  doneTodayIds: Set<string>;
  // Set of routine taskIds that fire today (recurring-tasks pop-out).
  scheduleTask: (taskId: string, date: string, start: string) => Promise<void>;
  unscheduleTask: (taskId: string) => Promise<void>;
  toggleDone: (taskId: string) => Promise<void>;
  addComment: (taskId: string, text: string) => Promise<TaskComment | null>;
}

export function useTasks(today: Date, autoRollover: boolean): TasksStore {
  const [provider, setProvider] = useState<TaskProviderInfo | null>(null);
  const [providers, setProviders] = useState<TaskProviderInfo[]>([]);
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [projectOrder, setProjectOrder] = useState<string[]>([]);
  const [projectColor, setProjectColor] = useState<Record<string, string>>({});
  const [projects, setProjects] = useState<TaskProjectNode[]>([]);
  const [local, setLocal] = useState<TasksLocalState>({ scheduled: {}, doneOn: {} });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const apiKeySet = !!provider?.hasCredentials;

  // ── Boot: pull cached tasks + provider info, then refresh from upstream
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [info, providerList, localState] = await Promise.all([
        window.ycal.tasksGetProviderInfo(),
        window.ycal.tasksListProviders(),
        window.ycal.tasksGetLocal(),
      ]);
      if (cancelled) return;
      setProvider(info);
      setProviders(providerList);
      setLocal({
        scheduled: localState.scheduled ?? {},
        doneOn: localState.doneOn ?? {},
        cache: localState.cache,
        cacheAt: localState.cacheAt,
        completed: localState.completed,
      });
      if (localState.cache && localState.cache.length > 0) {
        setTasks(localState.cache);
        const order = uniqStrings(localState.cache.map((t) => t.project));
        if (order.length > 0) setProjectOrder(order);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const refresh = useCallback(async () => {
    if (!apiKeySet) return;
    setLoading(true);
    setError(null);
    try {
      const res = await window.ycal.tasksList();
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setTasks(res.tasks);
      setProjectOrder(res.projectOrder);
      setProjectColor(res.projectColor);
      setProjects(res.projects ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [apiKeySet]);

  // First fetch when key becomes available.
  useEffect(() => {
    if (!apiKeySet) return;
    void refresh();
  }, [apiKeySet, refresh]);

  // Slow poll so panels stay in sync with Todoist on the web/mobile.
  useEffect(() => {
    if (!apiKeySet) return;
    const id = window.setInterval(() => { void refresh(); }, 5 * 60_000);
    const onFocus = () => { void refresh(); };
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(id);
      window.removeEventListener('focus', onFocus);
    };
  }, [apiKeySet, refresh]);

  // Cross-device sync: when iCloud delivers a tasks-schedule.json edit
  // from another Mac, replace the local overlay wholesale. We DON'T
  // round-trip via persistLocal — the file already has the new state,
  // and persistLocal would write back (cloudStore would dedupe but
  // it's still a wasted call).
  useEffect(() => {
    const off = window.ycal.onTasksLocalChanged((next) => {
      setLocal({
        scheduled: next.scheduled ?? {},
        doneOn: next.doneOn ?? {},
        cache: next.cache,
        cacheAt: next.cacheAt,
        completed: next.completed,
      });
    });
    return off;
  }, []);

  // Cross-device sync: when tasks.md changes on disk (markdown provider
  // active, another Mac edited it), trigger a refresh so the panel
  // reflects new tasks/projects. We re-check provider id at fire time
  // because the user could have switched providers since boot.
  useEffect(() => {
    const off = window.ycal.onTasksProviderDataChanged((info) => {
      if (provider?.id === info.providerId) void refresh();
    });
    return off;
  }, [provider?.id, refresh]);

  const setCredentials = useCallback(async (key: string | null) => {
    const res = await window.ycal.tasksSetCredentials(key);
    if (!res.ok) throw new Error(res.error);
    const info = await window.ycal.tasksGetProviderInfo();
    setProvider(info);
    if (!info.hasCredentials) {
      setTasks([]);
      setProjectOrder([]);
      setProjectColor({});
      setProjects([]);
    }
  }, []);

  // Switch providers. The cached tasks belong to the *previous* provider's
  // namespace, so wipe them — otherwise the panel briefly shows stale rows
  // until the new provider's first listTasks call lands. The fresh fetch
  // below re-fills the state.
  const setActiveProvider = useCallback(async (id: 'todoist' | 'markdown') => {
    const res = await window.ycal.tasksSetActiveProvider(id);
    if (!res.ok) throw new Error(res.error);
    setProvider(res.info);
    const list = await window.ycal.tasksListProviders();
    setProviders(list);
    setTasks([]);
    setProjectOrder([]);
    setProjectColor({});
    setProjects([]);
    setError(null);
    if (res.info.hasCredentials) {
      setLoading(true);
      try {
        const fetched = await window.ycal.tasksList();
        if (fetched.ok) {
          setTasks(fetched.tasks);
          setProjectOrder(fetched.projectOrder);
          setProjectColor(fetched.projectColor);
          setProjects(fetched.projects ?? []);
        } else {
          setError(fetched.error);
        }
      } finally {
        setLoading(false);
      }
    }
  }, []);

  // ── Local mutations (scheduling / done) ─────────────────────────────

  const persistLocal = useCallback(async (next: Partial<TasksLocalState>) => {
    const merged: TasksLocalState = {
      scheduled: next.scheduled ?? local.scheduled,
      doneOn: next.doneOn ?? local.doneOn,
      cache: next.cache ?? local.cache,
      cacheAt: next.cacheAt ?? local.cacheAt,
      completed: next.completed !== undefined ? next.completed : local.completed,
    };
    setLocal(merged);
    await window.ycal.tasksSetLocal(merged);
  }, [local]);

  const scheduleTask = useCallback(async (taskId: string, date: string, start: string) => {
    const nextScheduled = { ...local.scheduled, [taskId]: { date, start } };
    await persistLocal({ scheduled: nextScheduled });
  }, [local.scheduled, persistLocal]);

  const unscheduleTask = useCallback(async (taskId: string) => {
    if (!(taskId in local.scheduled)) return;
    const nextScheduled = { ...local.scheduled };
    delete nextScheduled[taskId];
    await persistLocal({ scheduled: nextScheduled });
  }, [local.scheduled, persistLocal]);

  const toggleDone = useCallback(async (taskId: string) => {
    const todayStr = fmtDate(today);
    const existed = local.doneOn[taskId];
    if (existed) {
      // Reopen: clear local marker AND drop the kept snapshot — once the
      // task is active again the upstream provider becomes the source of
      // truth, and we don't want the old chip ghosting next to it.
      const nextDone = { ...local.doneOn };
      delete nextDone[taskId];
      const nextCompleted = { ...(local.completed ?? {}) };
      const completedSnapshot = nextCompleted[taskId];
      delete nextCompleted[taskId];
      await persistLocal({ doneOn: nextDone, completed: nextCompleted });
      const res = await window.ycal.tasksReopen(taskId);
      if (!res.ok) {
        // Roll back on failure so the UI doesn't lie.
        const rollbackCompleted = { ...nextCompleted };
        if (completedSnapshot) rollbackCompleted[taskId] = completedSnapshot;
        await persistLocal({
          doneOn: { ...nextDone, [taskId]: existed },
          completed: rollbackCompleted,
        });
        setError(res.error);
      } else {
        await refresh();
      }
      return;
    }
    // Snapshot the live task data before closing — once Todoist drops it
    // from the active list, this is what feeds the calendar grid chip
    // for the next 30 days.
    const live = tasks.find((t) => t.id === taskId);
    const nextDone = { ...local.doneOn, [taskId]: todayStr };
    const prevCompleted = local.completed ?? {};
    const nextCompleted = { ...prevCompleted };
    if (live) {
      nextCompleted[taskId] = {
        snapshot: { ...live, scheduledAt: null, comments: [] },
        completedOn: todayStr,
      };
    }
    await persistLocal({ doneOn: nextDone, completed: nextCompleted });
    const res = await window.ycal.tasksClose(taskId);
    if (!res.ok) {
      const rollbackDone = { ...nextDone };
      delete rollbackDone[taskId];
      const rollbackCompleted = { ...nextCompleted };
      delete rollbackCompleted[taskId];
      await persistLocal({ doneOn: rollbackDone, completed: rollbackCompleted });
      setError(res.error);
    } else {
      await refresh();
    }
  }, [local.doneOn, local.completed, tasks, persistLocal, refresh, today]);

  const addComment = useCallback(async (taskId: string, text: string): Promise<TaskComment | null> => {
    const res = await window.ycal.tasksAddComment(taskId, text);
    if (!res.ok) {
      setError(res.error);
      return null;
    }
    setTasks((cur) => cur.map((t) => (
      t.id === taskId
        ? { ...t, comments: [...t.comments, res.comment] }
        : t
    )));
    return res.comment;
  }, []);

  // ── Derived state ───────────────────────────────────────────────────

  const todayStr = fmtDate(today);
  const completedCutoff = isoDateMinusDays(todayStr, COMPLETED_RETAIN_DAYS);

  // Hydrate `scheduledAt` onto each task from local schedule, and consider a
  // task done if either the provider says so OR the local marker is set.
  // Then resurrect any completed snapshots whose upstream task has been
  // dropped from the active list — they keep populating the grid for
  // COMPLETED_RETAIN_DAYS so the user can still see what they did this month.
  const hydrated = useMemo<TaskItem[]>(() => {
    const out: TaskItem[] = [];
    const seen = new Set<string>();
    for (const t of tasks) {
      seen.add(t.id);
      const slot = local.scheduled[t.id] ?? null;
      // Optimistic-tick marker: only trust localDone on the same calendar
      // day. Why: Todoist rolls a recurring task's due date forward on
      // close and immediately returns the next occurrence with
      // is_completed=false. Without an expiry, the stale marker would
      // silently hide every future firing of the same task. Tasks that
      // are *really* done (non-recurring closes) keep their snapshot in
      // local.completed below, so they stay visible there.
      const localDoneAt = local.doneOn[t.id];
      const localDone = !!localDoneAt && localDoneAt === todayStr;
      out.push({
        ...t,
        scheduledAt: slot,
        done: t.done || localDone,
      });
    }
    if (local.completed) {
      for (const [id, entry] of Object.entries(local.completed)) {
        if (seen.has(id)) continue;
        if (entry.completedOn < completedCutoff) continue;
        const slot = local.scheduled[id] ?? entry.snapshot.scheduledAt ?? null;
        out.push({
          ...entry.snapshot,
          scheduledAt: slot,
          done: true,
        });
      }
    }
    return out;
  }, [tasks, local.scheduled, local.doneOn, local.completed, completedCutoff, todayStr]);

  // Carryover: any undone task whose "promise date" is in the past —
  // either the local schedule slot OR a Todoist due date when there's no
  // local schedule. The Overdue bucket in the panel reads from this set
  // so users can't lose track of work they planned for yesterday or
  // missed a Todoist due on.
  const carryoverIds = useMemo(() => {
    const out = new Set<string>();
    for (const t of hydrated) {
      if (t.done) continue;
      const promise = t.scheduledAt?.date ?? t.due;
      if (!promise) continue;
      if (promise < todayStr) out.add(t.id);
    }
    return out;
  }, [hydrated, todayStr]);

  // Inbox = all undone tasks that aren't currently scheduled to a future or
  // today slot. Past-scheduled-but-undone tasks (carryover) are explicitly
  // surfaced here too; the panel's `carry` flag drives the styling.
  const inboxTasks = useMemo(() => {
    return hydrated.filter((t) => {
      if (t.done) return false;
      if (!t.scheduledAt) return true;
      // Show scheduled tasks too — the panel renders them in their muted
      // "scheduled" state with a small WED · 10:00 chip, exactly the design.
      // (Carryover ones show with the ↻ glyph instead.)
      return true;
    });
  }, [hydrated]);

  // Calendar-grid chip lookup. Three rules:
  //   * Open tasks: show chip on the scheduled day, except past-scheduled
  //     when auto-rollover is on (those surface in the panel's Overdue
  //     bucket instead).
  //   * Completed tasks: keep the chip visible on its original slot for
  //     COMPLETED_RETAIN_DAYS after completion so the user has a record
  //     of what landed when. We look at completedOn rather than the
  //     scheduled date — a chip dropped on Monday and finished on Friday
  //     should still show on Monday for the full retention window.
  //   * Anything older than the cutoff falls off the grid silently.
  const scheduledById = useMemo(() => {
    const out: Record<string, { date: string; start: string }> = {};
    for (const t of hydrated) {
      if (!t.scheduledAt) continue;
      if (t.done) {
        const completedOn = local.completed?.[t.id]?.completedOn
          ?? local.doneOn[t.id];
        if (!completedOn) continue;
        if (completedOn < completedCutoff) continue;
        out[t.id] = t.scheduledAt;
        continue;
      }
      if (autoRollover && t.scheduledAt.date < todayStr) continue;
      out[t.id] = t.scheduledAt;
    }
    return out;
  }, [hydrated, autoRollover, todayStr, local.completed, local.doneOn, completedCutoff]);

  const doneTodayIds = useMemo(() => {
    const s = new Set<string>();
    for (const [id, when] of Object.entries(local.doneOn)) {
      if (when === todayStr) s.add(id);
    }
    return s;
  }, [local.doneOn, todayStr]);

  return {
    provider,
    providers,
    setActiveProvider,
    setCredentials,
    loading,
    error,
    refresh,
    tasks: hydrated,
    projectOrder,
    projects,
    projectColor: useMemo(() => {
      // Fill in any missing project with a neutral fallback so renderers
      // can blindly index into projectColor[task.project].
      const out: Record<string, string> = { ...projectColor };
      for (const p of projectOrder) {
        if (!out[p]) out[p] = PROJECT_FALLBACK_COLOR;
      }
      for (const t of hydrated) {
        if (!out[t.project]) out[t.project] = PROJECT_FALLBACK_COLOR;
      }
      return out;
    }, [projectColor, projectOrder, hydrated]),
    carryoverIds,
    inboxTasks,
    scheduledById,
    doneTodayIds,
    scheduleTask,
    unscheduleTask,
    toggleDone,
    addComment,
  };
}

// Whether a recurring task (e.g. "every Monday") fires on the given date.
export function taskOccursOn(task: TaskItem, date: Date): boolean {
  if (!task.recur || !task.recur.dow) return false;
  return task.recur.dow.includes(date.getDay());
}

function uniqStrings(arr: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of arr) {
    if (!seen.has(s)) { seen.add(s); out.push(s); }
  }
  return out;
}
