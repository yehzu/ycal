// Quick-add task popup. Loaded into a small frameless window that the
// main process opens via the QUICK_ADD_SHORTCUT chord. Single text input
// with inline tag autocomplete → Enter posts to the active task provider →
// window closes.
//
// Tag grammar (mirrors the markdown provider's parser — both providers
// store the title verbatim, so the typed tags work either way):
//
//   #30m  #1h  #1.5h  #1h30m   duration
//   #low  #mid  #high          energy
//   #<anything else>           location / freeform label
//   !p1 .. !p4                 priority (!p1 = highest)
//   @today  @tomorrow          due date shortcuts
//
// As the user types one of the trigger chars (#, !, @) we open a small
// dropdown with matching candidates so they don't have to remember the
// exact spelling. Static suggestions cover the well-known categories;
// existing locations are pulled from the cached tasks list so the user's
// project / context labels are one keystroke away.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TaskItem } from '@shared/types';

interface Suggestion {
  // What gets inserted (without the trigger char). E.g. `30m`, `p1`, `today`.
  value: string;
  // What gets shown in the dropdown — usually `<trigger><value>`.
  display: string;
  // Short helper text shown to the right of the row.
  hint?: string;
}

interface TagContext {
  // The trigger char the user is currently completing.
  trigger: '#' | '!' | '@';
  // Position of the trigger in the title (so we can replace from there).
  start: number;
  // Text after the trigger up to the cursor (the user's partial query).
  query: string;
}

const DURATION_SUGGESTIONS: Suggestion[] = [
  { value: '15m', display: '#15m', hint: 'duration' },
  { value: '30m', display: '#30m', hint: 'duration' },
  { value: '45m', display: '#45m', hint: 'duration' },
  { value: '1h', display: '#1h', hint: 'duration' },
  { value: '1.5h', display: '#1.5h', hint: 'duration' },
  { value: '2h', display: '#2h', hint: 'duration' },
  { value: '3h', display: '#3h', hint: 'duration' },
];

const ENERGY_SUGGESTIONS: Suggestion[] = [
  { value: 'low', display: '#low', hint: 'energy' },
  { value: 'mid', display: '#mid', hint: 'energy' },
  { value: 'high', display: '#high', hint: 'energy' },
];

const PRIORITY_SUGGESTIONS: Suggestion[] = [
  { value: 'p1', display: '!p1', hint: 'highest' },
  { value: 'p2', display: '!p2', hint: 'high' },
  { value: 'p3', display: '!p3', hint: 'medium' },
  { value: 'p4', display: '!p4', hint: 'default' },
];

const DATE_SUGGESTIONS: Suggestion[] = [
  { value: 'today', display: '@today', hint: 'due today' },
  { value: 'tomorrow', display: '@tomorrow', hint: 'due tomorrow' },
];

// Find the tag context (trigger + partial query) immediately before the
// caret. Returns null if the user isn't mid-tag.
function findTagContext(title: string, caret: number): TagContext | null {
  // Walk backwards from the caret looking for the most recent trigger that
  // hasn't been broken by whitespace or another trigger. If we hit
  // whitespace before a trigger, we're not in a tag.
  for (let i = caret - 1; i >= 0; i--) {
    const ch = title[i];
    if (ch === '#' || ch === '!' || ch === '@') {
      // Trigger must start the title or follow whitespace.
      const before = i === 0 ? ' ' : title[i - 1];
      if (!/\s/.test(before)) return null;
      const query = title.slice(i + 1, caret);
      // Reject if the partial query already contains whitespace — that
      // means the user moved past the tag they were typing.
      if (/\s/.test(query)) return null;
      return { trigger: ch as '#' | '!' | '@', start: i, query };
    }
    if (/\s/.test(ch)) return null;
  }
  return null;
}

