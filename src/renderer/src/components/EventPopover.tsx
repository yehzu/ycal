import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type {
  CalendarEvent, CalendarSummary, AccountSummary, MeetingArchiveSummary,
  MeetingArtifactKind, RecentRecording, RecordingStatus,
} from '@shared/types';
import { DOW_LONG, MONTH_NAMES, formatTimeFull, ordinal } from '../dates';
import { rsvpClass, rsvpLabel } from '../rsvp';
import { avatarBg, initials } from './MacTitleBar';
import { DescriptionHTML } from './DescriptionHTML';
import { MergeBadge } from './MergeBadge';
import { PopoverAttendees } from './PopoverAttendees';

interface Props {
  event: CalendarEvent;
  anchorRect: DOMRect | null;
  calendars: CalendarSummary[];
  accounts: AccountSummary[];
  onClose: () => void;
  // Auto-record setting from app state. Used to render a "Will auto-record"
  // hint on events that match the trigger criteria but haven't started yet.
  autoRecord: boolean;
}

export function EventPopover({
  event, anchorRect, calendars, accounts, onClose, autoRecord,
}: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  // Recording state for this specific event. Three sources:
  //   1. In-memory recordings (recording/processing/done/failed within
  //      the 30 min retention window) — primary, drives the elapsed-
  //      time counter + Stop button.
  //   2. On-disk recent recordings — surfaces past meeting notes that
  //      have aged out of the in-memory map (older than 30 min).
  //      Matching is by event id encoded in the filename.
  //   3. Re-process button — re-runs post-meet.sh on an existing m4a
  //      using the user's current model + prompt; status flows back
  //      through (1) for live progress.
  const [recording, setRecording] = useState<RecordingStatus | null>(null);
  const [pastRec, setPastRec] = useState<RecentRecording | null>(null);
  const [driveArchive, setDriveArchive] = useState<MeetingArchiveSummary | null>(null);
  const [, setNow] = useState<number>(Date.now());
  useEffect(() => {
    let cancelled = false;
    const refresh = async (): Promise<void> => {
      const [active, recent] = await Promise.all([
        window.ycal.recorderList(),
        window.ycal.recorderListRecent(50),
      ]);
      if (cancelled) return;
      setRecording(active.find((r) => r.eventId === event.id) ?? null);
      setPastRec(recent.find((r) => r.eventId === event.id) ?? null);
    };
    void refresh();
    const off = window.ycal.onRecorderStatusChanged((list) => {
      setRecording(list.find((r) => r.eventId === event.id) ?? null);
      // A status transition (typically done/failed) means a file may
      // have just landed or been overwritten — re-scan disk too.
      void window.ycal.recorderListRecent(50).then((recent) => {
        if (!cancelled) setPastRec(recent.find((r) => r.eventId === event.id) ?? null);
      });
    });
    return () => { cancelled = true; off(); };
  }, [event.id]);

  // Probe Drive ONCE per event open for an existing archive. This is
  // cheap (one Drive list per account) but not free — debounce by
  // gating on the event id and only firing when the popover is
  // actually visible. The archive is the source of truth for past
  // recordings: it survives across Macs, while pastRec on disk only
  // exists on the machine that did the recording.
  useEffect(() => {
    let cancelled = false;
    void window.ycal.meetingArchiveList({
      eventId: event.id,
      accountId: event.accountId,
    }).then((res) => {
      if (cancelled) return;
      if (res.ok && res.archives.length > 0) {
        setDriveArchive(res.archives[0]);
      } else {
        setDriveArchive(null);
      }
    });
    return () => { cancelled = true; };
  }, [event.id, event.accountId]);
  useEffect(() => {
    if (recording?.state !== 'recording') return undefined;
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [recording?.state]);

  useLayoutEffect(() => {
    if (!anchorRect || !ref.current) return;
    const a = anchorRect;
    const p = ref.current.getBoundingClientRect();
    const margin = 12;
    // macOS traffic-light buttons sit near the top-left of the window;
    // keep the popover clear of them when it lands at the top edge.
    const topMin = 36;
    let left = a.left + a.width / 2 - p.width / 2;
    let top = a.bottom + 8;
    left = Math.max(margin, Math.min(window.innerWidth - p.width - margin, left));
    if (top + p.height > window.innerHeight - margin) {
      top = Math.max(topMin, a.top - p.height - 8);
    }
    top = Math.max(topMin, top);
    setPos({ top, left });
  }, [anchorRect]);

  const cal = calendars.find((c) => c.id === event.calendarId);
  const acct = accounts.find((a) => a.id === event.accountId);
  const startD = new Date(event.start);
  const endD = new Date(event.end);
  const merged = event.mergedFrom && event.mergedFrom.length > 1 ? event.mergedFrom : null;
  const rc = rsvpClass(event);
  const rLabel = rsvpLabel(event.rsvp);

  const openInGoogle = () => {
    if (event.htmlLink) {
      // Renderer can't shell.openExternal directly; fall back to window.open
      // which Electron will route via the will-frame-navigate handler. Since
      // we set CSP connect-src to 'self', a plain anchor is safer.
      window.open(event.htmlLink, '_blank', 'noopener');
    }
  };

  return (
    <>
      <div className="popover-backdrop" onClick={onClose} />
      <div
        className="popover"
        ref={ref}
        style={{ top: pos.top, left: pos.left, ['--cal' as never]: event.color }}
      >
        <button className="pp-close" onClick={onClose}>✕</button>
        <div className="pp-scroll">
        <div className="pp-cal">{cal ? cal.name : 'Event'}</div>
        <div className={'pp-title' + (rc ? ' ' + rc : '')}>
          {event.title}
          <MergeBadge event={event} />
        </div>
        {rc && rLabel && (
          <div className="pp-rsvp">
            <span className={'pp-rsvp-pill ' + rc}>{rLabel}</span>
          </div>
        )}
        <hr className="pp-rule" />
        <div className="pp-row">
          <span className="k">When</span>
          <span className="v">
            {DOW_LONG[startD.getDay()]}, {MONTH_NAMES[startD.getMonth()]}{' '}
            {ordinal(startD.getDate())}
            {!event.allDay && (
              <span className="mono" style={{ display: 'block', marginTop: 4 }}>
                {formatTimeFull(startD)} – {formatTimeFull(endD)}
              </span>
            )}
            {event.allDay && (
              <span
                style={{
                  display: 'block',
                  fontStyle: 'italic',
                  color: 'var(--ink-mute)',
                  marginTop: 2,
                }}
              >
                All day
              </span>
            )}
          </span>
        </div>
        {event.location && (
          <div className="pp-row">
            <span className="k">Where</span>
            <span className="v" style={{ fontStyle: 'italic' }}>{event.location}</span>
          </div>
        )}
        {event.meetUrl && (
          <div className="pp-row">
            <span className="k">Video</span>
            <span className="v">
              <a
                className="pp-meet"
                href={'https://' + event.meetUrl}
                target="_blank"
                rel="noreferrer"
                onClick={(ev) => ev.stopPropagation()}
              >
                <span className="pp-meet-ico" aria-hidden="true">
                  <svg viewBox="0 0 24 24" width="14" height="14">
                    <path
                      fill="#00897b"
                      d="M2 6.5A1.5 1.5 0 0 1 3.5 5h11A1.5 1.5 0 0 1 16 6.5v11a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 2 17.5v-11Z"
                    />
                    <path
                      fill="#fbbc04"
                      d="M16 9.5 21.2 6.4a.5.5 0 0 1 .8.4v10.4a.5.5 0 0 1-.8.4L16 14.5v-5Z"
                    />
                  </svg>
                </span>
                <span className="pp-meet-text">
                  Join with {event.meetLabel || 'Google Meet'}
                </span>
                <span className="pp-meet-url">{event.meetUrl}</span>
              </a>
            </span>
          </div>
        )}
        <RecordingRow
          event={event}
          recording={recording}
          pastRec={pastRec}
          driveArchive={driveArchive}
          autoRecord={autoRecord}
        />
        {event.attendees && event.attendees.length > 0 && (
          <PopoverAttendees attendees={event.attendees} />
        )}
        {event.description && (
          <div className="pp-row">
            <span className="k">Notes</span>
            <span className="v" style={{ minWidth: 0 }}>
              <DescriptionHTML html={event.description} />
            </span>
          </div>
        )}
        {acct && (
          <div className="pp-row">
            <span className="k">Account</span>
            <span className="v pp-acct">
              <span className="av" style={{ background: avatarBg(acct.id) }}>
                {initials(acct)}
              </span>
              {acct.email}
            </span>
          </div>
        )}
        {merged && (
          <div className="pp-row">
            <span className="k">Also on</span>
            <span className="v pp-merged">
              {/* Skip the first source — it's the canonical event already
                  shown above as the calendar/account. The "Also on" list
                  surfaces every other calendar this event lives in. */}
              {merged.slice(1).map((m) => {
                const c = calendars.find((cc) => cc.id === m.calendarId);
                const a = accounts.find((aa) => aa.id === m.accountId);
                return (
                  <span key={m.id} className="pp-merged-row">
                    <span className="pp-merged-dot" style={{ background: m.color }} />
                    <span className="pp-merged-name">{c ? c.name : m.calendarId}</span>
                    {a && <span className="pp-merged-acct">· {a.email}</span>}
                  </span>
                );
              })}
            </span>
          </div>
        )}
        </div>
        <div className="pp-actions">
          {event.htmlLink && (
            <button className="pp-btn primary" onClick={openInGoogle}>
              Open in Google
            </button>
          )}
          <button className="pp-btn" onClick={onClose} style={{ marginLeft: 'auto' }}>
            Close
          </button>
        </div>
      </div>
    </>
  );
}

// Open a Drive-stored meeting artifact by id + kind. Downloads to the
// local cache if needed, then routes through recorderOpenFile (which
// safeRecordingPath has been widened to allow meeting-cache paths).
// Fire-and-forget; errors surface as alerts so the user knows a Drive
// failure (network / auth) is the reason nothing opened.
async function openFromDrive(
  eventId: string,
  accountId: string | null,
  kind: MeetingArtifactKind,
): Promise<void> {
  const res = await window.ycal.meetingArchiveFetch({
    eventId,
    accountId: accountId ?? null,
    kind,
  });
  if (!res.ok) {
    window.alert(`Couldn't open ${kind} from Drive: ${res.error}`);
    return;
  }
  await window.ycal.recorderOpenFile(res.path);
}

// Renders a "Recording" row in the popover that adapts to four states:
//   * recording  → red dot + MM:SS elapsed + Stop button
//   * processing → "Transcribing…" hint
//   * uploading  → "Uploading to Drive…" hint
//   * done       → "Notes ready · Open notes" (local or Drive)
//   * future + auto-record on + qualifies → "Will auto-record" hint
// When pastRec is absent but driveArchive is present (case: this Mac
// didn't do the recording — another Mac did, and we pulled the archive
// via Drive), we still surface Notes/Transcript/Audio buttons backed
// by on-demand fetches.
function RecordingRow({
  event, recording, pastRec, driveArchive, autoRecord,
}: {
  event: CalendarEvent;
  recording: RecordingStatus | null;
  pastRec: RecentRecording | null;
  driveArchive: MeetingArchiveSummary | null;
  autoRecord: boolean;
}) {
  if (recording) {
    if (recording.state === 'recording') {
      const elapsedSec = Math.max(0, Math.floor((Date.now() - recording.startedAt) / 1000));
      const mm = Math.floor(elapsedSec / 60);
      const ss = elapsedSec % 60;
      return (
        <div className="pp-row">
          <span className="k">Recording</span>
          <span className="v" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ color: '#c4451a', fontVariantNumeric: 'tabular-nums' }}>
              ● {mm}:{String(ss).padStart(2, '0')}
            </span>
            <button
              className="pp-btn"
              onClick={() => { void window.ycal.recorderStop(recording.eventId); }}
              style={{ padding: '2px 10px', fontSize: 12 }}
            >
              Stop
            </button>
          </span>
        </div>
      );
    }
    if (recording.state === 'processing') {
      return (
        <div className="pp-row">
          <span className="k">Recording</span>
          <span className="v" style={{ opacity: 0.75 }}>⋯ Transcribing…</span>
        </div>
      );
    }
    if (recording.state === 'uploading') {
      return (
        <div className="pp-row">
          <span className="k">Recording</span>
          <span className="v" style={{ opacity: 0.75 }}>↑ Uploading to Drive…</span>
        </div>
      );
    }
    if (recording.state === 'done') {
      const uploaded = recording.uploadedKinds ?? [];
      const onDrive = uploaded.length > 0;
      return (
        <div className="pp-row">
          <span className="k">Recording</span>
          <span className="v" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span title={onDrive ? `On Drive: ${uploaded.join(', ')}` : 'Local only'}>
              ✓ Done{onDrive ? ' · Drive ✓' : ''}
            </span>
            {recording.summaryFile && (
              <button
                className="pp-btn"
                onClick={() => { void window.ycal.recorderOpenFile(recording.summaryFile!); }}
                style={{ padding: '2px 10px', fontSize: 12 }}
              >
                Notes
              </button>
            )}
            {recording.transcriptFile && (
              <button
                className="pp-btn"
                onClick={() => { void window.ycal.recorderOpenFile(recording.transcriptFile!); }}
                style={{ padding: '2px 10px', fontSize: 12 }}
              >
                Transcript
              </button>
            )}
            {recording.audioFile && (
              <button
                className="pp-btn"
                onClick={() => { void window.ycal.recorderOpenFile(recording.audioFile!); }}
                style={{ padding: '2px 10px', fontSize: 12 }}
                title="Open the m4a recording"
              >
                Audio
              </button>
            )}
            {recording.audioFile && (
              <button
                className="pp-btn"
                onClick={() => {
                  void window.ycal.recorderReprocess({
                    eventId: event.id,
                    audioFile: recording.audioFile!,
                    title: event.title,
                    accountId: recording.accountId,
                  });
                }}
                style={{ padding: '2px 10px', fontSize: 12 }}
                title="Re-run whisper + claude with the current model + prompt"
              >
                Re-process
              </button>
            )}
          </span>
        </div>
      );
    }
    if (recording.state === 'failed') {
      // Show the error briefly + an unconditional "Try again" path so a
      // botched recording doesn't park itself on the popover for the
      // full 30 min in-memory retention. Also surface the m4a if
      // ffmpeg got far enough to write one before failing — at minimum
      // the audio is salvageable even when transcription died.
      return (
        <div className="pp-row">
          <span className="k">Recording</span>
          <span
            className="v"
            style={{
              display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
              color: '#c4451a',
            }}
          >
            <span title={recording.error ?? 'failed'}>
              ✗ {recording.error ? recording.error.slice(0, 60) : 'failed'}
            </span>
            <button
              className="pp-btn"
              onClick={() => { void window.ycal.recorderStart(event); }}
              style={{ padding: '2px 10px', fontSize: 12 }}
            >
              Try again
            </button>
            {recording.audioFile && (
              <button
                className="pp-btn"
                onClick={() => { void window.ycal.recorderOpenFile(recording.audioFile!); }}
                style={{ padding: '2px 10px', fontSize: 12 }}
              >
                Audio
              </button>
            )}
          </span>
        </div>
      );
    }
  }

  // Past recording on disk (in-memory status has aged out). Surface
  // the same Open buttons as the done state PLUS a Re-process action
  // for users who've changed model / prompt and want to regenerate
  // the transcript + note from the existing audio.
  if (pastRec) {
    const driveAcct = driveArchive?.accountId ?? event.accountId ?? null;
    return (
      <div className="pp-row">
        <span className="k">Recording</span>
        <span className="v" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span title={driveArchive ? 'Mirrored to Drive' : 'Local only'}>
            ✓ Recorded{driveArchive ? ' · Drive ✓' : ''}
          </span>
          {pastRec.summaryFile && (
            <button
              className="pp-btn"
              onClick={() => { void window.ycal.recorderOpenFile(pastRec.summaryFile!); }}
              style={{ padding: '2px 10px', fontSize: 12 }}
            >
              Notes
            </button>
          )}
          {pastRec.transcriptFile && (
            <button
              className="pp-btn"
              onClick={() => { void window.ycal.recorderOpenFile(pastRec.transcriptFile!); }}
              style={{ padding: '2px 10px', fontSize: 12 }}
            >
              Transcript
            </button>
          )}
          {!pastRec.transcriptFile && driveArchive?.hasTranscript && (
            <button
              className="pp-btn"
              onClick={() => { void openFromDrive(event.id, driveAcct, 'transcript'); }}
              style={{ padding: '2px 10px', fontSize: 12 }}
              title="Fetch transcript from Drive cache"
            >
              Transcript
            </button>
          )}
          <button
            className="pp-btn"
            onClick={() => { void window.ycal.recorderOpenFile(pastRec.audioFile); }}
            style={{ padding: '2px 10px', fontSize: 12 }}
          >
            Audio
          </button>
          <button
            className="pp-btn"
            onClick={() => {
              void window.ycal.recorderReprocess({
                eventId: event.id,
                audioFile: pastRec.audioFile,
                title: event.title,
                accountId: driveAcct ?? undefined,
              });
            }}
            style={{ padding: '2px 10px', fontSize: 12 }}
            title="Re-run whisper + claude with the current model + prompt"
          >
            Re-process
          </button>
        </span>
      </div>
    );
  }

  // No local recording on this Mac, but the Drive archive has files —
  // this is the "another Mac did the recording, I'm reading the notes
  // here" case. Wire each button to fetch-then-open via the Drive
  // cache so the user doesn't notice the difference.
  if (driveArchive && (driveArchive.hasSummary || driveArchive.hasTranscript || driveArchive.hasAudio)) {
    const acct = driveArchive.accountId;
    return (
      <div className="pp-row">
        <span className="k">Recording</span>
        <span className="v" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span title="Pulled from another Mac via Drive">✓ Drive</span>
          {driveArchive.hasSummary && (
            <button
              className="pp-btn"
              onClick={() => { void openFromDrive(event.id, acct, 'summary'); }}
              style={{ padding: '2px 10px', fontSize: 12 }}
            >
              Notes
            </button>
          )}
          {driveArchive.hasTranscript && (
            <button
              className="pp-btn"
              onClick={() => { void openFromDrive(event.id, acct, 'transcript'); }}
              style={{ padding: '2px 10px', fontSize: 12 }}
            >
              Transcript
            </button>
          )}
          {driveArchive.hasAudio && (
            <button
              className="pp-btn"
              onClick={() => { void openFromDrive(event.id, acct, 'audio'); }}
              style={{ padding: '2px 10px', fontSize: 12 }}
              title="Download the m4a from Drive and open it"
            >
              Audio
            </button>
          )}
        </span>
      </div>
    );
  }

  // No in-memory recording AND nothing on disk yet — offer a "Start
  // now" button for any event that's recordable (has a video link,
  // not declined, not all-day, still has time left). When the user is
  // sitting in a meeting early and wants to capture it before its
  // scheduled start, this is the entry point. Tag on a "Will auto-
  // record at <time>" hint when the event is future AND the user has
  // the auto-record toggle on, so they understand they don't HAVE to
  // click — yCal would do it for them in N minutes anyway.
  const canStart = !!event.meetUrl
    && event.rsvp !== 'declined'
    && !event.allDay
    && Date.parse(event.end) > Date.now();
  if (!canStart) return null;
  const willAuto = autoRecord && Date.parse(event.start) > Date.now();
  const startTime = new Date(event.start).toLocaleTimeString(undefined, {
    hour: 'numeric', minute: '2-digit',
  });
  return (
    <div className="pp-row">
      <span className="k">Recording</span>
      <span className="v" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button
          className="pp-btn"
          onClick={() => { void window.ycal.recorderStart(event); }}
          style={{ padding: '2px 12px', fontSize: 12 }}
        >
          Start now
        </button>
        {willAuto && (
          <span style={{ opacity: 0.65, fontSize: 12 }}>
            (auto at {startTime})
          </span>
        )}
      </span>
    </div>
  );
}
