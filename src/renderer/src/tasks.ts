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
// hasn't been completed is shown back in the inbox (as "carry over"). With
// the autoRollover setting on (default), the schedule entry is also
// cleared on the next render so the chip disappears from the calendar
// grid. With the setting off, the entry stays parked on its original day
// and the inbox shows a soft "↻" carry hint instead.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  TaskComment,
  TaskItem,
  TaskProjectNode,
  TaskProviderInfo,
  TasksLocalState,
} from '@shared/types';
import { fmtDate } from './dates';

const PROJECT_FALLBACK_COLOR = '#5b7a8e';

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
  const initialLoadedRef = useRef(false);
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
      });
      if (localState.cache && localState.cache.length > 0) {
        setTasks(localState.cache);
        const order = uniqStrings(localState.cache.map((t) => t.project));
        if (order.length > 0) setProjectOrder(order);
      }
      initialLoadedRef.current = true;
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
      // Reopen: clear local marker and reopen the task on Todoist.
      const nextDone = { ...local.doneOn };
      delete nextDone[taskId];
      await persistLocal({ doneOn: nextDone });
      const res = await window.ycal.tasksReopen(taskId);
      if (!res.ok) {
        // Roll back on failure so the UI doesn't lie.
        await persistLocal({ doneOn: { ...nextDone, [taskId]: existed } });
        setError(res.error);
      } else {
        await refresh();
      }
      return;
    }
    const nextDone = { ...local.doneOn, [taskId]: todayStr };
    await persistLocal({ doneOn: nextDone });
    const res = await window.ycal.tasksClose(taskId);
    if (!res.ok) {
      const rollback = { ...nextDone };
      delete rollback[taskId];
      await persistLocal({ doneOn: rollback });
      setError(res.error);
    } else {
      await refresh();
    }
  }, [local.doneOn, persistLocal, refresh, today]);

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

  // Hydrate `scheduledAt` onto each task from local schedule, and consider a
  // task done if either Todoist says so OR the local marker is set.
  const hydrated = useMemo<TaskItem[]>(() => {
    return tasks.map((t) => {
      const slot = local.scheduled[t.id] ?? null;
      const localDone = !!local.doneOn[t.id];
      return {
        ...t,
        scheduledAt: slot,
        done: t.done || localDone,
      };
    });
  }, [tasks, local.scheduled, local.doneOn]);

  const todayStr = fmtDate(today);

  // Auto-rollover sweep: when the toggle is on, any past-dated scheduled
  // entry whose task isn't done loses its slot. We do this idempotently
  // here (next render reflects the cleared state) so the chip vanishes
  // from the calendar grid and the task surfaces as a regular inbox row.
  // Skip until the initial fetch has resolved so we don't accidentally
  // wipe entries for tasks that just haven't loaded yet.
  useEffect(() => {
    if (!autoRollover) return;
    if (!initialLoadedRef.current) return;
    const idsToClear: string[] = [];
    for (const t of hydrated) {
      if (t.done) continue;
      if (!t.scheduledAt) continue;
      if (t.scheduledAt.date >= todayStr) continue;
      idsToClear.push(t.id);
    }
    if (idsToClear.length === 0) return;
    const nextScheduled = { ...local.scheduled };
    for (const id of idsToClear) delete nextScheduled[id];
    void persistLocal({ scheduled: nextScheduled });
  }, [autoRollover, hydrated, todayStr, local.scheduled, persistLocal]);

  // Carryover: scheduled in the past, not yet done. With auto-rollover off,
  // these still show in the inbox panel as a soft "↻ carry" hint while
  // their schedule entry stays parked on the original day.
  const carryoverIds = useMemo(() => {
    const out = new Set<string>();
    for (const t of hydrated) {
      if (t.done) continue;
      if (!t.scheduledAt) continue;
      if (t.scheduledAt.date < todayStr) out.add(t.id);
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

  const scheduledById = useMemo(() => {
    const out: Record<string, { date: string; start: string }> = {};
    for (const t of hydrated) {
      if (t.scheduledAt && !t.done) out[t.id] = t.scheduledAt;
    }
    return out;
  }, [hydrated]);

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
