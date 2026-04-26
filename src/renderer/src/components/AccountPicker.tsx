import type { AccountSummary } from '@shared/types';
import { avatarBg, initials } from './MacTitleBar';

interface Props {
  open: boolean;
  accounts: AccountSummary[];
  active: Record<string, boolean>;
  onClose: () => void;
  onToggle: (id: string) => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
}

export function AccountPicker({
  open, accounts, active, onClose, onToggle, onAdd, onRemove,
}: Props) {
  if (!open) return null;
  return (
    <>
      <div
        className="popover-backdrop"
        onClick={onClose}
        style={{ background: 'transparent' }}
      />
      <div className="acct-picker">
        <h4>Google Accounts</h4>
        {accounts.length === 0 && (
          <div style={{
            padding: '14px',
            fontFamily: 'var(--serif-body)',
            fontStyle: 'italic',
            fontSize: 12.5,
            color: 'var(--ink-mute)',
          }}>
            No accounts yet — add one below.
          </div>
        )}
        {accounts.map((a) => (
          <div key={a.id} className="acct-li">
            <span className="av" style={{ background: avatarBg(a.id) }}>
              {initials(a)}
            </span>
            <div className="info">
              <div className="lab">{a.name ?? a.email.split('@')[0]}</div>
              <div className="em">{a.email}</div>
            </div>
            <button
              className={'toggle ' + (active[a.id] ? 'on' : '')}
              onClick={() => onToggle(a.id)}
            >
              {active[a.id] ? 'On' : 'Off'}
            </button>
            <button
              className="toggle"
              onClick={() => {
                if (confirm(`Sign out ${a.email}?`)) onRemove(a.id);
              }}
              title="Sign out"
              style={{ marginLeft: 4 }}
            >
              ✕
            </button>
          </div>
        ))}
        <div className="add-row" onClick={onAdd}>
          <span className="plus">+</span>
          <span>Sign in with another Google account…</span>
        </div>
      </div>
    </>
  );
}
