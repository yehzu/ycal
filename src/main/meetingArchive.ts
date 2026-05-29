// yCal — per-event meeting artifact archive on Google Drive.
//
// Each event the recorder finishes gets up to three files uploaded to the
// EVENT-OWNING account's `drive.appdata` bucket (not the global driveSync
// account). That keeps recordings co-located with the calendar they came
// from and gives the user one Drive per Google account — so a phone
// signed in to that same account can read the same files.
//
// File naming (flat in appdata — siblings of settings.json etc., scoped
// by a meet__ prefix so list filters are cheap):
//
//   meet__<eventIdSafe>.audio.m4a
//   meet__<eventIdSafe>.transcript.txt
//   meet__<eventIdSafe>.summary.md
//   meet__<eventIdSafe>.meta.json   ← title, startedAt, endsAt, accountId
//
// eventIdSafe = eventId with `/`, `\`, and control bytes replaced by `-`.
// We need a flat namespace because driveAppData has no concept of
// subfolders inside appdata (well — it does, but file listing by name
// query is faster across a flat space).
//
// Local cache: <userData>/meeting-cache/<eventIdSafe>/{audio.m4a,
// transcript.txt, summary.md, meta.json}. Reads check Drive freshness
// against the cached meta.json; if Drive has nothing new the cached file
// is returned without a re-download.

import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

import { authClientForAccount } from './auth';
import { getAccount, listAccounts } from './tokenStore';
import { DriveAppDataAPI, type AppDataFile } from './driveAppData';

export type ArtifactKind = 'audio' | 'transcript' | 'summary';

const KIND_SUFFIX: Record<ArtifactKind, string> = {
  audio: '.audio.m4a',
  transcript: '.transcript.txt',
  summary: '.summary.md',
};

const META_SUFFIX = '.meta.json';
const GLOSSARY_SUFFIX = '.glossary.json';
// Structured editorial note (summary/decisions/actions/terms) the Notes
// view renders. Travels next to the trio so a second Mac reads the same
// AI note without re-running the pipeline. A sidecar (like glossary) so
// it stays out of the tightly-typed ArtifactKind trio.
const NOTE_SUFFIX = '.note.json';
const PREFIX = 'meet__';

export interface ArchiveMeta {
  eventId: string;
  title: string;
  // ms since epoch
  startedAt: number;
  endsAt?: number;
  // Which account's appdata holds the files.
  accountId: string;
  // ISO timestamp of the last upload run for this event.
  uploadedAt: string;
  // Per-kind sizes (after the upload completes). Lets the CLI report
  // existence without re-listing Drive.
  sizes: Partial<Record<ArtifactKind, number>>;
}

export interface ArchivedRecording {
  eventId: string;
  accountId: string;
  meta: ArchiveMeta | null;
  // Whether each kind is present on Drive RIGHT NOW.
  has: Record<ArtifactKind, boolean>;
  // Modified time (ISO) of the most recent file in the trio, used for
  // ordering "recent recordings" lists.
  modifiedAt: string | null;
}

function safeEventId(eventId: string): string {
  return eventId.replace(/[^A-Za-z0-9._@-]+/g, '-').slice(0, 200) || 'unknown';
}

// Recover the true recording start from the m4a filename stamp
// (`<YYYY-MM-DD_HHMM>__…`). record-meet.sh writes this once at capture time
// and never rewrites it, so it's the authoritative start — unlike a
// reprocess, which would otherwise stamp meta.json with "now". Returns ms
// since epoch (local time) or null when the name doesn't carry a stamp.
function startedAtFromAudioFile(audioFile: string | null | undefined): number | null {
  if (!audioFile) return null;
  const base = path.basename(audioFile).replace(/\.m4a$/i, '');
  const stamp = base.split('__')[0];
  const m = stamp.match(/^(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})$/);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  const dt = new Date(+y, +mo - 1, +d, +h, +mi);
  return Number.isNaN(dt.getTime()) ? null : dt.getTime();
}

