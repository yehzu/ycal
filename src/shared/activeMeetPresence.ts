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

/** Same union Electron's `powerMonitor.getSystemIdleState()` returns. */
export type SystemIdleState = 'active' | 'idle' | 'locked' | 'unknown';

/**
 * Seconds without keyboard or mouse input after which this Mac counts as
 * unattended, so an activeMeet auto-start is skipped. Joining a Meet is
 * itself a click, so the Mac in use reads well under this; the Mac that
 * merely received a synced tab has usually been left alone far longer.
 */
export const ACTIVE_MEET_IDLE_THRESHOLD_SECS = 5 * 60;

export interface PresenceSample {
  /** `powerMonitor.getSystemIdleState(threshold)`; 'unknown' if it threw. */
  idleState: SystemIdleState;
  /** `powerMonitor.getSystemIdleTime()` in seconds; NaN if it threw. */
  idleSecs: number;
}

export type PresenceVerdict =
  | { start: true; reason: 'active' | 'unknown' }
  | { start: false; reason: 'locked' | 'idle' };

export function judgeActiveMeetPresence(
  sample: PresenceSample,
  thresholdSecs: number = ACTIVE_MEET_IDLE_THRESHOLD_SECS,
): PresenceVerdict {
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
