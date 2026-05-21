// yCal — Transcript sheet (slides in from the right edge).
//
// Replaces "open transcript.txt in TextEdit" with an in-app reader that
// supports selection-based correction. Click a word → inline popover →
// type the correct version → save to global glossary (default) or to
// the per-event override.
//
// Companion: triggers a Re-process from the footer so the user can
// regenerate the transcript + summary with the new corrections applied
// without navigating away.

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CalendarEvent, GlossaryEntry } from '@shared/types';
import { useGlossary } from '../glossary';

interface Props {
  event: CalendarEvent;
  // Local transcript path (preferred). If null, the sheet falls back
  // to fetching from Drive via TranscriptRead IPC.
  transcriptFile: string | null;
  // Local audio path — used by the Re-process button. When null,
  // re-process is hidden (only Drive copies, can't re-run locally).
  audioFile: string | null;
  // For Drive-fetch fallback when transcriptFile is null.
  accountId: string | null;
  onClose: () => void;
}

interface InlinePopover {
  // Token the user clicked (the misrecognized text).
  token: string;
  // Position to anchor the popover.
  anchorRect: DOMRect;
}

interface Highlight {
  // Range of canonical (the word that's already aliased) — for the
  // "this would be corrected on re-process" hint.
  spans: Set<string>;
}

// Split transcript text into tokens + non-token chunks. Tokens are
// runs of [A-Za-z0-9'-] for ASCII or any single CJK ideograph; chunks
// are spaces / punctuation. We keep both so the rendered text is byte-
// identical to the source.
function tokenize(text: string): Array<{ kind: 'token' | 'gap'; value: string }> {
  if (!text) return [];
  const out: Array<{ kind: 'token' | 'gap'; value: string }> = [];
  // Word := ASCII letters/digits/apostrophe/hyphen, OR a single CJK char.
  // Everything else (whitespace, punctuation) → 'gap'.
  const re = /([A-Za-z0-9][A-Za-z0-9'\-]*|[㐀-鿿])/g;
  let lastEnd = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > lastEnd) {
      out.push({ kind: 'gap', value: text.slice(lastEnd, m.index) });
    }
    out.push({ kind: 'token', value: m[0] });
    lastEnd = m.index + m[0].length;
  }
  if (lastEnd < text.length) {
    out.push({ kind: 'gap', value: text.slice(lastEnd) });
  }
  return out;
}

// Build a Set of tokens that are already aliased — these get a soft
// yellow highlight. The user sees "if I re-process now, these will be
// changed automatically".
function buildHighlightSet(entries: GlossaryEntry[]): Set<string> {
  const out = new Set<string>();
  for (const e of entries) {
    for (const a of e.aliases) {
      if (a.trim()) out.add(a.toLowerCase());
    }
  }
  return out;
}

