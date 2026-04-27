interface Props {
  label: string;
  on: boolean;
  onChange: () => void;
  subtitle?: string;
  disabled?: boolean;
}

// Editorial pill switch — hairline track, ink-filled knob, italic subtitle.
export function ToggleSwitch({ label, on, onChange, subtitle, disabled }: Props) {
  const cls = ['toggle-row'];
  if (on) cls.push('on');
  if (disabled) cls.push('disabled');
  return (
    <button
      className={cls.join(' ')}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        if (!disabled) onChange();
      }}
    >
      <span className="toggle-text">
        <span className="toggle-label">{label}</span>
        {subtitle && <span className="toggle-sub">{subtitle}</span>}
      </span>
      <span className="toggle-track" aria-hidden="true">
        <span className="toggle-knob" />
      </span>
    </button>
  );
}
