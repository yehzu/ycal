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

  if (state === 'available' || state === 'ready') {
    if (version && dismissedVersion === version) return null;
    const prefetchPct = state === 'ready' ? 100 : (progress ?? 0);
    const eyebrow = state === 'ready' ? 'Update ready' : 'Update available';
    const sub = state === 'ready'
      ? 'Downloaded — installing will be quick. yCal closes and relaunches automatically.'
      : prefetchPct > 0 && prefetchPct < 100
        ? `Downloading in the background… ${prefetchPct}%`
        : 'Downloading in the background — install when you’re ready.';
    return (
      <div className="update-toast" role="dialog" aria-label={eyebrow}>
        <div className="update-toast-body">
          <div className="update-toast-eyebrow">{eyebrow}</div>
          <div className="update-toast-ttl">yCal {version ?? ''}</div>
          <div className="update-toast-sub">{sub}</div>
        </div>
        <div className="update-toast-actions">
          <button className="u-btn u-btn-ghost" onClick={dismiss}>Later</button>
          <button className="u-btn u-btn-primary" onClick={install}>Install &amp; restart</button>
        </div>
      </div>
    );
  }

  // state === 'installing' — full-bleed splash. Stays up until the app dies.
  const splashPct = progress ?? 0;
  const subtitle = splashPct >= 100
    ? `Closing app and installing ${version ?? ''}.`
    : splashPct >= 90
      ? `Installing ${version ?? ''}…`
      : `Downloading ${version ?? ''}… ${splashPct}%`;
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