function nameFor(eventId: string, kind: ArtifactKind): string {
  return `${PREFIX}${safeEventId(eventId)}${KIND_SUFFIX[kind]}`;
}

function metaNameFor(eventId: string): string {
  return `${PREFIX}${safeEventId(eventId)}${META_SUFFIX}`;
}

function glossaryNameFor(eventId: string): string {
  return `${PREFIX}${safeEventId(eventId)}${GLOSSARY_SUFFIX}`;
}

function noteNameFor(eventId: string): string {
  return `${PREFIX}${safeEventId(eventId)}${NOTE_SUFFIX}`;
}

// Reverse of nameFor — pull the eventIdSafe back out of a Drive filename.
// Returns null when the name doesn't match the meet__ shape (so list
// callers can ignore unrelated appdata files in the same bucket).
function parseName(name: string): { eventIdSafe: string; kind: ArtifactKind | 'meta' } | null {
  if (!name.startsWith(PREFIX)) return null;
  const body = name.slice(PREFIX.length);
  for (const [kind, suffix] of Object.entries(KIND_SUFFIX) as Array<[ArtifactKind, string]>) {
    if (body.endsWith(suffix)) {
      return { eventIdSafe: body.slice(0, -suffix.length), kind };
    }
  }
  if (body.endsWith(META_SUFFIX)) {
    return { eventIdSafe: body.slice(0, -META_SUFFIX.length), kind: 'meta' };
  }
  return null;
}

function cacheRoot(): string {
  return path.join(app.getPath('userData'), 'meeting-cache');
}

function cacheDir(eventId: string): string {
  return path.join(cacheRoot(), safeEventId(eventId));
}

function cachePath(eventId: string, kind: ArtifactKind): string {
  const file = kind === 'audio'
    ? 'audio.m4a'
    : kind === 'transcript'
      ? 'transcript.txt'
      : 'summary.md';
  return path.join(cacheDir(eventId), file);
}

function cacheMetaPath(eventId: string): string {
  return path.join(cacheDir(eventId), 'meta.json');
}

// Read the locally-cached meta.json for an event without any Drive
// round-trip. Used by the Notes view to resolve title/timing offline
// (the cache is seeded on every upload + fetch). Null when absent/unreadable.
export function readCachedMeta(eventId: string): ArchiveMeta | null {
  try {
    const p = cacheMetaPath(eventId);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as ArchiveMeta;
  } catch {
    return null;
  }
}

async function apiFor(accountId: string): Promise<DriveAppDataAPI> {
  const account = getAccount(accountId);
  if (!account) {
    throw new Error(
      `Account ${accountId} not found — re-add the account in Settings → Accounts.`,
    );
  }
  return new DriveAppDataAPI(authClientForAccount(account));
}

// ── Uploads ──────────────────────────────────────────────────────────────

export interface UploadInput {
  eventId: string;
  title: string;
  accountId: string;
  startedAt: number;
  endsAt?: number;
  audioFile?: string | null;
  transcriptFile?: string | null;
  summaryFile?: string | null;
  // When false, audio is skipped even if audioFile is provided.
  uploadAudio: boolean;
}

export interface UploadResult {
  uploaded: Partial<Record<ArtifactKind, { driveFileId: string; bytes: number }>>;
  meta: ArchiveMeta;
  errors: Partial<Record<ArtifactKind | 'meta', string>>;
}

