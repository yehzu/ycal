import type { DayLoad } from '../dayLoad';
import { formatDur } from '../dayLoad';

// Capacity bar — appears beneath day-num in week/day headers and in month
// cells. Width follows fillPct (occupied / awake). The intensity bucket
// drives color so the bar communicates two things at once: how much of the
// day is committed AND how heavy that commitment is.
export function DayLoadGauge({
  load, variant = 'compact',
}: {
  load: DayLoad | null;
  variant?: 'compact' | 'head';
}) {
  if (!load) return null;
  const cls = ['day-load-gauge', 'v-' + variant, 'i-' + load.intensity];
  if (load.fillPct >= 0.95) cls.push('packed');
  const pct = Math.max(4, Math.round(load.fillPct * 100));
  const title = `${formatDur(load.occupiedMin)} committed · ${formatDur(load.freeMin)} free · ${load.intensity} day`;
  return (
    <div className={cls.join(' ')} title={title} aria-label={title}>
      <div className="day-load-fill" style={{ width: pct + '%' }} />
    </div>
  );
}

// One-line textual readout of available time, sized for the time-view column
// header. "5h free" reads at a glance; on packed days we swap in a louder
// "PACKED" so heavy days stand out from a row of greens.
export function DayLoadReadout({ load }: { load: DayLoad | null }) {
  if (!load) return null;
  const cls = ['day-load-readout', 'i-' + load.intensity];
  if (load.fillPct >= 0.95) cls.push('i-packed');
  const label = load.fillPct >= 0.95
    ? 'packed'
    : `${formatDur(load.freeMin)} free`;
  return (
    <div
      className={cls.join(' ')}
      title={`${formatDur(load.occupiedMin)} committed · ${load.meetingCount} meetings`}
    >
      {label}
    </div>
  );
}

// Richer load summary — used in the day detail panel. Free time first
// (because that's what users want to know), then a one-line breakdown.
export function DayLoadSummary({
  load, compact,
}: {
  load: DayLoad | null;
  compact?: boolean;
}) {
  if (!load) return null;
  const pieces: string[] = [];
  if (load.meetingCount) {
    pieces.push(`${load.meetingCount} meeting${load.meetingCount === 1 ? '' : 's'}`);
  }
  if (load.taskCount) {
    pieces.push(`${load.taskCount} task${load.taskCount === 1 ? '' : 's'}`);
  }
  pieces.push(`${load.intensity} day`);
  const occPct = Math.max(2, Math.round(load.fillPct * 100));
  const cls = ['day-load-summary', 'i-' + load.intensity];
  if (compact) cls.push('compact');
  return (
    <div className={cls.join(' ')}>
      <div className="dls-headline">
        <span className="dls-free">{formatDur(load.freeMin)} <em>free</em></span>
        <span className="dls-sep">·</span>
        <span className="dls-occ">{formatDur(load.occupiedMin)} <em>committed</em></span>
      </div>
      <div className="dls-bar">
        <div className="dls-bar-occ" style={{ width: occPct + '%' }} />
        <div className="dls-bar-tick" style={{ left: '50%' }} />
      </div>
      <div className="dls-meta">{pieces.join(' · ')}</div>
    </div>
  );
}
