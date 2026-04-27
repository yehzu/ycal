import { Fragment, useEffect, useState } from 'react';
import type {
  AccountSummary, CalendarSummary, MergeCriteria, TempUnits, UpdateStatus,
} from '@shared/types';
import { calKey } from '../store';
import { type CalRole, type CalRoles, ROLE_OPTIONS } from '../calRoles';
import { avatarBg, initials } from './MacTitleBar';

type TabId = 'general' | 'weather' | 'accounts' | 'shortcuts' | 'updates';

interface Props {
  onClose: () => void;
  // General
  showWeekNums: boolean;
  setShowWeekNums: (v: boolean) => void;
  mergeCriteria: MergeCriteria;
  setMergeCriteria: (next: MergeCriteria) => void;
  // Weather
  showWeather: boolean;
  setShowWeather: (v: boolean) => void;
  units: TempUnits;
  setUnits: (u: TempUnits) => void;
  weatherUrl: string | null;
  setWeatherUrl: (url: string | null) => Promise<void>;
  weatherError: string | null;
  // Accounts
  accounts: AccountSummary[];
  accountsActive: Record<string, boolean>;
  toggleAccount: (id: string) => void;
  calendars: CalendarSummary[];
  calVisible: Record<string, boolean>;
  toggleCal: (key: string) => void;
  calRoles: CalRoles;
  setCalRole: (key: string, role: CalRole) => void;
  onAddAccount: () => void;
  onRemoveAccount: (id: string) => Promise<void> | void;
}

const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'general', label: 'General' },
  { id: 'weather', label: 'Weather' },
  { id: 'accounts', label: 'Accounts' },
  { id: 'shortcuts', label: 'Shortcuts' },
  { id: 'updates', label: 'Updates' },
];

const TAB_TITLES: Record<TabId, string> = {
  general: 'General',
  weather: 'Weather',
  accounts: 'Accounts',
  shortcuts: 'Shortcuts',
  updates: 'Updates',
};