// Upload whichever of {audio, transcript, summary} are present on disk
// to the event-owning account's appdata. Best-effort: a failure on one
// kind doesn't block the others. Writes meta.json last so a partial run
// is detectable by the absence of meta.
export async function uploadMeetingArtifacts(input: UploadInput): Promise<UploadResult> {
  const api = await apiFor(input.accountId);
  // Preserve the real meeting start across reprocesses. The filename stamp is
  // immutable (set at capture); fall back to any existing meta, then to the
  // caller's startedAt (correct for a first upload, "now" for a reprocess).
  const prevMeta = readCachedMeta(input.eventId);
  const startedAt = startedAtFromAudioFile(input.audioFile)
    ?? prevMeta?.startedAt ?? input.startedAt;
  const endsAt = input.endsAt ?? prevMeta?.endsAt;
  const result: UploadResult = {
    uploaded: {},
    meta: {
      eventId: input.eventId,
      title: input.title,
      startedAt,
      endsAt,
      accountId: input.accountId,
      uploadedAt: new Date().toISOString(),
      sizes: {},
    },
    errors: {},
  };

  const plan: Array<{ kind: ArtifactKind; file: string | null | undefined }> = [
    { kind: 'transcript', file: input.transcriptFile },
    { kind: 'summary', file: input.summaryFile },
    { kind: 'audio', file: input.uploadAudio ? input.audioFile : null },
  ];

  for (const { kind, file } of plan) {
    if (!file) continue;
    if (!fs.existsSync(file)) continue;
    try {
      const body = fs.readFileSync(file);
      const id = await api.upsert(nameFor(input.eventId, kind), body);
      result.uploaded[kind] = { driveFileId: id, bytes: body.length };
      result.meta.sizes[kind] = body.length;
    } catch (e) {
      result.errors[kind] = e instanceof Error ? e.message : String(e);
    }
  }

  // Write meta last so a partial upload doesn't leave fake "completed"
  // breadcrumbs. If meta fails, the artifacts are still readable; the
  // CLI listing will fall back to enumerating files by prefix.
  try {
    await api.upsert(metaNameFor(input.eventId), JSON.stringify(result.meta, null, 2));
  } catch (e) {
    result.errors.meta = e instanceof Error ? e.message : String(e);
  }

  // Pre-populate the local cache so reads right after an upload don't
  // need a round-trip. We stash the local file contents and the meta we
  // just uploaded.
  try {
    fs.mkdirSync(cacheDir(input.eventId), { recursive: true });
    for (const { kind, file } of plan) {
      if (!file) continue;
      if (!fs.existsSync(file)) continue;
      if (!result.uploaded[kind]) continue;
      fs.copyFileSync(file, cachePath(input.eventId, kind));
    }
    fs.writeFileSync(cacheMetaPath(input.eventId), JSON.stringify(result.meta, null, 2));
  } catch (e) {
    console.error('[yCal meetingArchive] cache seed failed', e);
  }

  return result;
}

// ── Reads ────────────────────────────────────────────────────────────────

// Fetch a single artifact from the event's account-archive into the local
// cache and return the cached path. Re-downloads when the Drive file's
// modifiedTime is newer than the cached copy's mtime. Throws when the
// file doesn't exist on Drive (callers want a hard failure so the UI
// surfaces "no transcript on Drive" instead of silently opening stale
// cache).
export async function fetchMeetingArtifact(
  eventId: string,
  accountId: string,
  kind: ArtifactKind,
): Promise<string> {
  const api = await apiFor(accountId);
  const name = nameFor(eventId, kind);
  const remote = await api.file(name);
  if (!remote?.id) {
    throw new Error(`No ${kind} on Drive for event ${eventId}.`);
  }
  fs.mkdirSync(cacheDir(eventId), { recursive: true });
  const local = cachePath(eventId, kind);
  // Skip the download if cached copy is at least as fresh as Drive's.
  if (fs.existsSync(local) && remote.modifiedTime) {
    try {
      const st = fs.statSync(local);
      if (st.mtimeMs >= Date.parse(remote.modifiedTime)) return local;
    } catch { /* fall through to re-download */ }
  }
  const buf = await api.read(remote.id);
  fs.writeFileSync(local, buf);
  if (remote.modifiedTime) {
    const t = Date.parse(remote.modifiedTime) / 1000;
    if (Number.isFinite(t)) {
      try { fs.utimesSync(local, t, t); } catch { /* mtime is advisory */ }
    }
  }
  return local;
}

