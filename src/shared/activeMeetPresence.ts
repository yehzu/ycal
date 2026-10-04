// Is somebody actually at THIS Mac? The gate in front of the activeMeet
// auto-start.
//
// activeMeet starts a recording whenever a Meet room shows up in a browser
// tab. Arc syncs tabs between Macs, so joining a Meet on one Mac makes the
// same tab appear on the other — and because settings.json is cloud-synced,
// both Macs are on activeMeet together, so both started recording and the
// unused one captured an empty file. The microphone can't tell the two
// apart (yCal opens the mic the moment it starts recording); presence can:
// the Mac nobody is using is locked, or hasn't seen a key press or mouse
// move in a while. Someone joining a Meet has just clicked something, so
// the Mac they're on reads as active at that moment.
//
// Pure on purpose: main samples Electron's powerMonitor and hands the
// numbers here, so the verdict is testable without Electron
// (tests/presence/check.mjs). The renderer reads the threshold for the
// Settings hint, which is why this lives in @shared.
//
// Only the activeMeet AUTO-START consults this. Manual starts, the calendar
// trigger, and every stop path (tab closed, endsAt, overrun, suspend) are
// untouched — once a recording is running, presence no longer matters.
//
// A RESTART is not a fresh join. A recording can stop mid-meeting (a
// tab-closed misread, an inconclusive probe at endsAt, the overrun cap), and
// the detector retries only after whisper + summary finish — by which time
// someone who is just listening has easily been hands-off for 5 minutes, or
// has locked the screen with headphones on. So a meeting this Mac recorded
// recently (same room code or same tab title) bypasses the gate entirely,
// locked included.

/** Same union Electron's `powerMonitor.getSystemIdleState()` returns. */
export type SystemIdleState = 'active' | 'idle' | 'locked' | 'unknown';

/**
 * Seconds without keyboard or mouse input after which this Mac counts as
 * unattended, so an activeMeet auto-start is skipped. Joining a Meet is
 * itself a click, so the Mac in use reads well under this; the Mac that
 * merely received a synced tab has usually been left alone far longer.
 */
export const ACTIVE_MEET_IDLE_THRESHOLD_SECS = 5 * 60;

/**
 * How long a meeting this Mac recorded keeps bypassing the gate. Recurring
 * meetings reuse one Meet code and usually one tab title, so it can't be
 * forever — otherwise last week's recording here would wave this week's
 * synced tab through. 4 h matches the longest event the recorder will
 * auto-record.
 */
export const ACTIVE_MEET_RESUME_WINDOW_MS = 4 * 60 * 60_000;

/**
 * The keys a meeting is remembered by: its Meet room code and the tab title
 * the detector reported. Both, because the detector often reports only a
 * "Meet - …" window title with no URL (its System Events pass runs first and
 * wins whenever the Meet tab is in front), so a code alone would miss most
 * restarts. A synced tab carries the same title onto the other Mac, but that
 * Mac never recorded it, so it never has the key.
 */
export function resumeKeys(
  roomCode: string | null | undefined,
  title: string | null | undefined,
): string[] {
  const keys: string[] = [];
  if (roomCode) keys.push(`room:${roomCode}`);
  const t = title?.trim();
  if (t) keys.push(`title:${t}`);
  return keys;
}

/**
 * Did this Mac record this meeting (start or stop) within the resume window?
 * `recent` maps resumeKeys() → ms of the last start/stop here; a hit on the
 * room code OR the title is enough. No code and no title → never a resume.
 */
export function isResumingMeet(
  meet: { roomCode?: string | null; title?: string | null },
  recent: ReadonlyMap<string, number>,
  now: number,
  windowMs: number = ACTIVE_MEET_RESUME_WINDOW_MS,
): boolean {
  return resumeKeys(meet.roomCode, meet.title).some((k) => {
    const at = recent.get(k);
    return at !== undefined && now - at < windowMs;
  });
}

export interface PresenceSample {
  /** `powerMonitor.getSystemIdleState(threshold)`; 'unknown' if it threw. */
  idleState: SystemIdleState;
  /** `powerMonitor.getSystemIdleTime()` in seconds; NaN if it threw. */
  idleSecs: number;
}

export type PresenceVerdict =
  | { start: true; reason: 'active' | 'unknown' | 'resume' }
  | { start: false; reason: 'locked' | 'idle' };

export interface PresenceOptions {
  /** isResumingMeet() for the signal — restarts skip the gate. */
  resuming?: boolean;
  thresholdSecs?: number;
}

export function judgeActiveMeetPresence(
  sample: PresenceSample,
  { resuming = false, thresholdSecs = ACTIVE_MEET_IDLE_THRESHOLD_SECS }: PresenceOptions = {},
): PresenceVerdict {
  // Checked first, so it wins over 'locked' and 'idle' alike.
  if (resuming) return { start: true, reason: 'resume' };
  if (sample.idleState === 'locked') return { start: false, reason: 'locked' };
  // 'unknown' means the OS couldn't say — not that nobody is there. Start
  // anyway: a duplicate empty recording on the other Mac is the nuisance
  // this gate removes, but a missed recording of a real meeting can't be
  // recovered, so a failed probe must not be what skips one. idleSecs comes
  // from the same probe, so it isn't trusted to overrule this either.
  if (sample.idleState === 'unknown') return { start: true, reason: 'unknown' };
  // Electron already compared against the same threshold to produce
  // 'idle'. The two calls are made a moment apart, so they can disagree
  // right at the boundary; either one saying idle is enough to skip.
  if (sample.idleState === 'idle' || sample.idleSecs >= thresholdSecs) {
    return { start: false, reason: 'idle' };
  }
  return { start: true, reason: 'active' };
}
