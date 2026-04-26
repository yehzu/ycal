import { useState } from 'react';
import type { WeatherDay } from '@shared/types';
import { DOW_NARROW, addDays, fmtDate } from '../dates';

interface Props {
  start: Date;
  url: string | null;
  days: WeatherDay[];
  error: string | null;
  onSetUrl: (url: string | null) => Promise<void>;
}

export function WeatherStrip({ start, url, days, error, onSetUrl }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(url ?? '');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const beginEdit = () => {
    setDraft(url ?? '');
    setSaveError(null);
    setEditing(true);
  };

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await onSetUrl(draft.trim() || null);
      setEditing(false);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const clear = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await onSetUrl(null);
      setDraft('');
      setEditing(false);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <input
          // Type "text" (not "url") because webcal:// fails HTML5 url validation
          // even though it's a registered scheme — and weather-in-calendar.com
          // emits webcal:// URLs by default.
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="https:// or webcal://weather-in-calendar.com/…"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          style={{
            width: '100%',
            padding: '5px 7px',
            border: '0.5px solid var(--rule)',
            background: 'var(--paper)',
            fontFamily: 'var(--mono)',
            fontSize: 10,
            color: 'var(--ink)',
            outline: 'none',
          }}
          autoFocus
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save();
            if (e.key === 'Escape') setEditing(false);
          }}
        />
        <div style={{
          fontFamily: 'var(--serif-body)',
          fontStyle: 'italic',
          fontSize: 10.5,
          color: 'var(--ink-mute)',
          lineHeight: 1.4,
        }}>
          Generate at{' '}
          <span style={{ fontFamily: 'var(--mono)', fontStyle: 'normal' }}>
            weather-in-calendar.com
          </span>
          , then paste the URL (https:// or webcal://).
        </div>
        {saveError && (
          <div style={{
            fontFamily: 'var(--serif-body)',
            fontSize: 11,
            color: '#d50000',
            fontStyle: 'italic',
            wordBreak: 'break-word',
          }}>
            {saveError}
          </div>
        )}
        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
          {url && (
            <button
              onClick={clear}
              disabled={saving}
              style={ctlBtn}
            >
              Clear
            </button>
          )}
          <button onClick={() => setEditing(false)} style={ctlBtn} disabled={saving}>
            Cancel
          </button>
          <button onClick={save} style={{ ...ctlBtn, ...primaryBtn }} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    );
  }

  if (!url) {
    return (
      <div style={{
        fontFamily: 'var(--serif-body)',
        fontStyle: 'italic',
        fontSize: 12,
        color: 'var(--ink-mute)',
        padding: '4px 0',
      }}>
        <button onClick={beginEdit} style={linkBtn}>
          Set up weather forecast →
        </button>
      </div>
    );
  }

  if (error) {
    return (
      <div>
        <div
          style={{
            fontFamily: 'var(--serif-body)',
            fontSize: 11,
            color: '#d50000',
            fontStyle: 'italic',
            lineHeight: 1.45,
            wordBreak: 'break-word',
          }}
        >
          Weather feed failed: {error}
        </div>
        <div style={{ marginTop: 4, display: 'flex', justifyContent: 'flex-end' }}>
          <button onClick={beginEdit} style={linkBtn}>✎ change URL</button>
        </div>
      </div>
    );
  }

  if (days.length === 0) {
    return (
      <div>
        <div
          style={{
            fontFamily: 'var(--serif-body)',
            fontStyle: 'italic',
            fontSize: 11,
            color: 'var(--ink-mute)',
          }}
        >
          Loading forecast…
        </div>
        <div style={{ marginTop: 4, display: 'flex', justifyContent: 'flex-end' }}>
          <button onClick={beginEdit} style={linkBtn}>✎ change URL</button>
        </div>
      </div>
    );
  }

  // Render 7 days starting from `start`. If we have no day for a date, show '·'.
  const byDate = new Map<string, WeatherDay>();
  for (const d of days) byDate.set(d.date, d);

  const cells = Array.from({ length: 7 }, (_, i) => addDays(start, i));

  return (
    <div>
      <div className="weather-strip">
        {cells.map((d) => {
          const w = byDate.get(fmtDate(d));
          return (
            <div
              key={fmtDate(d)}
              className="weather-cell"
              title={w ? w.summary : undefined}
            >
              <div className="dow">{DOW_NARROW[d.getDay()]}</div>
              <div className="gl">{w?.glyph ?? '·'}</div>
              <div className="hi">{w?.hi != null ? `${w.hi}°` : '—'}</div>
              <div className="lo">{w?.lo != null ? `${w.lo}°` : ''}</div>
            </div>
          );
        })}
      </div>
      <div style={{
        marginTop: 4,
        display: 'flex',
        justifyContent: 'flex-end',
      }}>
        <button onClick={beginEdit} style={linkBtn} title="Change location / URL">
          ✎ change
        </button>
      </div>
    </div>
  );
}

const ctlBtn: React.CSSProperties = {
  appearance: 'none',
  background: 'var(--paper)',
  border: '0.5px solid var(--rule)',
  color: 'var(--ink)',
  padding: '3px 9px',
  fontFamily: 'var(--serif-body)',
  fontSize: 10.5,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  cursor: 'pointer',
};

const primaryBtn: React.CSSProperties = {
  background: 'var(--ink)',
  color: 'var(--paper)',
};

const linkBtn: React.CSSProperties = {
  appearance: 'none',
  background: 'transparent',
  border: 0,
  color: 'var(--ink-mute)',
  padding: 0,
  fontFamily: 'var(--serif-body)',
  fontStyle: 'italic',
  fontSize: 11,
  textDecoration: 'underline',
  cursor: 'pointer',
};
