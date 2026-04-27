import { useEffect, useState } from 'react';
import type { UpdateStatus } from '@shared/types';

const DISMISSED_KEY = 'ycal:update-dismissed-version';

// Single-click flow: toast → click "Install & restart" → splash takes over
// and stays up until the app quits. No manual relaunch step.
export function UpdateOverlay(): JSX.Element | null {
  const [status, setStatus] = useState<UpdateStatus>({ state: 'idle', version: null });
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(() =>
    localStorage.getItem(DISMISSED_KEY),
  );

  useEffect(() => {
    const off = window.ycal.onUpdateStatus(setStatus);
    return off;
  }, []);

  const dismiss = (): void => {
    if (status.version) {
      localStorage.setItem(DISMISSED_KEY, status.version);
      setDismissedVersion(status.version);
    }
  };

  const install = (): void => {
    void window.ycal.installUpdate();
  };

  const { state, version, progress, error } = status;

  if (state === 'idle' || state === 'checking') return null;

  if (state === 'error') {
    // Show only when something fails after the user opted in to install —
    // background errors stay in the logs.
    return null;
  }

  if (state === 'available') {
    if (version && dismissedVersion === version) return null;
    return (
      <div className="update-toast" role="dialog" aria-label="Update available">
        <div className="update-toast-body">
          <div className="update-toast-eyebrow">Update available</div>
          <div className="update-toast-ttl">yCal {version ?? ''}</div>
          <div className="update-toast-sub">
            A new release is ready. yCal will close and relaunch automatically.
          </div>
        </div>
        <div className="update-toast-actions">
          <button className="u-btn u-btn-ghost" onClick={dismiss}>Later</button>
          <button className="u-btn u-btn-primary" onClick={install}>Install &amp; restart</button>
        </div>
      </div>
    );
  }

  // state === 'installing' — full-bleed splash. Stays up until the app dies.
  const subtitle = (progress ?? 0) >= 100
    ? `Closing app and installing ${version ?? ''}.`
    : `Downloading ${version ?? ''}… ${progress ?? 0}%`;
  return (
    <div className="update-splash" role="dialog" aria-modal="true">
      <div className="update-splash-card">
        <div className="update-splash-logo">y</div>
        <div className="update-splash-ttl">Updating yCal…</div>
        <div className="update-splash-sub">{subtitle}</div>
        <div className="update-splash-bar">
          <div className="update-splash-bar-fill" />
        </div>
        {error && <div className="update-splash-sub" style={{ color: '#b00020' }}>{error}</div>}
      </div>
    </div>
  );
}
