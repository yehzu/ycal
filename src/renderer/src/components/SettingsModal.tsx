import { Fragment, useEffect, useState } from 'react';
import type {
  AccountSummary, CalendarSummary, CloudStorageInfo, LoadBands, LoadWindowSettings,
  MergeCriteria, RhythmData, TaskProviderInfo, TempUnits, UpdateStatus,
} from '@shared/types';
import { DEFAULT_LOAD_BANDS } from '@shared/types';
import { calKey } from '../store';
import { type CalRole, type CalRoles, ROLE_OPTIONS } from '../calRoles';
import { avatarBg, initials } from './MacTitleBar';
import { fmtDate } from '../dates';
import { formatRhythmTime, resolveDefault } from '../rhythm';

type TabId =
  | 'general' | 'tasks' | 'rhythm' | 'sync'
  | 'weather' | 'accounts' | 'shortcuts' | 'updates';

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
  // Tasks (active provider)
  taskProvider: TaskProviderInfo | null;
  taskProviders: TaskProviderInfo[];
  setActiveTaskProvider: (id: 'todoist' | 'markdown') => Promise<void>;
  setTaskCredentials: (key: string | null) => Promise<void>;
  refreshTasks: () => Promise<void>;
  autoRolloverPastTasks: boolean;
  setAutoRolloverPastTasks: (v: boolean) => void;
  // Day-load gauge window
  loadWindow: LoadWindowSettings;
  setLoadWindow: (next: LoadWindowSettings) => void;
  loadBands: LoadBands;
  setLoadBands: (next: LoadBands) => void;
  // Day rhythm
  rhythmData: RhythmData | null;
  setRhythmDefault: (fromDateStr: string, next: { wakeMin: number; sleepMin: number }) => Promise<void>;
  // Cloud storage (rhythm + tasks schedule)
  cloudStorage: CloudStorageInfo | null;
  setCloudStorage: (pref: 'icloud' | 'local') => Promise<void>;
}

const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'general', label: 'General' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'rhythm', label: 'Day rhythm' },
  { id: 'sync', label: 'Sync' },
  { id: 'weather', label: 'Weather' },
  { id: 'accounts', label: 'Accounts' },
  { id: 'shortcuts', label: 'Shortcuts' },
  { id: 'updates', label: 'Updates' },
];

