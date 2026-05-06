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
//   #<anything else>           freeform label (status / location / context)
//   !p1 .. !p4                 priority (!p1 = highest)
//   @today  @tomorrow  @YYYY-MM-DD   due date
//
// As the user types one of the trigger chars (#, !, @) we open a small
// dropdown with matching candidates so they don't have to remember the
// exact spelling. The user's full label library (Todoist /labels or every
// #tag in tasks.md) leads the `#` pool so personal status/context tags
// like `waiting` or `thinking` are one keystroke away — duration and
// energy presets trail behind. The `@` pool is fixed (today / tomorrow);
// any explicit YYYY-MM-DD the user types is honoured on submit.

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

// Pull a due-date intent out of the typed title. We accept @today,
// @tomorrow, and @YYYY-MM-DD; the first match wins, matching the
// markdown provider's parser. Resolving to a concrete YYYY-MM-DD here
// (rather than passing the raw token) means a popup left open across
// midnight still files the task for the day the user *meant*.
function extractDue(raw: string): { title: string; due?: string } {
  const re = /(?:^|\s)@(today|tomorrow|\d{4}-\d{2}-\d{2})\b/i;
  const m = raw.match(re);
  if (!m) return { title: raw };
  const tok = m[1].toLowerCase();
  const due = tok === 'today'
    ? isoDate(new Date())
    : tok === 'tomorrow'
      ? isoDate(addDays(new Date(), 1))
      : tok;
  // Splice out the matched chunk (including the leading whitespace it
  // captured, so we don't leave a double space) and tidy whitespace.
  const title = (raw.slice(0, m.index ?? 0) + raw.slice((m.index ?? 0) + m[0].length))
    .replace(/\s+/g, ' ')
    .trim();
  return { title, due };
}

function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

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

// Cap on rows in the dropdown. High enough that a user with a couple
// dozen Todoist labels can scroll their full library; the popup is
// allowed to grow to ~600px so this still fits.
const SUGGEST_CAP = 16;

function suggestionsFor(
  ctx: TagContext,
  labels: string[],
): Suggestion[] {
  const q = ctx.query.toLowerCase();
  let pool: Suggestion[] = [];
  if (ctx.trigger === '#') {
    // Lead with the user's own labels (status / location / context — all
    // generic, so we mark them with a neutral "label" hint rather than
    // mis-classifying "thinking" or "waiting" as a location). The static
    // duration / energy chips trail behind and stay reachable by typing
    // their first character.
    pool = [
      ...labels.map((name) => ({
        value: name,
        display: `#${name}`,
        hint: 'label',
      })),
      ...DURATION_SUGGESTIONS,
      ...ENERGY_SUGGESTIONS,
    ];
  } else if (ctx.trigger === '!') {
    pool = PRIORITY_SUGGESTIONS;
  } else if (ctx.trigger === '@') {
    pool = DATE_SUGGESTIONS;
  }
  if (!q) return pool.slice(0, SUGGEST_CAP);
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
  return [...prefix, ...contains].slice(0, SUGGEST_CAP);
}

export function QuickAdd(): JSX.Element {
  const [title, setTitle] = useState('');
  const [providerLabel, setProviderLabel] = useState<string>('Quick add task');
  const [caret, setCaret] = useState(0);
  const [activeIdx, setActiveIdx] = useState(0);
  const [labels, setLabels] = useState<string[]>([]);
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

  // Pull labels from three sources, in priority order:
  //   1. User-defined tags from Settings → Tasks → Quick-add suggestions.
  //   2. Provider's full label library (Todoist /labels, or every #tag in
  //      tasks.md). This is the canonical pool — every label the user has
  //      defined, regardless of whether any open task currently carries it.
  //   3. Locations on cached tasks (fallback when /labels errors).
  // Reserved tokens (durations / energies) are stripped because they have
  // their own dedicated suggestion lists higher in the menu. Spaces are
  // normalised to underscores so a free-form Todoist label like "Deep
  // Work" survives the tag-shape check (Todoist permits spaces; yCal's
  // markdown grammar doesn't, hence the rewrite). The function is
  // re-runnable so the persistent popup can refresh its pool on each
  // chord — labels added to Todoist mid-session still show up.
  const refreshLabels = useCallback(async () => {
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
      const t = raw.trim().replace(/\s+/g, '_');
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
    setLabels(out);
  }, []);

  useEffect(() => { void refreshLabels(); }, [refreshLabels]);

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
      void refreshLabels();
      // Refocus the input on the next paint — the show() call from main
      // beats React's state flush, and the input may have been blurred
      // when the previous chord hid the window.
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.setSelectionRange(0, 0);
      });
    });
  }, [refreshLabels]);

  const tagCtx = useMemo(
    () => findTagContext(title, caret),
    [title, caret],
  );
  const suggestions = useMemo(
    () => (tagCtx ? suggestionsFor(tagCtx, labels) : []),
    [tagCtx, labels],
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
    // Resolve @today / @tomorrow / @YYYY-MM-DD into a due date so the
    // provider gets a real assigned-day field instead of treating the
    // token as a label tag (Todoist's @x syntax is its label sigil).
    const { title: cleanTitle, due } = extractDue(t);
    if (!cleanTitle) return;
    // Fire-and-forget: don't await the provider's network call before
    // dismissing the popup. The user gets instant Enter→close so the
    // chord feels native; the main process surfaces a system notification
    // if the upstream add later fails.
    void window.ycal.tasksAdd({ title: cleanTitle, due });
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