// List a single event's archive across all known accounts. Used by the
// UI / CLI when we know the event id but want to find which account
// holds the recording (typical case: the renderer already has
// event.accountId from the CalendarEvent).
export async function listMeetingArchive(
  eventId: string,
  accountId: string,
): Promise<ArchivedRecording | null> {
  const api = await apiFor(accountId);
  // Two queries — one for the meta sidecar (cheap, gives us title +
  // timing), one for the artifact trio (so we know which kinds exist).
  // Drive's name filter accepts equality, so we list with the prefix
  // and post-filter to the safe id.
  const safe = safeEventId(eventId);
  const files = await api.list();
  let meta: ArchiveMeta | null = null;
  let modifiedAt: string | null = null;
  const has: Record<ArtifactKind, boolean> = {
    audio: false, transcript: false, summary: false,
  };
  for (const f of files) {
    const parsed = parseName(f.name);
    if (!parsed) continue;
    if (parsed.eventIdSafe !== safe) continue;
    if (parsed.kind === 'meta' && f.id) {
      try {
        const buf = await api.read(f.id);
        meta = JSON.parse(buf.toString('utf-8')) as ArchiveMeta;
      } catch { /* keep meta null */ }
    } else if (parsed.kind !== 'meta') {
      has[parsed.kind] = true;
    }
    if (f.modifiedTime && (!modifiedAt || f.modifiedTime > modifiedAt)) {
      modifiedAt = f.modifiedTime;
    }
  }
  if (!meta && !has.audio && !has.transcript && !has.summary) return null;
  return { eventId, accountId, meta, has, modifiedAt };
}

// Enumerate every meet__ entry across every signed-in account. Used by
// `ycal recordings` and the Settings → Recordings list to show meeting
// notes that have aged out of any in-memory cache. Returns one row per
// (eventId, accountId) pair.
export async function listAllMeetingArchives(): Promise<ArchivedRecording[]> {
  const out: ArchivedRecording[] = [];
  const accounts = listAccounts();
  // Walk accounts sequentially — fine for ≤ ~5 accounts and avoids
  // bursty token-refresh contention in google-auth-library.
  for (const acct of accounts) {
    try {
      const api = new DriveAppDataAPI(authClientForAccount(acct));
      const files = await api.list();
      const byEvent = new Map<string, AppDataFile[]>();
      for (const f of files) {
        const parsed = parseName(f.name);
        if (!parsed) continue;
        const arr = byEvent.get(parsed.eventIdSafe) ?? [];
        arr.push(f);
        byEvent.set(parsed.eventIdSafe, arr);
      }
      for (const [, group] of byEvent) {
        const has: Record<ArtifactKind, boolean> = {
          audio: false, transcript: false, summary: false,
        };
        let meta: ArchiveMeta | null = null;
        let modifiedAt: string | null = null;
        for (const f of group) {
          const parsed = parseName(f.name);
          if (!parsed) continue;
          if (parsed.kind === 'meta' && f.id) {
            try {
              const buf = await api.read(f.id);
              meta = JSON.parse(buf.toString('utf-8')) as ArchiveMeta;
            } catch { /* skip */ }
          } else if (parsed.kind !== 'meta') {
            has[parsed.kind] = true;
          }
          if (f.modifiedTime && (!modifiedAt || f.modifiedTime > modifiedAt)) {
            modifiedAt = f.modifiedTime;
          }
        }
        // eventId from the meta is the canonical (un-mangled) one. If meta
        // is missing, fall back to the eventIdSafe — best we can do.
        const eventId = meta?.eventId ?? group[0].name.slice(PREFIX.length).split('.')[0];
        out.push({ eventId, accountId: acct.id, meta, has, modifiedAt });
      }
    } catch (e) {
      console.error(`[yCal meetingArchive] list failed for ${acct.email}`, e);
    }
  }
  out.sort((a, b) => {
    const ta = a.modifiedAt ? Date.parse(a.modifiedAt) : 0;
    const tb = b.modifiedAt ? Date.parse(b.modifiedAt) : 0;
    return tb - ta;
  });
  return out;
}

