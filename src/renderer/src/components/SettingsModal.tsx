import { useEffect } from 'react';

interface Props {
  onClose: () => void;
}

interface ShortcutRow {
  keys: string[];
  label: string;
}

interface ShortcutSection {
  title: string;
  rows: ShortcutRow[];
}

const SECTIONS: ShortcutSection[] = [
  {
    title: 'Navigate',
    rows: [
      { keys: ['←', '→'], label: 'Previous / next page (month, week, or day)' },
      { keys: ['H', 'L'], label: 'Move selection one day backward / forward' },
      { keys: ['K', 'J'], label: 'Move selection one week backward / forward' },
      { keys: ['T', 'Space'], label: 'Jump to today' },
    ],
  },
  {
    title: 'Switch view',
    rows: [
      { keys: ['S'], label: 'Month' },
      { keys: ['D'], label: 'Week' },
      { keys: ['F'], label: 'Day' },
    ],
  },
  {
    title: 'Filters',
    rows: [
      { keys: ['W'], label: 'Toggle Show read-only calendars' },
    ],
  },
  {
    title: 'App',
    rows: [
      { keys: ['⌘', ','], label: 'Open this Settings page' },
      { keys: ['Esc'], label: 'Close popover, modal, or this page' },
    ],
  },
];

export function SettingsModal({ onClose }: Props) {
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <>
      <div className="popover-backdrop" onClick={onClose} />
      <div className="settings-modal" role="dialog" aria-label="Settings">
        <header className="dem-head">
          <div className="dem-eyebrow">Preferences</div>
          <h2 className="dem-title-h">
            <em>yCal</em> Settings
          </h2>
          <button className="dem-close" onClick={onClose} title="Close (Esc)">×</button>
        </header>
        <div className="dem-body-scroll">
          <section className="dem-section">
            <h3 className="dem-h">Keyboard shortcuts</h3>
            <p className="settings-note">
              Shortcuts are active whenever the calendar window has focus and you
              aren&apos;t typing into a text field.
            </p>
            {SECTIONS.map((s) => (
              <div key={s.title} className="settings-group">
                <div className="settings-group-h">{s.title}</div>
                {s.rows.map((r, i) => (
                  <div key={i} className="settings-row">
                    <span className="settings-keys">
                      {r.keys.map((k, j) => (
                        <span key={j}>
                          {j > 0 && <span className="settings-sep">or</span>}
                          <kbd className="settings-kbd">{k}</kbd>
                        </span>
                      ))}
                    </span>
                    <span className="settings-label">{r.label}</span>
                  </div>
                ))}
              </div>
            ))}
          </section>
        </div>
        <footer className="dem-foot">
          <span className="dem-hint">Esc to close</span>
        </footer>
      </div>
    </>
  );
}
