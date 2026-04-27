import { useEffect, useRef, useState } from 'react';
import type { CalendarSummary } from '@shared/types';
import { calKey } from '../store';
import type { CalRoles } from '../calRoles';
import { ToggleSwitch } from './ToggleSwitch';

interface Props {
  hideReadOnly: boolean;
  setHideReadOnly: (v: boolean) => void;
  hideDisabledCals: boolean;
  setHideDisabledCals: (v: boolean) => void;
  accountsActive: Record<string, boolean>;
  calendars: CalendarSummary[];
  calVisible: Record<string, boolean>;
  calRoles: CalRoles;
}

// Calendars-section overflow menu — small ⋯ button in the section header.
// Houses the two list-display switches.
export function CalListPrefsMenu({
  hideReadOnly,
  setHideReadOnly,
  hideDisabledCals,
  setHideDisabledCals,
  accountsActive,
  calendars,
  calVisible,
  calRoles,
}: Props) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const btnRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener('click', close);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  const handleOpen = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setPos({ top: r.bottom + 4, left: Math.max(8, r.left - 8) });
    }
    setOpen((o) => !o);
  };

  const readOnlyCount = calendars.filter((c) => {
    const role = calRoles[calKey(c.accountId, c.id)] ?? 'normal';
    return role === 'subscribed' && accountsActive[c.accountId];
  }).length;
  const disabledCount = calendars.filter(
    (c) =>
      accountsActive[c.accountId] && !calVisible[calKey(c.accountId, c.id)],
  ).length;
  const dirty = hideReadOnly || hideDisabledCals;

  return (
    <span className="sec-prefs">
      <button
        ref={btnRef}
        className={'sec-prefs-btn' + (dirty ? ' dirty' : '')}
        title="Display preferences"
        onClick={handleOpen}
      >
        ⋯
      </button>
      {open && (
        <div
          className="sec-prefs-menu"
          style={{ top: pos.top, left: pos.left }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="sec-prefs-h">Display</div>
          <ToggleSwitch
            label="Show read-only"
            on={!hideReadOnly}
            onChange={() => setHideReadOnly(!hideReadOnly)}
            subtitle={
              readOnlyCount === 0
                ? 'no read-only calendars'
                : hideReadOnly
                ? `${readOnlyCount} hidden`
                : `${readOnlyCount} shown`
            }
          />
          <ToggleSwitch
            label="Hide disabled"
            on={hideDisabledCals}
            onChange={() => setHideDisabledCals(!hideDisabledCals)}
            subtitle={
              disabledCount === 0 ? 'all calendars on' : `${disabledCount} disabled`
            }
            disabled={disabledCount === 0 && !hideDisabledCals}
          />
        </div>
      )}
    </span>
  );
}