const TAB_TITLES: Record<TabId, string> = {
  general: 'General',
  tasks: 'Tasks',
  rhythm: 'Day rhythm',
  sync: 'Sync',
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
            {tab === 'tasks' && (
              <PrefsTasks
                provider={props.taskProvider}
                providers={props.taskProviders}
                setActiveProvider={props.setActiveTaskProvider}
                setCredentials={props.setTaskCredentials}
                refresh={props.refreshTasks}
                autoRollover={props.autoRolloverPastTasks}
                setAutoRollover={props.setAutoRolloverPastTasks}
                loadWindow={props.loadWindow}
                setLoadWindow={props.setLoadWindow}
                loadBands={props.loadBands}
                setLoadBands={props.setLoadBands}
              />
            )}
            {tab === 'rhythm' && (
              <PrefsRhythm
                rhythmData={props.rhythmData}
                setDefault={props.setRhythmDefault}
              />
            )}
            {tab === 'sync' && (
              <PrefsSync
                storage={props.cloudStorage}
                setStorage={props.setCloudStorage}
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
        { keys: [['U'], 'or', ['I']], desc: 'Previous / next page (alias for ← / →)' },
        { keys: [['H']], desc: 'Move selection one day backward' },
        { keys: [['L']], desc: 'Move selection one day forward' },
        { keys: [['K']], desc: 'Move selection one week backward' },
        { keys: [['J']], desc: 'Move selection one week forward' },
        { keys: [['T']], desc: 'Jump to today' },
        { keys: [['Mouse Back'], 'or', ['Mouse Forward']], desc: 'Step through view history' },
      ],
    },
    {
      id: 'switch-view',
      title: 'Switch view',
      rows: [
        { keys: [['S']], desc: 'Month view' },
        { keys: [['D']], desc: 'Week view' },
        { keys: [['F']], desc: 'Day view' },
        { keys: [['Space']], desc: 'Open the selected day’s full event list (press again to close)' },
      ],
    },
    {
      id: 'filters',
      title: 'Filters',
      rows: [
        { keys: [['W']], desc: 'Toggle Show read-only calendars' },
        { keys: [['E']], desc: 'Toggle Show / hide disabled calendars (persistent)' },
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

function PrefsTasks({
  provider, providers, setActiveProvider, setCredentials, refresh,
  autoRollover, setAutoRollover, loadWindow, setLoadWindow,
  loadBands, setLoadBands,
}: {
  provider: TaskProviderInfo | null;
  providers: TaskProviderInfo[];
  setActiveProvider: (id: 'todoist' | 'markdown') => Promise<void>;
  setCredentials: (key: string | null) => Promise<void>;
  refresh: () => Promise<void>;
  autoRollover: boolean;
  setAutoRollover: (v: boolean) => void;
  loadWindow: LoadWindowSettings;
  setLoadWindow: (next: LoadWindowSettings) => void;
  loadBands: LoadBands;
  setLoadBands: (next: LoadBands) => void;
}) {
  const isMarkdown = provider?.id === 'markdown';
  const isTodoist = provider?.id === 'todoist';
  const hasKey = !!provider?.hasCredentials;
  const [editing, setEditing] = useState(isTodoist && !hasKey);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);

  // Switching providers wipes the editing state — credentials only mean
  // anything for Todoist, and the markdown provider needs no input.
  const switchProvider = async (id: 'todoist' | 'markdown') => {
    if (provider?.id === id) return;
    setSwitching(true);
    setSaveError(null);
    try {
      await setActiveProvider(id);
      setDraft('');
      setEditing(id === 'todoist');
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSwitching(false);
    }
  };

  const save = async () => {
    if (!draft.trim()) return;
    setSaving(true);
    setSaveError(null);
    try {
      await setCredentials(draft.trim());
      setDraft('');
      setEditing(false);
      await refresh();
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
      await setCredentials(null);
      setDraft('');
      setEditing(true);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const reveal = () => {
    void window.ycal.tasksRevealStorage();
  };

  return (
    <div className="pref-section">
      <h3 className="pref-h">Provider</h3>
      <p className="pref-row-hint" style={{ marginTop: 0, maxWidth: '60ch' }}>
        yCal can back tasks with a remote service (Todoist) or a local
        markdown file you can edit in any editor. Switching providers
        keeps the calendar schedule overlay (so a task you scheduled on
        Tuesday stays parked there) but lists tasks from the new source.
      </p>
      <PrefRow
        label="Active provider"
        hint={
          isMarkdown
            ? 'Tasks live in tasks.md, routed through your Sync setting.'
            : 'Tasks come from Todoist over the API.'
        }
      >
        <PrefSegmented<'todoist' | 'markdown'>
          value={(provider?.id ?? 'todoist') as 'todoist' | 'markdown'}
          options={providers.length > 0
            ? providers.map((p) => ({
                value: p.id as 'todoist' | 'markdown',
                label: p.displayName,
              }))
            : [
                { value: 'todoist', label: 'Todoist' },
                { value: 'markdown', label: 'Markdown file' },
              ]}
          onChange={(v) => void switchProvider(v)}
        />
      </PrefRow>
      {switching && (
        <div className="pref-row-hint" style={{ marginTop: 4 }}>
          Switching provider — refreshing task list…
        </div>
      )}

      {isTodoist && (
        <>
          <h3 className="pref-h" style={{ marginTop: 18 }}>Credentials</h3>
          <p className="pref-row-hint" style={{ marginTop: 0, maxWidth: '60ch' }}>
            {provider?.credentialsHint || 'Paste your personal API token.'}{' '}
            Stored encrypted in your macOS Keychain — never leaves this machine,
            so each Mac you sign in on needs its own token.
          </p>
          <PrefRow label="Token" hint={hasKey ? 'A key is currently set.' : 'Not set.'}>
            {!editing ? (
              <div className="pref-feed-display">
                <span className="pref-feed-url">{hasKey ? '••••••••••••••••' : '—'}</span>
                <button className="pref-btn" onClick={() => setEditing(true)}>
                  {hasKey ? 'Change…' : 'Add…'}
                </button>
              </div>
            ) : (
              <div className="pref-feed-edit">
                <input
                  type="password"
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  className="pref-feed-input"
                  placeholder="API token"
                  value={draft}
                  autoFocus
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void save();
                    if (e.key === 'Escape') setEditing(false);
                  }}
                />
                <div className="pref-feed-actions">
                  {hasKey && (
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
                    onClick={() => void save()}
                    disabled={!draft.trim() || saving}
                  >
                    {saving ? 'Saving…' : 'Save'}
                  </button>
                </div>
                {saveError && (
                  <div className="pref-feed-error">{saveError}</div>
                )}
              </div>
            )}
          </PrefRow>
        </>
      )}

      {isMarkdown && (
        <>
          <h3 className="pref-h" style={{ marginTop: 18 }}>Storage</h3>
          <p className="pref-row-hint" style={{ marginTop: 0, maxWidth: '60ch' }}>
            Tasks are stored in <code>tasks.md</code>. The file lives wherever
            your other synced data lives (see <em>Sync</em>) — iCloud Drive
            when on, otherwise this Mac&apos;s local data dir. Edit it in any
            markdown editor and yCal picks the change up on next refresh.
          </p>
          <PrefRow label="tasks.md">
            <div className="pref-feed-display">
              <button className="pref-btn" onClick={reveal}>
                Open file…
              </button>
            </div>
          </PrefRow>
          <div className="pref-note">
            Format quick reference:
            <code style={{ display: 'block', whiteSpace: 'pre-wrap', marginTop: 6 }}>{`# Project Name {#5897c5}
- [ ] Task title  @2026-05-15 !p2 #30m #high #office
  Description on the next line, indented.
  - [ ] Subtask  ^abc12345
  > [2026-05-01] Comment about progress.`}</code>
            <div style={{ marginTop: 6 }}>
              <code>!p1</code>=highest, <code>!p4</code>=default ·{' '}
              <code>@daily</code> / <code>@weekdays</code> / <code>@every Mon Wed</code> for recurrence
            </div>
          </div>
          {saveError && (
            <div className="pref-feed-error">{saveError}</div>
          )}
        </>
      )}

      <div className="pref-note">
        Open the Tasks panel from the Week or Day view (right edge tab, or
        Shift+T). Drag a task onto the calendar to schedule it; drop it back
        into the panel to unschedule. The schedule lives in iCloud (or local,
        see <em>Sync</em>) — it&apos;s never pushed back to the provider.
      </div>

      <h3 className="pref-h" style={{ marginTop: 18 }}>Rollover</h3>
      <PrefRow
        label="Auto-rollover unfinished tasks"
        hint={
          autoRollover
            ? 'Tasks scheduled to a past day that you didn’t finish are unscheduled and returned to the inbox.'
            : 'Tasks stay parked on their original day with a “↻ carry” marker in the inbox until you reschedule or finish them.'
        }
      >
        <PrefSwitch value={autoRollover} onChange={setAutoRollover} />
      </PrefRow>

      <h3 className="pref-h" style={{ marginTop: 18 }}>Day-load gauge</h3>
      <p className="pref-row-hint" style={{ marginTop: 0, maxWidth: '60ch' }}>
        The capacity bar under each date measures committed time against an
        active window. <strong>Free</strong> = window length minus committed
        minutes. <strong>Energy</strong> = equivalent meeting hours: meetings
        count 1.0×/h; tasks weighted by label — <code>low</code> 0.5×,{' '}
        <code>mid</code> 1.0×, <code>high</code> 1.5×. Events outside the
        window are clipped — a 7am breakfast doesn&apos;t count if the window
        starts at 9.
      </p>
      <LoadWindowEditor value={loadWindow} onChange={setLoadWindow} />
      <LoadBandsEditor value={loadBands} onChange={setLoadBands} />

      <h3 className="pref-h" style={{ marginTop: 18 }}>Labels</h3>
      <p className="pref-row-hint" style={{ marginTop: 0, maxWidth: '60ch' }}>
        yCal reads provider labels for Troika-style metadata: a duration
        label like <code>30m</code> / <code>1h</code> / <code>1h30m</code>,
        an energy label of <code>low</code> / <code>mid</code> /{' '}
        <code>high</code>, and any other label is treated as a location
        (<code>cafe</code>, <code>desk</code>, <code>home</code>, …). The
        first label that doesn&apos;t match duration or energy wins as the
        location.
      </p>
    </div>
  );
}

function PrefsRhythm({
  rhythmData, setDefault,
}: {
  rhythmData: RhythmData | null;
  setDefault: (fromDateStr: string, next: { wakeMin: number; sleepMin: number }) => Promise<void>;
}) {
  const today = new Date();
  const todayStr = fmtDate(today);
  const cur = rhythmData
    ? resolveDefault(rhythmData, todayStr)
    : { wakeMin: 390, sleepMin: 1380 };
  const [wakeDraft, setWakeDraft] = useState(minToHHMM(cur.wakeMin));
  const [sleepDraft, setSleepDraft] = useState(minToHHMM(cur.sleepMin));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    setWakeDraft(minToHHMM(cur.wakeMin));
    setSleepDraft(minToHHMM(cur.sleepMin));
  }, [cur.wakeMin, cur.sleepMin]);

  const save = async () => {
    const wake = hhmmToMin(wakeDraft);
    const sleep = hhmmToMin(sleepDraft);
    if (wake === null || sleep === null) {
      setSaveError('Use HH:MM format (24-hour).');
      return;
    }
    if (wake >= sleep) {
      setSaveError('Wake must be earlier than sleep.');
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      await setDefault(todayStr, { wakeMin: wake, sleepMin: sleep });
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const history = rhythmData?.defaults ?? [];
  // Skip the synthetic baseline so the history table only shows entries
  // the user actually authored.
  const userHistory = history.filter((d) => d.fromDate !== '0000-01-01');

  return (
    <div className="pref-section">
      <h3 className="pref-h">Default wake / sleep</h3>
      <p className="pref-row-hint" style={{ marginTop: 0, maxWidth: '60ch' }}>
        These set the wake and sleep lines for any day without a per-day
        override. Changing them here only affects today onwards — your past
        days keep the rhythm they were planned with.
      </p>
      <PrefRow label="Wake">
        <input
          type="time"
          className="pref-feed-input"
          value={wakeDraft}
          onChange={(e) => setWakeDraft(e.target.value)}
          step={900}
        />
      </PrefRow>
      <PrefRow label="Sleep">
        <input
          type="time"
          className="pref-feed-input"
          value={sleepDraft}
          onChange={(e) => setSleepDraft(e.target.value)}
          step={900}
        />
      </PrefRow>
      <div className="pref-feed-actions" style={{ marginTop: 6 }}>
        <button
          className="pref-btn pref-btn-primary"
          onClick={() => void save()}
          disabled={saving}
        >
          {saving ? 'Saving…' : 'Save default'}
        </button>
      </div>
      {saveError && (
        <div className="pref-feed-error">{saveError}</div>
      )}

      {userHistory.length > 0 && (
        <>
          <h3 className="pref-h" style={{ marginTop: 24 }}>History</h3>
          <p className="pref-row-hint" style={{ marginTop: 0, maxWidth: '60ch' }}>
            Each row is a default that applies to dates from <em>From</em> until
            superseded by the next entry below. Older days resolve through the
            entry above.
          </p>
          <table className="rhythm-history">
            <thead>
              <tr><th>From</th><th>Wake</th><th>Sleep</th></tr>
            </thead>
            <tbody>
              {userHistory.map((d) => (
                <tr key={d.fromDate}>
                  <td>{d.fromDate}</td>
                  <td>{formatRhythmTime(d.wakeMin)}</td>
                  <td>{formatRhythmTime(d.sleepMin)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <div className="pref-note" style={{ marginTop: 16 }}>
        Per-day overrides (drag a wake or sleep line in week or day view)
        live alongside the defaults. Resetting an override snaps that date
        back to whatever default was active when the day occurred —
        historical dates aren&apos;t rewritten.{' '}
        Storage location is shared with task scheduling, see <em>Sync</em>.
      </div>
    </div>
  );
}

function PrefsSync({
  storage, setStorage,
}: {
  storage: CloudStorageInfo | null;
  setStorage: (pref: 'icloud' | 'local') => Promise<void>;
}) {
  return (
    <div className="pref-section">
      <h3 className="pref-h">Storage location</h3>
      <p className="pref-row-hint" style={{ marginTop: 0, maxWidth: '60ch' }}>
        These files travel with the toggle below: <code>rhythm.json</code>{' '}
        (wake/sleep defaults + per-day overrides) and{' '}
        <code>tasks-schedule.json</code> (which calendar slot you dropped
        each task into, plus the per-task &ldquo;done today&rdquo; mirror).
        OAuth tokens stay in the local Keychain on each machine — they
        don&apos;t move.
      </p>
      <PrefRow
        label="Storage"
        hint={
          storage?.icloudAvailable
            ? 'iCloud Drive mirrors yCal data across your Macs.'
            : 'iCloud Drive is not available on this machine.'
        }
      >
        <PrefSegmented<'local' | 'icloud'>
          value={storage?.preferred ?? 'local'}
          options={[
            { value: 'local', label: 'Local' },
            { value: 'icloud', label: 'iCloud Drive' },
          ]}
          onChange={(v) => void setStorage(v)}
        />
      </PrefRow>
      {storage && (
        <div className="pref-note" style={{ wordBreak: 'break-all' }}>
          Folder: <code>{storage.dir}</code>
          {storage.preferred === 'icloud' && storage.effective !== 'icloud' && (
            <>
              <br />
              <strong>Falling back to local</strong> — iCloud Drive
              folder isn&apos;t available right now. Files will move
              automatically once it is.
            </>
          )}
        </div>
      )}
      <div className="pref-note">
        Switching storage copies the existing files to the new location;
        the old file stays put as a one-shot backup so a botched move can
        be undone by hand.
      </div>
    </div>
  );
}

function LoadWindowEditor({
  value, onChange,
}: {
  value: LoadWindowSettings;
  onChange: (next: LoadWindowSettings) => void;
}) {
  const [startDraft, setStartDraft] = useState(minToHHMM(value.startMin));
  const [endDraft, setEndDraft] = useState(minToHHMM(value.endMin));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setStartDraft(minToHHMM(value.startMin));
    setEndDraft(minToHHMM(value.endMin));
  }, [value.startMin, value.endMin]);

  const commit = (next: { startMin?: number; endMin?: number }) => {
    const startMin = next.startMin ?? value.startMin;
    const endMin = next.endMin ?? value.endMin;
    if (startMin >= endMin) {
      setError('Start must be earlier than end.');
      return;
    }
    setError(null);
    onChange({ ...value, mode: 'fixed', startMin, endMin });
  };

  const useRhythm = value.mode === 'rhythm';

  return (
    <>
      <PrefRow
        label="Use my full day rhythm"
        hint="When on, free time and energy span wake → sleep. When off, only the active window below counts."
      >
        <PrefSwitch
          value={useRhythm}
          onChange={(v) => onChange({ ...value, mode: v ? 'rhythm' : 'fixed' })}
        />
      </PrefRow>
      <PrefRow label="Active window — start">
        <input
          type="time"
          className="pref-feed-input"
          disabled={useRhythm}
          value={startDraft}
          step={900}
          onChange={(e) => setStartDraft(e.target.value)}
          onBlur={() => {
            const m = hhmmToMin(startDraft);
            if (m === null) {
              setError('Use HH:MM format (24-hour).');
              return;
            }
            commit({ startMin: m });
          }}
        />
      </PrefRow>
      <PrefRow label="Active window — end">
        <input
          type="time"
          className="pref-feed-input"
          disabled={useRhythm}
          value={endDraft}
          step={900}
          onChange={(e) => setEndDraft(e.target.value)}
          onBlur={() => {
            const m = hhmmToMin(endDraft);
            if (m === null) {
              setError('Use HH:MM format (24-hour).');
              return;
            }
            commit({ endMin: m });
          }}
        />
      </PrefRow>
      {error && <div className="pref-feed-error">{error}</div>}
    </>
  );
}

function LoadBandsEditor({
  value, onChange,
}: {
  value: LoadBands;
  onChange: (next: LoadBands) => void;
}) {
  const [calm, setCalm] = useState(String(value.calmMax));
  const [steady, setSteady] = useState(String(value.steadyMax));
  const [full, setFull] = useState(String(value.fullMax));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setCalm(String(value.calmMax));
    setSteady(String(value.steadyMax));
    setFull(String(value.fullMax));
  }, [value.calmMax, value.steadyMax, value.fullMax]);

  const commit = (next: Partial<LoadBands>) => {
    const candidate: LoadBands = {
      calmMax: next.calmMax ?? value.calmMax,
      steadyMax: next.steadyMax ?? value.steadyMax,
      fullMax: next.fullMax ?? value.fullMax,
    };
    if (
      !Number.isFinite(candidate.calmMax)
      || !Number.isFinite(candidate.steadyMax)
      || !Number.isFinite(candidate.fullMax)
    ) {
      setError('Use a number of hours.');
      return;
    }
    if (candidate.calmMax <= 0) {
      setError('Calm cap must be greater than 0.');
      return;
    }
    if (candidate.calmMax >= candidate.steadyMax
      || candidate.steadyMax >= candidate.fullMax) {
      setError('Thresholds must increase: calm < steady < full.');
      return;
    }
    setError(null);
    onChange(candidate);
  };

  const reset = () => {
    onChange(DEFAULT_LOAD_BANDS);
  };

  return (
    <>
      <h4 className="pref-h" style={{ marginTop: 14, fontSize: 12 }}>
        Energy bands
      </h4>
      <p className="pref-row-hint" style={{ marginTop: 0, maxWidth: '60ch' }}>
        Day energy (in equivalent meeting hours) maps to a color band.
        Adjust the cutoffs to taste — the heavy band catches anything above
        the full cap.
      </p>
      <PrefRow
        label="Calm cap"
        hint="Days at or below this many energy hours read as calm (green)."
      >
        <input
          type="number"
          step={0.5}
          min={0.5}
          className="pref-feed-input"
          value={calm}
          onChange={(e) => setCalm(e.target.value)}
          onBlur={() => commit({ calmMax: parseFloat(calm) })}
        />
      </PrefRow>
      <PrefRow
        label="Steady cap"
        hint="Up to this is steady (yellow). Past it is full or heavier."
      >
        <input
          type="number"
          step={0.5}
          min={0.5}
          className="pref-feed-input"
          value={steady}
          onChange={(e) => setSteady(e.target.value)}
          onBlur={() => commit({ steadyMax: parseFloat(steady) })}
        />
      </PrefRow>
      <PrefRow
        label="Full cap"
        hint="Up to this is full (orange). Anything above tips into heavy (red)."
      >
        <input
          type="number"
          step={0.5}
          min={0.5}
          className="pref-feed-input"
          value={full}
          onChange={(e) => setFull(e.target.value)}
          onBlur={() => commit({ fullMax: parseFloat(full) })}
        />
      </PrefRow>
      {error && <div className="pref-feed-error">{error}</div>}
      <div className="pref-feed-actions" style={{ marginTop: 6 }}>
        <button className="pref-btn" onClick={reset}>
          Reset to defaults
        </button>
      </div>
    </>
  );
}

function minToHHMM(m: number): string {
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function hhmmToMin(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  if (h < 0 || h > 23 || mm < 0 || mm > 59) return null;
  return h * 60 + mm;
}