function suggestionsFor(
  ctx: TagContext,
  locations: string[],
): Suggestion[] {
  const q = ctx.query.toLowerCase();
  let pool: Suggestion[] = [];
  if (ctx.trigger === '#') {
    pool = [
      ...DURATION_SUGGESTIONS,
      ...ENERGY_SUGGESTIONS,
      ...locations.map((loc) => ({
        value: loc,
        display: `#${loc}`,
        hint: 'location',
      })),
    ];
  } else if (ctx.trigger === '!') {
    pool = PRIORITY_SUGGESTIONS;
  } else if (ctx.trigger === '@') {
    pool = DATE_SUGGESTIONS;
  }
  if (!q) return pool.slice(0, 8);
  // Prefix matches first, then substring. De-dupe by value.
  const seen = new Set<string>();
  const prefix: Suggestion[] = [];
  const contains: Suggestion[] = [];
  for (const s of pool) {
    if (seen.has(s.value)) continue;
    const v = s.value.toLowerCase();
    if (v.startsWith(q)) { prefix.push(s); seen.add(s.value); }
    else if (v.includes(q)) { contains.push(s); seen.add(s.value); }
  }
  return [...prefix, ...contains].slice(0, 8);
}

export function QuickAdd(): JSX.Element {
  const [title, setTitle] = useState('');
  const [providerLabel, setProviderLabel] = useState<string>('Quick add task');
  const [caret, setCaret] = useState(0);
  const [activeIdx, setActiveIdx] = useState(0);
  const [locations, setLocations] = useState<string[]>([]);
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

  // Pull location labels from three sources, in priority order:
  //   1. User-defined tags from Settings → Tasks → Quick-add suggestions.
  //   2. Provider's full label library (Todoist /labels, or every #tag in
  //      tasks.md). Catches labels the user has defined but hasn't yet
  //      attached to any open task.
  //   3. Locations on cached tasks (fallback when /labels errors).
  // Reserved tokens (durations / energies) are stripped because they have
  // their own dedicated suggestion lists higher in the menu. The function
  // is re-runnable so the persistent popup can refresh its pool on each
  // chord — labels added to Todoist mid-session still show up.
  const refreshLocations = useCallback(async () => {
    const [ui, local, labelsRes] = await Promise.all([
      window.ycal.getUiSettings(),
      window.ycal.tasksGetLocal(),
      window.ycal.tasksListLabels(),
    ]);
    const tagPattern = /^[A-Za-z0-9][\w./-]*$/;
    const reserved = /^(?:\d+(?:\.\d+)?h(?:\d+m)?|\d+m|low|mid|high)$/i;
    const seen = new Set<string>();
    const out: string[] = [];
    const push = (raw: string): void => {
      const t = raw.trim();
      if (!t || !tagPattern.test(t) || reserved.test(t) || seen.has(t)) return;
      seen.add(t);
      out.push(t);
    };
    for (const t of ui.customTagSuggestions ?? []) push(t);
    if (labelsRes.ok) {
      for (const t of labelsRes.labels) push(t);
    }
    const cache: TaskItem[] = local.cache ?? [];
    for (const t of cache) {
      if (t.location) push(t.location);
    }
    setLocations(out);
  }, []);

  useEffect(() => { void refreshLocations(); }, [refreshLocations]);

  // Persistent popup: every chord re-shows the same window, so the
  // renderer needs to reset its input + caret + suggestion state and
  // refresh the autocomplete pool when main fires this. Without the
  // refresh, labels added to Todoist mid-session wouldn't appear until
  // app restart.
  useEffect(() => {
    return window.ycal.onQuickAddReset(() => {
      setTitle('');
      setCaret(0);
      setActiveIdx(0);
      void refreshLocations();
      // Refocus the input on the next paint — the show() call from main
      // beats React's state flush, and the input may have been blurred
      // when the previous chord hid the window.
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.setSelectionRange(0, 0);
      });
    });
  }, [refreshLocations]);

  const tagCtx = useMemo(
    () => findTagContext(title, caret),
    [title, caret],
  );
  const suggestions = useMemo(
    () => (tagCtx ? suggestionsFor(tagCtx, locations) : []),
    [tagCtx, locations],
  );
  const showSuggestions = suggestions.length > 0;

  // Reset highlighted row whenever the suggestion list changes shape.
  useEffect(() => {
    setActiveIdx(0);
  }, [suggestions.length, tagCtx?.trigger, tagCtx?.start]);

  // Grow / shrink the popup window to fit the dropdown. Each suggestion
  // row is ~26px; the row-and-padding chrome is ~84px. Clamped in main;
  // this just signals intent.
  useEffect(() => {
    const ROW = 26;
    const CHROME = 84;
    const SUGGEST_PAD = 14;
    const target = CHROME
      + (showSuggestions ? SUGGEST_PAD + suggestions.length * ROW : 0);
    void window.ycal.resizeWindow(target);
  }, [showSuggestions, suggestions.length]);

  function applySuggestion(s: Suggestion): void {
    if (!tagCtx || !inputRef.current) return;
    // Replace `<trigger><query>` with `<trigger><value> ` and put the
    // caret after the trailing space so the user can continue typing.
    const before = title.slice(0, tagCtx.start);
    const after = title.slice(caret);
    const insertion = `${tagCtx.trigger}${s.value} `;
    const next = before + insertion + after;
    const nextCaret = before.length + insertion.length;
    setTitle(next);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(nextCaret, nextCaret);
      setCaret(nextCaret);
    });
  }

  function submit(): void {
    const t = title.trim();
    if (!t) return;
    // Fire-and-forget: don't await the provider's network call before
    // dismissing the popup. The user gets instant Enter→close so the
    // chord feels native; the main process surfaces a system notification
    // if the upstream add later fails.
    void window.ycal.tasksAdd({ title: t });
    void window.ycal.closeWindow();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (showSuggestions) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIdx((i) => (i + 1) % suggestions.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIdx((i) => (i - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        applySuggestion(suggestions[activeIdx]);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        applySuggestion(suggestions[activeIdx]);
        return;
      }
      if (e.key === 'Escape') {
        // First Escape dismisses the dropdown without closing the popup,
        // by nudging the caret past the trigger so findTagContext bails.
        e.preventDefault();
        const el = inputRef.current;
        if (el && tagCtx) {
          const breakAt = caret;
          const next = title.slice(0, breakAt) + ' ' + title.slice(breakAt);
          setTitle(next);
          requestAnimationFrame(() => {
            el.setSelectionRange(breakAt + 1, breakAt + 1);
            setCaret(breakAt + 1);
          });
        }
        return;
      }
    }
    if (e.key === 'Enter') submit();
    else if (e.key === 'Escape') void window.ycal.closeWindow();
  }

  function syncCaret(): void {
    const el = inputRef.current;
    if (!el) return;
    setCaret(el.selectionStart ?? 0);
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
          onChange={(e) => {
            setTitle(e.target.value);
            setCaret(e.target.selectionStart ?? e.target.value.length);
          }}
          onKeyUp={syncCaret}
          onClick={syncCaret}
          onSelect={syncCaret}
          onKeyDown={onKeyDown}
        />
        <span className="quickadd-hint">enter</span>
      </div>
      {showSuggestions && (
        <ul className="quickadd-suggest" role="listbox">
          {suggestions.map((s, i) => (
            <li
              key={`${s.display}-${i}`}
              role="option"
              aria-selected={i === activeIdx}
              className={
                'quickadd-suggest-row' + (i === activeIdx ? ' is-active' : '')
              }
              onMouseDown={(e) => {
                // Prevent the input from blurring (which would close the popup)
                // before we have a chance to apply the suggestion.
                e.preventDefault();
                applySuggestion(s);
              }}
              onMouseEnter={() => setActiveIdx(i)}
            >
              <span className="quickadd-suggest-label">{s.display}</span>
              {s.hint && (
                <span className="quickadd-suggest-hint">{s.hint}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
