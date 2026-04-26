import { DOW_LONG, MONTH_NAMES, ordinal } from '../dates';
import type { AccountSummary } from '@shared/types';

interface Props {
  today: Date;
  accounts: AccountSummary[];
  accountsActive: Record<string, boolean>;
  onPickerOpen: () => void;
}

function avatarBg(id: string): string {
  // Deterministic color per account id, drawn from Google's calendar palette.
  const palette = ['#0b8043', '#3f51b5', '#d50000', '#7986cb', '#f4511e', '#039be5', '#8e24aa'];
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return palette[h % palette.length];
}

function initials(a: AccountSummary): string {
  const src = (a.name ?? a.email).trim();
  const parts = src.split(/[\s@.]+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

export function MacTitleBar({ today, accounts, accountsActive, onPickerOpen }: Props) {
  const dayName = DOW_LONG[today.getDay()];
  const active = accounts.filter((a) => accountsActive[a.id]);
  return (
    <div className="mac-titlebar" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>
      <div />
      <div className="mac-title">
        yCal
        <span className="mac-title-meta">
          {dayName}, {MONTH_NAMES[today.getMonth()]} {ordinal(today.getDate())}
        </span>
      </div>
      <div className="mac-tb-r" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <div className="acct-stack" onClick={onPickerOpen} role="button" aria-label="Accounts">
          {active.map((a) => (
            <span
              key={a.id}
              className="acct-avatar"
              style={{ background: avatarBg(a.id) }}
              title={a.email}
            >
              {initials(a)}
            </span>
          ))}
          <span
            className="acct-avatar add-acct"
            title={accounts.length === 0 ? 'Sign in with Google' : 'Add Google account'}
          >
            +
          </span>
        </div>
      </div>
    </div>
  );
}

export { avatarBg, initials };