export function SettingsModal(props: Props) {
  const [tab, setTab] = useState<TabId>('general');

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  return (
    <div
      className="prefs-backdrop"
      onClick={props.onClose}
      role="presentation"
    >
      <div
        className="prefs-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
      >
        <div className="prefs-titlebar">
          <div className="prefs-traffic">
            <span
              className="t-l close"
              onClick={props.onClose}
              title="Close"
              role="button"
              aria-label="Close settings"
            />
            <span className="t-l min" />
            <span className="t-l max" />
          </div>
          <div className="prefs-title">Settings</div>
        </div>
        <div className="prefs-body">
          <nav className="prefs-tabs" aria-label="Settings categories">
            {TABS.map((t) => (
              <button
                key={t.id}
                className={'prefs-tab' + (tab === t.id ? ' active' : '')}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </nav>
          <div className="prefs-pane">
            <header className="prefs-pagehead">
              <div className="prefs-eyebrow">{TAB_TITLES[tab]}</div>
              <h2 className="prefs-display">
                <em>yCal</em> Settings
              </h2>
            </header>
            {tab === 'general' && (
              <PrefsGeneral
                showWeekNums={props.showWeekNums}
                setShowWeekNums={props.setShowWeekNums}
                mergeCriteria={props.mergeCriteria}
                setMergeCriteria={props.setMergeCriteria}
              />
            )}
            {tab === 'weather' && (
              <PrefsWeather
                showWeather={props.showWeather}
                setShowWeather={props.setShowWeather}
                units={props.units}
                setUnits={props.setUnits}
                weatherUrl={props.weatherUrl}
                setWeatherUrl={props.setWeatherUrl}
                weatherError={props.weatherError}
              />
            )}
            {tab === 'accounts' && (
              <PrefsAccounts
                accounts={props.accounts}
                accountsActive={props.accountsActive}
                toggleAccount={props.toggleAccount}
                calendars={props.calendars}
                calVisible={props.calVisible}
                toggleCal={props.toggleCal}
                calRoles={props.calRoles}
                setCalRole={props.setCalRole}
                onAddAccount={props.onAddAccount}
                onRemoveAccount={props.onRemoveAccount}
              />
            )}
            {tab === 'shortcuts' && <PrefsShortcuts />}
            {tab === 'updates' && <PrefsUpdates />}
          </div>
        </div>
      </div>
    </div>
  );
}

function PrefRow({
  label, hint, children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="pref-row">
      <div className="pref-row-label">
        <div className="pref-row-name">{label}</div>
        {hint && <div className="pref-row-hint">{hint}</div>}
      </div>
      <div className="pref-row-control">{children}</div>
    </div>
  );
}

function PrefSegmented<T extends string | number>({
  value, options, onChange,
}: {
  value: T;
  options: Array<T | { value: T; label: string }>;
  onChange: (v: T) => void;
}) {
  return (
    <div className="pref-seg" role="radiogroup">
      {options.map((opt) => {
        const v = typeof opt === 'object' ? opt.value : opt;
        const lbl = typeof opt === 'object' ? opt.label : String(opt);
        return (
          <button
            key={String(v)}
            role="radio"
            aria-checked={value === v}
            className={'pref-seg-btn' + (value === v ? ' active' : '')}
            onClick={() => onChange(v)}
          >
            {lbl}
          </button>
        );
      })}
    </div>
  );
}

function PrefSwitch({
  value, onChange,
}: {
  value: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      className={'pref-switch' + (value ? ' on' : '')}
      onClick={() => onChange(!value)}
    >
      <span className="pref-switch-thumb" />
    </button>
  );
}

function PrefsGeneral({
  showWeekNums, setShowWeekNums, mergeCriteria, setMergeCriteria,
}: {
  showWeekNums: boolean;
  setShowWeekNums: (v: boolean) => void;
  mergeCriteria: MergeCriteria;
  setMergeCriteria: (m: MergeCriteria) => void;
}) {
  return (
    <div className="pref-section">
      <h3 className="pref-h">Layout</h3>
      <PrefRow
        label="Show week numbers"
        hint="ISO week numbers in the month grid, mini-month, and week / day-view corner."
      >
        <PrefSwitch value={showWeekNums} onChange={setShowWeekNums} />
      </PrefRow>

      <h3 className="pref-h">Cross-calendar merge</h3>
      <p
        className="pref-row-hint"
        style={{ marginTop: 0, maxWidth: '60ch' }}
      >
        Events with the same title and start moment collapse into one row with an
        ×N badge. Tighten the criteria below if unrelated entries get merged.
      </p>
      <PrefRow
        label="Also match end time"
        hint="Require the end of the slot to line up too."
      >
        <PrefSwitch
          value={mergeCriteria.matchEnd}
          onChange={(v) => setMergeCriteria({ ...mergeCriteria, matchEnd: v })}
        />
      </PrefRow>
      <PrefRow
        label="Also match all-day flag"
        hint="Don't merge a timed event with an all-day one of the same name."
      >
        <PrefSwitch
          value={mergeCriteria.matchAllDay}
          onChange={(v) => setMergeCriteria({ ...mergeCriteria, matchAllDay: v })}
        />
      </PrefRow>
    </div>
  );
}

function PrefsWeather({
  showWeather, setShowWeather, units, setUnits,
  weatherUrl, setWeatherUrl, weatherError,
}: {
  showWeather: boolean;
  setShowWeather: (v: boolean) => void;
  units: TempUnits;
  setUnits: (u: TempUnits) => void;
  weatherUrl: string | null;
  setWeatherUrl: (url: string | null) => Promise<void>;
  weatherError: string | null;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(weatherUrl ?? '');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(weatherUrl ?? '');
  }, [weatherUrl, editing]);

  const valid = !draft || /^(https?:|webcal:)\/\//i.test(draft.trim());

  const save = async () => {
    if (!valid) return;
    setSaving(true);
    setSaveError(null);
    try {
      await setWeatherUrl(draft.trim() || null);
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
      await setWeatherUrl(null);
      setDraft('');
      setEditing(false);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  // Truncate the displayed URL — keeps host visible, hides any per-user
  // hash in the path.
  const displayUrl = (u: string) => {
    try {
      const url = new URL(u.replace(/^webcal:/i, 'https:'));
      const tail = url.pathname.length > 1
        ? url.pathname.replace(/\/[^/]+\.ics$/, '/…')
        : '';
      return (u.startsWith('webcal:') ? 'webcal://' : url.protocol + '//')
        + url.host + tail;
    } catch {
      return u;
    }
  };

  return (
    <div className="pref-section">
      <h3 className="pref-h">Weather in calendar</h3>
      <PrefRow
        label="Show weather in views"
        hint="Glyph + hi/lo on each date in month, week, and day views."
      >
        <PrefSwitch value={showWeather} onChange={setShowWeather} />
      </PrefRow>
      <PrefRow label="Temperature units">
        <PrefSegmented<TempUnits>
          value={units}
          options={[{ value: 'F', label: '°F' }, { value: 'C', label: '°C' }]}
          onChange={setUnits}
        />
      </PrefRow>

      <h3 className="pref-h">Forecast feed</h3>
      <PrefRow
        label="Source"
        hint="Generate at weather-in-calendar.com, then paste the URL (https:// or webcal://)."
      >
        {!editing ? (
          <div className="pref-feed-display">
            {weatherUrl ? (
              <span className="pref-feed-url" title={weatherUrl}>
                {displayUrl(weatherUrl)}
              </span>
            ) : (
              <span className="pref-feed-empty">Not configured</span>
            )}
            <button className="pref-btn" onClick={() => setEditing(true)}>
              {weatherUrl ? 'Change…' : 'Add…'}
            </button>
          </div>
        ) : (
          <div className="pref-feed-edit">
            <input
              // Type "text" so webcal:// passes — HTML5 url validation rejects
              // it even though the scheme is registered.
              type="text"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              className={'pref-feed-input' + (!valid ? ' invalid' : '')}
              placeholder="https:// or webcal://weather-in-calendar.com/…"
              value={draft}
              autoFocus
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void save();
                if (e.key === 'Escape') setEditing(false);
              }}
            />
            <div className="pref-feed-actions">
              {weatherUrl && (
                <button
                  className="pref-btn pref-btn-danger"
                  onClick={() => void clear()}
                  disabled={saving}
                >
                  Clear
                </button>
              )}
              <button
                className="pref-btn"
                onClick={() => setEditing(false)}
                disabled={saving}
              >
                Cancel
              </button>
              <button
                className="pref-btn pref-btn-primary"
                disabled={!valid || saving}
                onClick={() => void save()}
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
            {!valid && (
              <div className="pref-feed-error">
                Must start with https:// or webcal://
              </div>
            )}
            {saveError && (
              <div className="pref-feed-error">{saveError}</div>
            )}
          </div>
        )}
      </PrefRow>

      {weatherError && !editing && (
        <div className="pref-feed-error" style={{ marginTop: 4 }}>
          Last fetch failed: {weatherError}
        </div>
      )}

      <div className="pref-note">
        Generate a personalised feed at{' '}
        <span className="pref-feed-link">weather-in-calendar.com</span>, then
        paste the URL above. yCal refreshes the feed every 30 minutes while
        the app is running.
      </div>
    </div>
  );
}

function PrefsAccounts({
  accounts, accountsActive, toggleAccount,
  calendars, calVisible, toggleCal,
  calRoles, setCalRole,
  onAddAccount, onRemoveAccount,
}: {
  accounts: AccountSummary[];
  accountsActive: Record<string, boolean>;
  toggleAccount: (id: string) => void;
  calendars: CalendarSummary[];
  calVisible: Record<string, boolean>;
  toggleCal: (key: string) => void;
  calRoles: CalRoles;
  setCalRole: (key: string, role: CalRole) => void;
  onAddAccount: () => void;
  onRemoveAccount: (id: string) => Promise<void> | void;
}) {
  return (
    <div className="pref-section">
      <h3 className="pref-h">Connected accounts</h3>
      {accounts.length === 0 && (
        <div className="pref-row-hint" style={{ margin: '4px 0 0' }}>
          No accounts yet. Add one to load your calendars.
        </div>
      )}
      <div className="pref-acct-list">
        {accounts.map((a) => {
          const cals = calendars.filter((c) => c.accountId === a.id);
          return (
            <div key={a.id} className="pref-acct">
              <div className="pref-acct-head">
                <div className="pref-acct-id">
                  <div
                    className="pref-acct-badge"
                    style={{ background: avatarBg(a.id) }}
                  >
                    {initials(a)}
                  </div>
                  <div>
                    <div className="pref-acct-name">{a.name ?? a.email}</div>
                    <div className="pref-acct-email">{a.email}</div>
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <button
                    className="pref-btn pref-btn-danger"
                    onClick={() => void onRemoveAccount(a.id)}
                    title="Sign out and remove this account"
                  >
                    Remove
                  </button>
                  <PrefSwitch
                    value={!!accountsActive[a.id]}
                    onChange={() => toggleAccount(a.id)}
                  />
                </div>
              </div>
              <div className="pref-cal-list">
                {cals.map((c) => {
                  const k = calKey(c.accountId, c.id);
                  const role = calRoles[k] ?? 'normal';
                  const on = !!calVisible[k];
                  return (
                    <div key={k} className={'pref-cal' + (on ? '' : ' off')}>
                      <label className="pref-cal-line">
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={() => toggleCal(k)}
                        />
                        <span
                          className="pref-cal-swatch"
                          style={{ background: c.color }}
                        />
                        <span className="pref-cal-name">{c.name}</span>
                      </label>
                      <select
                        className="pref-cal-role"
                        value={role}
                        onChange={(e) => setCalRole(k, e.target.value as CalRole)}
                      >
                        {ROLE_OPTIONS.map(([roleKey, label]) => (
                          <option key={roleKey} value={roleKey}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      <div className="pref-actions">
        <button className="pref-btn" onClick={onAddAccount}>
          + Add account…
        </button>
      </div>
    </div>
  );
}

function PrefsShortcuts() {
  const isMac = typeof navigator !== 'undefined'
    && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent || '');
  const cmd = isMac ? '⌘' : 'Ctrl';

  const SECTIONS: Array<{
    id: string;
    title: string;
    rows: Array<{ keys: Array<string | string[]>; desc: string }>;
  }> = [
    {
      id: 'navigate',
      title: 'Navigate',
      rows: [
        { keys: [['←'], 'or', ['→']], desc: 'Previous / next page (month, week, or day)' },
        { keys: [['H']], desc: 'Move selection one day backward' },
        { keys: [['L']], desc: 'Move selection one day forward' },
        { keys: [['K']], desc: 'Move selection one week backward' },
        { keys: [['J']], desc: 'Move selection one week forward' },
        { keys: [['T'], 'or', ['Space']], desc: 'Jump to today' },
      ],
    },
    {
      id: 'switch-view',
      title: 'Switch view',
      rows: [
        { keys: [['S']], desc: 'Month view' },
        { keys: [['D']], desc: 'Week view' },
        { keys: [['F']], desc: 'Day view' },
      ],
    },
    {
      id: 'filters',
      title: 'Filters',
      rows: [
        { keys: [['W']], desc: 'Toggle Show read-only calendars' },
      ],
    },
    {
      id: 'app',
      title: 'App',
      rows: [
        { keys: [[cmd, ',']], desc: 'Open this Settings page' },
        { keys: [['Esc']], desc: 'Close popover, modal, or this page' },
      ],
    },
  ];

  return (
    <div className="pref-section">
      <div className="pref-row-hint pref-shortcuts-intro">
        Shortcuts are active whenever the calendar window has focus and you
        aren&apos;t typing into a text field.
      </div>
      {SECTIONS.map((sec) => (
        <div key={sec.id} className="pref-shortcut-group">
          <h3 className="pref-h">{sec.title}</h3>
          <dl className="pref-shortcut-list">
            {sec.rows.map((row, i) => (
              <div key={i} className="pref-shortcut-row">
                <dt className="pref-shortcut-keys">
                  {row.keys.map((k, j) => (
                    typeof k === 'string'
                      ? <span key={j} className="pref-shortcut-or">{k}</span>
                      : (
                        <kbd
                          key={j}
                          className={'pref-kbd' + (k.length > 1 ? ' pref-kbd-combo' : '')}
                        >
                          {k.map((part, p) => (
                            <Fragment key={p}>
                              {p > 0 && <span className="pref-kbd-plus">+</span>}
                              <span className="pref-kbd-part">{part}</span>
                            </Fragment>
                          ))}
                        </kbd>
                      )
                  ))}
                </dt>
                <dd className="pref-shortcut-desc">{row.desc}</dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
    </div>
  );
}

function PrefsUpdates() {
  const [status, setStatus] = useState<UpdateStatus>({ state: 'idle', version: null });
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    const off = window.ycal.onUpdateStatus(setStatus);
    return off;
  }, []);

  const check = async () => {
    setChecking(true);
    try {
      const next = await window.ycal.checkForUpdates();
      setStatus(next);
    } finally {
      setChecking(false);
    }
  };

  const install = () => {
    void window.ycal.installUpdate();
  };

  // The updater pushes a `version` only when an update is found; current
  // installed version is stamped in at build time.
  const currentVersion = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : null;

  let stateMsg: { text: string; error: boolean } | null = null;
  if (status.state === 'checking' || checking) {
    stateMsg = { text: 'Checking for updates…', error: false };
  } else if (status.state === 'available' && status.version) {
    stateMsg = {
      text: `yCal ${status.version} is available.`,
      error: false,
    };
  } else if (status.state === 'installing') {
    stateMsg = { text: 'Installing — yCal will relaunch shortly.', error: false };
  } else if (status.state === 'error' && status.error) {
    stateMsg = { text: status.error, error: true };
  } else if (status.state === 'idle' && currentVersion) {
    stateMsg = { text: 'You’re up to date.', error: false };
  }

  return (
    <div className="pref-section">
      <h3 className="pref-h">Software updates</h3>
      <div className="pref-version-card">
        <div className="pref-version-row">
          <div>
            <div className="pref-version-label">Current version</div>
            <div className="pref-version-num">
              yCal {currentVersion ?? '—'}
            </div>
          </div>
          {status.state === 'available' ? (
            <button
              className="pref-btn pref-btn-primary"
              onClick={install}
            >
              Install &amp; restart
            </button>
          ) : (
            <button
              className="pref-btn pref-btn-primary"
              onClick={() => void check()}
              disabled={checking || status.state === 'checking'}
            >
              {checking || status.state === 'checking' ? 'Checking…' : 'Check for updates'}
            </button>
          )}
        </div>
        {stateMsg && (
          <div className={'pref-version-msg' + (stateMsg.error ? ' error' : '')}>
            {stateMsg.text}
          </div>
        )}
      </div>
      <div className="pref-note">
        yCal checks GitHub releases on launch, every 30 minutes, and whenever
        you bring the window back into focus — so a new release usually shows
        up within seconds of you returning to the app. Skipping a version with
        the toast suppresses it for that release only.
      </div>
    </div>
  );
}