export function TranscriptSheet({
  event, transcriptFile, audioFile, accountId, onClose,
}: Props) {
  const [body, setBody] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [popover, setPopover] = useState<InlinePopover | null>(null);
  const [draft, setDraft] = useState<string>('');
  const [globalScope, setGlobalScope] = useState<boolean>(true);
  const [saving, setSaving] = useState<boolean>(false);
  const [reprocessing, setReprocessing] = useState<boolean>(false);
  const [savedCount, setSavedCount] = useState<number>(0);
  const glossary = useGlossary();

  const highlights = useMemo(() =>
    buildHighlightSet(glossary.file.entries),
  [glossary.file.entries]);

  // Load transcript on mount or when the event changes.
  useEffect(() => {
    setLoading(true);
    setError(null);
    setBody('');
    setSavedCount(0);
    (async () => {
      const payload = transcriptFile
        ? { path: transcriptFile }
        : { path: '', eventId: event.id, accountId: accountId ?? null };
      const result = await window.ycal.transcriptRead(payload);
      if (result.ok) {
        setBody(result.body);
      } else {
        setError(result.error);
      }
      setLoading(false);
    })();
  }, [event.id, transcriptFile, accountId]);

  // Esc closes the sheet (unless an inline popover is open — Esc clears
  // that first, the same way Apple's inspector hierarchies do).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (popover) {
        setPopover(null);
        return;
      }
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [popover, onClose]);

  const onTokenClick = useCallback((token: string, ev: React.MouseEvent<HTMLSpanElement>) => {
    const rect = ev.currentTarget.getBoundingClientRect();
    setPopover({ token, anchorRect: rect });
    setDraft('');
    setGlobalScope(true);
  }, []);

  const dismissPopover = useCallback(() => {
    setPopover(null);
    setDraft('');
  }, []);

  const saveCorrection = useCallback(async () => {
    if (!popover) return;
    const replacement = draft.trim();
    if (!replacement) {
      dismissPopover();
      return;
    }
    setSaving(true);
    try {
      if (globalScope) {
        // Look for an existing entry whose canonical matches the
        // replacement (case-insensitive). If found, append the alias;
        // otherwise add a new entry.
        const existing = glossary.file.entries.find(
          (e) => e.canonical.toLowerCase() === replacement.toLowerCase(),
        );
        if (existing) {
          const aliases = existing.aliases.slice();
          if (!aliases.some((a) => a.toLowerCase() === popover.token.toLowerCase())) {
            aliases.push(popover.token);
          }
          await glossary.updateEntry(existing.id, { aliases });
        } else {
          await glossary.addEntry({
            canonical: replacement,
            aliases: [popover.token],
            category: guessCategoryFor(replacement, popover.token),
            source: 'inline',
          });
        }
      } else {
        const current = await glossary.getEventGlossary(event.id);
        const existing = current.entries.find(
          (e) => e.canonical.toLowerCase() === replacement.toLowerCase(),
        );
        let entries: GlossaryEntry[];
        if (existing) {
          entries = current.entries.map((e) => {
            if (e.id !== existing.id) return e;
            if (e.aliases.some((a) => a.toLowerCase() === popover.token.toLowerCase())) {
              return e;
            }
            return { ...e, aliases: [...e.aliases, popover.token] };
          });
        } else {
          const fresh: GlossaryEntry = {
            id: typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
              ? crypto.randomUUID()
              : `${Date.now()}-${Math.random()}`,
            canonical: replacement,
            aliases: [popover.token],
            category: guessCategoryFor(replacement, popover.token),
            addedAt: Date.now(),
            source: 'inline',
          };
          entries = [...current.entries, fresh];
        }
        await glossary.setEventGlossary(event.id, event.accountId, entries);
      }
      setSavedCount((n) => n + 1);
    } finally {
      setSaving(false);
      dismissPopover();
    }
  }, [popover, draft, globalScope, glossary, event, dismissPopover]);

  const reprocess = useCallback(async () => {
    if (!audioFile) return;
    setReprocessing(true);
    try {
      await window.ycal.recorderReprocess({
        eventId: event.id,
        audioFile,
        title: event.title,
        accountId: event.accountId,
      });
      // Re-process is fire-and-forget on the renderer side; the popover's
      // recording row will show "Transcribing…" via the existing status
      // push channel. We just close the sheet so the user goes back to
      // the popover and sees progress there.
      onClose();
    } finally {
      setReprocessing(false);
    }
  }, [event, audioFile, onClose]);

  const openExternally = useCallback(() => {
    if (!transcriptFile) return;
    void window.ycal.recorderOpenFile(transcriptFile);
  }, [transcriptFile]);

  const tokens = useMemo(() => tokenize(body), [body]);

  // Popover position: anchored under the clicked word, clamped to the
  // viewport so it doesn't overflow on edge clicks.
  const popoverStyle = popover
    ? popoverStyleFor(popover.anchorRect)
    : null;

  return (
    <>
      <div className="ts-scrim" onClick={onClose} />
      <aside className="ts-sheet xs-sheet" data-screen-label="Transcript Sheet">
        <header className="ts-head">
          <div className="ts-eyebrow">
            <span className="xs-eyebrow-label">Transcript</span>
            {savedCount > 0 && (
              <span className="xs-saved-note">{savedCount} 個修正已存入詞庫</span>
            )}
          </div>
          <button className="ts-close" onClick={onClose} title="Close (Esc)">×</button>
        </header>

        <div className="xs-titlerow">
          <h2 className="ts-title xs-title">{event.title || 'Untitled meeting'}</h2>
        </div>

        <div className="xs-body">
          {loading && <p className="xs-status">Loading transcript…</p>}
          {error && <p className="xs-status xs-error">{error}</p>}
          {!loading && !error && body.trim().length === 0 && (
            <p className="xs-status">Transcript is empty.</p>
          )}
          {!loading && !error && body.trim().length > 0 && (
            <article className="xs-prose">
              {tokens.map((part, i) => {
                if (part.kind === 'gap') {
                  // Preserve newlines as paragraph breaks by inserting
                  // <br> for each '\n'. The transcript file already
                  // contains line breaks from whisper segmentation.
                  return <GapSpan key={i} text={part.value} />;
                }
                const isHighlighted = highlights.has(part.value.toLowerCase());
                return (
                  <span
                    key={i}
                    className={
                      'xs-token'
                      + (isHighlighted ? ' xs-token-hl' : '')
                    }
                    onClick={(ev) => onTokenClick(part.value, ev)}
                    title={isHighlighted ? '已在詞庫中 — 重跑後會自動修正' : 'Click to correct'}
                  >
                    {part.value}
                  </span>
                );
              })}
            </article>
          )}
        </div>

        <footer className="xs-foot">
          {transcriptFile && (
            <button className="pp-btn" onClick={openExternally}>
              Open externally
            </button>
          )}
          {audioFile && (
            <button
              className="pp-btn pp-btn-strong"
              onClick={reprocess}
              disabled={reprocessing}
              title="Re-run whisper + claude with the current glossary"
            >
              {reprocessing ? 'Starting…' : '重跑 with glossary'}
            </button>
          )}
        </footer>
      </aside>

      {popover && popoverStyle && (
        <div
          className="xs-pop"
          style={popoverStyle}
          // Clicks inside the popover shouldn't bubble to the scrim and
          // close the sheet.
          onClick={(e) => e.stopPropagation()}
        >
          <div className="xs-pop-label">
            把「<strong>{popover.token}</strong>」改成…
          </div>
          <input
            className="xs-pop-input"
            type="text"
            autoFocus
            placeholder="輸入正確的寫法"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void saveCorrection();
              if (e.key === 'Escape') dismissPopover();
            }}
          />
          <div className="xs-pop-scope">
            <label>
              <input
                type="radio"
                checked={globalScope}
                onChange={() => setGlobalScope(true)}
              />
              加入全域詞庫
            </label>
            <label>
              <input
                type="radio"
                checked={!globalScope}
                onChange={() => setGlobalScope(false)}
              />
              只套用在這場
            </label>
          </div>
          <div className="xs-pop-actions">
            <button className="pp-btn" onClick={dismissPopover}>取消</button>
            <button
              className="pp-btn pp-btn-strong"
              onClick={() => void saveCorrection()}
              disabled={saving || !draft.trim()}
            >
              {saving ? '存…' : '儲存'}
            </button>
          </div>
        </div>
      )}
    </>
  );
}

