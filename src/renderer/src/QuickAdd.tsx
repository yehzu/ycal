// Quick-add task popup. Loaded into a small frameless window that the
// main process opens via the QUICK_ADD_SHORTCUT chord. Single text input
// → Enter posts to the active task provider → window closes.
//
// Lifecycle notes:
//   * Escape closes the window.
//   * On submit success we close immediately (Spotlight-style) so the
//     user can keep firing the hotkey. The new task will appear on the
//     next regular tasks refresh in the main window.
//   * On submit failure we surface the message inline and keep the input
//     populated so the user doesn't lose their typing.

import { useEffect, useRef, useState } from 'react';

type SubmitState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'error'; message: string };

export function QuickAdd(): JSX.Element {
  const [title, setTitle] = useState('');
  const [providerLabel, setProviderLabel] = useState<string>('Quick add task');
  const [state, setState] = useState<SubmitState>({ kind: 'idle' });
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Focus the input on mount; an alwaysOnTop window doesn't always pull
  // focus to the field automatically.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Pull provider name once for placeholder text. Keeps the popup honest
  // about where the task will land (Todoist Inbox vs tasks.md → Inbox).
  useEffect(() => {
    let cancelled = false;
    void window.ycal.tasksGetProviderInfo().then((info) => {
      if (cancelled) return;
      setProviderLabel(`Add to ${info.displayName} Inbox`);
    });
    return () => { cancelled = true; };
  }, []);

  async function submit(): Promise<void> {
    const t = title.trim();
    if (!t || state.kind === 'saving') return;
    setState({ kind: 'saving' });
    try {
      const res = await window.ycal.tasksAdd({ title: t });
      if (!res.ok) {
        setState({ kind: 'error', message: res.error });
        return;
      }
      void window.ycal.closeWindow();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setState({ kind: 'error', message });
    }
  }

  return (
    <div className="quickadd-root">
      <div className="quickadd-row">
        <span className="quickadd-glyph" aria-hidden>＋</span>
        <input
          ref={inputRef}
          className="quickadd-input"
          type="text"
          value={title}
          placeholder={providerLabel}
          spellCheck={false}
          autoComplete="off"
          disabled={state.kind === 'saving'}
          onChange={(e) => {
            setTitle(e.target.value);
            if (state.kind === 'error') setState({ kind: 'idle' });
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit();
            else if (e.key === 'Escape') void window.ycal.closeWindow();
          }}
        />
        <span className="quickadd-hint">
          {state.kind === 'saving' ? '…' : 'enter'}
        </span>
      </div>
      {state.kind === 'error' && (
        <div className="quickadd-error" role="alert">{state.message}</div>
      )}
    </div>
  );
}