// Per-event glossary sidecar push/pull. Lives on Drive next to
// audio/transcript/summary so a re-process on a second Mac sees the
// same name corrections the user made on the first one. Best-effort:
// failure is logged but never rethrown — the glossary still works
// locally even when Drive sync is unhappy.

export async function uploadEventGlossarySidecar(
  eventId: string, accountId: string, body: string,
): Promise<void> {
  try {
    const api = await apiFor(accountId);
    await api.upsert(glossaryNameFor(eventId), body);
  } catch (e) {
    console.error('[yCal meetingArchive] glossary sidecar upload failed', e);
  }
}

export async function fetchEventGlossarySidecar(
  eventId: string, accountId: string,
): Promise<string | null> {
  try {
    const api = await apiFor(accountId);
    const remote = await api.file(glossaryNameFor(eventId));
    if (!remote?.id) return null;
    const buf = await api.read(remote.id);
    return buf.toString('utf-8');
  } catch (e) {
    console.error('[yCal meetingArchive] glossary sidecar fetch failed', e);
    return null;
  }
}

// ── Structured-note sidecar (the Notes view's source of truth) ───────────
// Same best-effort posture as the glossary sidecar: push/pull the
// `note.json` next to the recording so the editorial note survives across
// Macs. Reads are cached locally so the Notes view works offline.

function cacheNotePath(eventId: string): string {
  return path.join(cacheDir(eventId), 'note.json');
}

export async function uploadMeetingNoteSidecar(
  eventId: string, accountId: string, body: string,
): Promise<void> {
  try {
    const api = await apiFor(accountId);
    await api.upsert(noteNameFor(eventId), body);
    try {
      fs.mkdirSync(cacheDir(eventId), { recursive: true });
      fs.writeFileSync(cacheNotePath(eventId), body);
    } catch { /* cache seed is best-effort */ }
  } catch (e) {
    console.error('[yCal meetingArchive] note sidecar upload failed', e);
  }
}

// Return the parsed note.json body (string), preferring the local cache
// when it's at least as fresh as Drive's copy. Null when neither has one.
export async function fetchMeetingNoteSidecar(
  eventId: string, accountId: string,
): Promise<string | null> {
  try {
    const api = await apiFor(accountId);
    const remote = await api.file(noteNameFor(eventId));
    if (!remote?.id) {
      // No Drive copy — fall back to any cached body from a prior fetch.
      const cached = cacheNotePath(eventId);
      return fs.existsSync(cached) ? fs.readFileSync(cached, 'utf-8') : null;
    }
    const cached = cacheNotePath(eventId);
    if (fs.existsSync(cached) && remote.modifiedTime) {
      try {
        const st = fs.statSync(cached);
        if (st.mtimeMs >= Date.parse(remote.modifiedTime)) {
          return fs.readFileSync(cached, 'utf-8');
        }
      } catch { /* fall through to re-download */ }
    }
    const buf = await api.read(remote.id);
    try {
      fs.mkdirSync(cacheDir(eventId), { recursive: true });
      fs.writeFileSync(cached, buf);
    } catch { /* best-effort */ }
    return buf.toString('utf-8');
  } catch (e) {
    console.error('[yCal meetingArchive] note sidecar fetch failed', e);
    const cached = cacheNotePath(eventId);
    try {
      return fs.existsSync(cached) ? fs.readFileSync(cached, 'utf-8') : null;
    } catch { return null; }
  }
}

// Resolve which account holds the archive for a given event id. Walks
// each account's appdata listing once, returns the first account whose
// listing contains a meet__<safeId>.* entry. Used by the CLI when the
// caller only gives us the eventId.
export async function findAccountForArchive(eventId: string): Promise<string | null> {
  const safe = safeEventId(eventId);
  const accounts = listAccounts();
  for (const acct of accounts) {
    try {
      const api = new DriveAppDataAPI(authClientForAccount(acct));
      const files = await api.list();
      for (const f of files) {
        const parsed = parseName(f.name);
        if (parsed?.eventIdSafe === safe) return acct.id;
      }
    } catch { /* try next account */ }
  }
  return null;
}