// Render a non-token gap, preserving newlines as <br>. Whitespace
// otherwise stays as text content so the layout looks identical to
// reading the raw file.
function GapSpan({ text }: { text: string }) {
  if (!text.includes('\n')) {
    return <span className="xs-gap">{text}</span>;
  }
  const parts = text.split('\n');
  return (
    <>
      {parts.map((p, i) => (
        <span key={i} className="xs-gap">
          {p}
          {i < parts.length - 1 && <br />}
        </span>
      ))}
    </>
  );
}

function popoverStyleFor(anchor: DOMRect): React.CSSProperties {
  const POP_WIDTH = 280;
  const POP_HEIGHT_GUESS = 180;
  const viewportW = window.innerWidth;
  const viewportH = window.innerHeight;
  let left = anchor.left + anchor.width / 2 - POP_WIDTH / 2;
  left = Math.max(8, Math.min(viewportW - POP_WIDTH - 8, left));
  let top = anchor.bottom + 6;
  if (top + POP_HEIGHT_GUESS > viewportH) {
    top = Math.max(8, anchor.top - POP_HEIGHT_GUESS - 6);
  }
  return {
    position: 'fixed',
    left,
    top,
    width: POP_WIDTH,
    zIndex: 900,
  };
}

// Cheap heuristic. Used when adding a fresh entry from inline
// correction; the user can always reclassify in Settings → Recording.
function guessCategoryFor(canonical: string, _alias: string): GlossaryEntry['category'] {
  // Capitalised single token → likely a person; two-word capitalised →
  // also person. Everything else falls into 'other' until the user
  // says otherwise.
  if (/^[A-Z][a-zA-Z]+(\s[A-Z][a-zA-Z]+)?$/.test(canonical)) return 'person';
  if (/^[A-Z][A-Z0-9]+$/.test(canonical)) return 'term';   // ACRONYM
  return 'other';
}
