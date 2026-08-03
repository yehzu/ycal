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
//
// The two halves of that cache prove freshness DIFFERENTLY, and the
// difference is load-bearing:
//   • artifacts (audio/transcript/summary) — file mtime, which
//     fetchMeetingArtifact() aligns to Drive via utimesSync on download.
//   • meta.json — the `_driveModifiedTime` field inside the body, because
//     uploadMeetingArtifacts() also writes this file and does NOT align
//     its mtime, so mtime here means "when this Mac wrote it".
// See the CACHE_DRIVE_MTIME_KEY block below.
//
// WRITERS of <eventIdSafe>/meta.json — there are two, and the second one
// is easy to miss when debugging a wrong title or date:
//   1. uploadMeetingArtifacts(), at the end of every upload.
//   2. listAllMeetingArchives() pass 2, on every cache miss — i.e. any
//      `ycal recordings` or Notes-view refresh can rewrite this file.
// Because the directory is keyed by event id with no account component,
// (2) is ownership-gated so two accounts holding the same event can't
// flip the body back and forth. See cacheClaimedByOtherAccount.

import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

import { authClientForAccount } from './auth';
import { getAccount, listAccounts } from './tokenStore';
import { DriveAppDataAPI, type AppDataFile } from './driveAppData';
import { rlog } from './recorderLog';

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

// ── Cached-meta freshness ────────────────────────────────────────────────
//
// The cached meta.json doubles as the read-through cache for
// listAllMeetingArchives()'s second pass, which is ~87% of that call's wall
// clock (one `files.get?alt=media` per meeting).
//
// Freshness is decided by a field INSIDE the cached body, never by the
// file's mtime. uploadMeetingArtifacts() writes this same path at upload
// time and does NOT align its mtime to Drive (unlike fetchMeetingArtifact,
// which utimesSync()s the artifact files it downloads) — so an existing
// cached meta.json's mtime is "when this Mac last uploaded", which says
// nothing about the Drive copy. Comparing it would produce confident wrong
// answers in both directions.
//
// What we store instead is the Drive `modifiedTime` the body was
// downloaded from. It costs nothing extra: the appdata listing in pass 1
// already asks for `modifiedTime` (driveAppData.list fields) — it was
// simply being dropped on the floor.
//
// Wire format — a superset of ArchiveMeta; the extra key is local-only and
// is never uploaded to Drive:
//
//   { …ArchiveMeta…, "_driveModifiedTime": "2026-07-31T03:01:38.772Z" }
//
// Bodies written before this key existed simply lack it. Those are a MISS
// (fetched from Drive once, then rewritten in the new shape) — never an
// error, and never deleted. readCachedMeta() above keeps working on both
// shapes because the extra key is additive and no consumer enumerates.
const CACHE_DRIVE_MTIME_KEY = '_driveModifiedTime';

interface StampedCachedMeta {
  // Already stripped of the local-only key — see readStampedCachedMeta.
  meta: ArchiveMeta;
  driveModifiedTime: string | null;
}

// `eventIdSafe` — the already-sanitised id used as the cache directory
// name. safeEventId() is idempotent over its own output, so passing it
// back through cacheMetaPath() lands on the same directory an upload or a
// fetch would have written.
function readStampedCachedMeta(eventIdSafe: string): StampedCachedMeta | null {
  try {
    const p = cacheMetaPath(eventIdSafe);
    if (!fs.existsSync(p)) return null;
    const parsed: unknown = JSON.parse(fs.readFileSync(p, 'utf-8'));
    // A non-object body (null / array / scalar) is a corrupt cache, not a
    // meta. Treat as a miss; the Drive read will overwrite it.
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    // Strip the local-only key here, at the ONE place that produces a typed
    // ArchiveMeta out of a cached body, so what callers hold matches its
    // type — nothing downstream can round-trip our bookkeeping back up to
    // Drive via a `JSON.stringify(meta)` + `upsert`, and nothing has to
    // remember to strip it. Today's callers happen to be safe; the type
    // system would not have caught tomorrow's.
    //
    // This is NOT the only reader of the file. Two others parse the same
    // meta.json and neither strips the key: readCachedMeta() (:174), which
    // hands the raw body back cast as ArchiveMeta, and
    // resolveOriginalStartedAt() (meetRecorder.ts:556-560), which reads
    // startedAt straight out of a JSON.parse. Both are safe today only
    // because they pick individual fields and never re-serialise the body.
    const { [CACHE_DRIVE_MTIME_KEY]: stamp, ...meta } = parsed as Record<string, unknown>;
    return {
      meta: meta as unknown as ArchiveMeta,
      driveModifiedTime: typeof stamp === 'string' && stamp ? stamp : null,
    };
  } catch {
    return null;
  }
}

// ── One cache directory, possibly two accounts ───────────────────────────
//
// cacheDir() keys on eventIdSafe ALONE — there is no account component
// (see :154). When the same event is archived under two signed-in
// accounts, both rows in a listing resolve to the SAME meta.json.
//
// That was harmless while uploadMeetingArtifacts() was the only writer:
// a listing read the file and never moved it. Pass 2 writing it changes
// that, and an unguarded write would flip the body between accounts on
// every single listing. This file is not scratch space — it is what the
// Notes view renders via readCachedMeta() (notesStore.ts:608/:744), and
// what uploadMeetingArtifacts() reads back as `prevMeta` to inherit
// startedAt/endsAt from and then re-uploads to Drive. A flip is therefore
// a path from local cache into Drive data, and it did not exist before.
//
// The rule: whichever account's body is on disk owns the file. The other
// account reads Drive every time and writes nothing. Ownership comes from
// the body's own `accountId` — already part of ArchiveMeta, so no second
// stamp field is needed.
//
// An absent/blank owner means unclaimed (legacy or hand-edited), but
// "unclaimed" is weaker than it sounds, because this guard only gates the
// listing's write-back. A takeover needs the row to MISS: the hit branch
// returns the cached body before it ever reaches the write. So an
// unclaimed body that is stamped AND whose stamp still equals Drive's
// modifiedTime is served to every account as-is and never rewritten;
// takeover happens on the first miss, i.e. an unstamped body, or a stamp
// Drive has since moved past.
//
// And a takeover writes the Drive body verbatim, so the new owner is THAT
// body's own `accountId` — not, by construction, the account whose
// listing performed the write. The two coincide in practice only because
// the row was enumerated out of this account's own appdata, so the
// sidecar it just downloaded is one this account uploaded.
//
// The one exception to all of the above: uploadMeetingArtifacts() writes
// this file without consulting this guard at all, so an upload ALWAYS
// takes ownership. That is deliberate — the account that just uploaded is
// the freshest source of truth for the body, and that write is the only
// mechanism that ever TRANSFERS a claim. It is not the only way a claim
// ends, though: deleteMeetingArchive() (:874) rmSync's the whole cache
// directory unconditionally, claim included — so deleting a meeting held
// by account A leaves the next listing under account B free to miss and
// claim it.
function cacheClaimedByOtherAccount(
  cached: StampedCachedMeta | null,
  accountId: string,
): boolean {
  const owner = cached?.meta?.accountId;
  return typeof owner === 'string' && owner.length > 0 && owner !== accountId;
}

// EQUALITY, not "cached >= remote". We recorded the exact modifiedTime we
// downloaded from, so any change at all — newer, or a rollback that made
// Drive's copy older — has to invalidate. Compare the raw strings first,
// then the parsed instants, so a formatting change in Drive's RFC-3339
// output doesn't cause a permanent false miss.
function sameDriveTime(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  return Number.isFinite(ta) && Number.isFinite(tb) && ta === tb;
}

// The single writer of meta.json. BOTH writers go through here — the
// listing write-back (writeStampedCachedMeta, just below) and
// uploadMeetingArtifacts()'s cache seed — so every write is temp + rename,
// which is atomic within a directory on APFS.
//
// The readers are spread across processes that overlap:
// listAllMeetingArchives() has four entry points (cli.ts:829 and :898,
// index.ts:762, notesStore.ts:768) across the GUI and the CLI, and an
// upload can be running beside any of them. A plain writeFileSync lets a
// reader see a half-serialised body, and the failure is quiet and nasty
// because every reader's catch turns a parse error into "no cache":
//
//   - in a listing the row degrades to "Untitled meeting", so the symptom
//     is a title that vanishes now and then and never reproduces;
//   - in uploadMeetingArtifacts() the torn read nulls `prevMeta`, so
//     startedAt falls through to the caller's value — "now" on a
//     reprocess — and that wrong startedAt is then upserted to Drive. A
//     tear in the local cache escapes into Drive's copy of the meeting.
//
// The temp name carries the pid so two writers don't collide on the temp
// file either. Throws (after removing the temp) so each caller keeps its
// own failure policy.
function writeCacheMetaAtomic(eventIdSafe: string, body: unknown): void {
  const final = cacheMetaPath(eventIdSafe);
  const tmp = `${final}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(cacheDir(eventIdSafe), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(body, null, 2));
    fs.renameSync(tmp, final);
  } catch (e) {
    // Don't leave a temp behind when the rename (or the write) failed.
    try { fs.rmSync(tmp, { force: true }); } catch { /* nothing left to do */ }
    throw e;
  }
}

// Best-effort: a cache we can't write is a slow next run, never a failed
// listing, so this swallows everything.
function writeStampedCachedMeta(
  eventIdSafe: string,
  meta: unknown,
  driveModifiedTime: string,
): void {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return;
  try {
    writeCacheMetaAtomic(eventIdSafe, {
      ...(meta as Record<string, unknown>),
      [CACHE_DRIVE_MTIME_KEY]: driveModifiedTime,
    });
  } catch { /* see above — a failed cache write is never a failed listing */ }
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
    // Deliberately written WITHOUT the _driveModifiedTime stamp: upsert()
    // hands back only a file id, so we don't know what modifiedTime Drive
    // just assigned. An unstamped body is a cache miss by construction, so
    // the next listing re-reads this one sidecar and rewrites it stamped.
    // One extra round trip per freshly uploaded recording is the correct
    // trade against guessing a timestamp we never saw.
    //
    // Still temp + rename: a listing in another process reads this same
    // path, and so does the `prevMeta` read at the top of this function.
    // See writeCacheMetaAtomic.
    writeCacheMetaAtomic(input.eventId, result.meta);
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

// How many meta sidecars we pull from one account at a time. The meta
// bodies are the only part of a listing that can't be answered from file
// names + list metadata, so they're the whole network cost of the
// listing. 6 keeps us well inside Drive's per-user rate limit and bounds
// the open-socket count, while collapsing what used to be one 10s-timeout
// round trip per event into a handful of waves. The access token is
// already warm by this point (api.list() just refreshed it), so the
// parallel reads don't stampede google-auth-library's refresh path.
const META_FETCH_CONCURRENCY = 6;

// Run `fn` over `items` with at most `limit` in flight, preserving order
// in the result array. `limit` is clamped to at least 1: a 0-or-negative
// limit would spawn zero workers, resolve instantly and hand back an
// array of holes typed as R — and tsconfig.node.json has no
// noUncheckedIndexedAccess, so nothing downstream would catch it. Slow
// beats silently wrong.
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const workerCount = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
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
      // Pass 1 — everything derivable from file names and the list
      // metadata. No network at all.
      const rows = [] as Array<{
        has: Record<ArtifactKind, boolean>;
        modifiedAt: string | null;
        // Usually 0 or 1. Can be >1: Drive appdata permits duplicate
        // names and upsert() has no atomic create-if-absent (it does a
        // file(name) lookup then create), so a GUI upload racing a
        // reprocess can leave two meet__<id>.meta.json behind.
        //
        // Each entry carries the sidecar's Drive modifiedTime alongside
        // its id — the listing already fetched it, and pass 2 needs it to
        // decide whether the local cache is still valid.
        metaFiles: Array<{ id: string; modifiedTime: string | null }>;
        // Map key: the sanitised id, which is also the meeting-cache
        // directory name. Distinct from fallbackEventId, which truncates
        // at the first `.`.
        eventIdSafe: string;
        fallbackEventId: string;
      }>;
      for (const [eventIdSafe, group] of byEvent) {
        const has: Record<ArtifactKind, boolean> = {
          audio: false, transcript: false, summary: false,
        };
        let modifiedAt: string | null = null;
        const metaFiles: Array<{ id: string; modifiedTime: string | null }> = [];
        for (const f of group) {
          const parsed = parseName(f.name);
          if (!parsed) continue;
          if (parsed.kind === 'meta') {
            if (f.id) metaFiles.push({ id: f.id, modifiedTime: f.modifiedTime ?? null });
          } else {
            has[parsed.kind] = true;
          }
          if (f.modifiedTime && (!modifiedAt || f.modifiedTime > modifiedAt)) {
            modifiedAt = f.modifiedTime;
          }
        }
        rows.push({
          has,
          modifiedAt,
          metaFiles,
          eventIdSafe,
          // eventIdSafe — best we can do when the meta sidecar is missing.
          fallbackEventId: group[0].name.slice(PREFIX.length).split('.')[0],
        });
      }

      // Pass 2 — the meta sidecars, read through the local meeting-cache
      // and only then, on a miss, from Drive in bounded-parallel waves.
      // The list UI reads meta.title / .startedAt / .endsAt on every row,
      // so we can't defer these to click time; and one alt=media GET per
      // meeting is the entire cost of this call in practice.
      //
      // Within a row the sidecars are still tried IN ORDER and the last
      // one that both downloads and parses wins — a duplicate whose read
      // or JSON.parse fails must not clobber a sibling that worked. The
      // parallelism is across rows, never inside one.
      let lastMetaError: unknown = null;
      const metas = await mapWithConcurrency(
        rows,
        META_FETCH_CONCURRENCY,
        async (r): Promise<{ meta: ArchiveMeta | null; failed: number }> => {
          // The cache can only speak for the single-sidecar case. With
          // zero there is nothing to read; with two-or-more, "try in
          // order, last one that downloads AND parses wins" is the only
          // rule that produces the right answer, and one cached body
          // can't stand in for it — so duplicates always go to Drive and
          // keep their existing four-combination behaviour exactly.
          const only = r.metaFiles.length === 1 ? r.metaFiles[0] : null;
          const cached = only ? readStampedCachedMeta(r.eventIdSafe) : null;
          // Another account already owns this event's cache directory —
          // read Drive and leave the file alone, for BOTH the hit and the
          // write below. See cacheClaimedByOtherAccount.
          const claimedByOther = cacheClaimedByOtherAccount(cached, acct.id);
          if (only?.modifiedTime && cached && !claimedByOther
              && sameDriveTime(cached.driveModifiedTime, only.modifiedTime)) {
            return { meta: cached.meta, failed: 0 };
          }
          let meta: ArchiveMeta | null = null;
          let failed = 0;
          for (const f of r.metaFiles) {
            try {
              const buf = await api.read(f.id);
              const parsed = JSON.parse(buf.toString('utf-8')) as ArchiveMeta;
              meta = parsed;
              // Write back only for the single-sidecar shape — a stamped
              // body for a duplicated row would never be consulted anyway.
              if (only && f.modifiedTime && !claimedByOther) {
                writeStampedCachedMeta(r.eventIdSafe, parsed, f.modifiedTime);
              }
            } catch (e) {
              failed += 1;
              lastMetaError = e;
            }
          }
          return { meta, failed };
        },
      );

      // A meta read that fails degrades its row to "Untitled meeting",
      // startedAt null, and a sort to the bottom of the Notes list. One
      // of those is noise; a rate-limit or auth failure takes out dozens
      // at once and used to do it in complete silence. Surface the count
      // (once per account) with a sample cause so it's diagnosable.
      //
      // console.warn goes to the main process's stderr, which nobody sees:
      // the GUI is launched detached via `open -g -a` and the CLI path
      // redirects its own sinks. Mirror it into
      // ~/Library/Logs/yCal/recorder.log so the degradation is still
      // discoverable after the fact.
      const failedReads = metas.reduce((n, m) => n + m.failed, 0);
      const degradedRows = metas.filter((m, i) => !m.meta && rows[i].metaFiles.length > 0).length;
      if (failedReads > 0) {
        const msg =
          `[yCal meetingArchive] ${failedReads} meta sidecar read(s) failed for `
          + `${acct.email}; ${degradedRows}/${rows.length} recordings will show `
          + 'without a title or date. Sample cause:';
        console.warn(msg, lastMetaError);
        rlog(msg, lastMetaError);
      }

      rows.forEach((r, i) => {
        const { meta } = metas[i];
        out.push({
          // eventId from the meta is the canonical (un-mangled) one.
          eventId: meta?.eventId ?? r.fallbackEventId,
          accountId: acct.id,
          meta,
          has: r.has,
          modifiedAt: r.modifiedAt,
        });
      });
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

// Permanently delete a meeting's entire archive: every `meet__<eventId>.*`
// file in the account's appdata (audio / transcript / summary / meta /
// glossary / note sidecars) plus the local meeting-cache directory. The
// cache is always cleared (so the note stops showing even offline); Drive
// deletion is best-effort. accountId is optional — when absent we resolve
// the owning account first. A prefix match (`meet__<safe>.`) is used rather
// than parseName so the glossary + note sidecars are caught too; the
// trailing `.` prevents a shorter id from matching a longer one's files.
export async function deleteMeetingArchive(
  eventId: string,
  accountId?: string | null,
): Promise<{ driveDeleted: number; error?: string }> {
  try { fs.rmSync(cacheDir(eventId), { recursive: true, force: true }); } catch { /* best-effort */ }

  let acct = accountId ?? null;
  if (!acct) {
    try { acct = await findAccountForArchive(eventId); } catch { /* offline / none */ }
  }
  if (!acct) return { driveDeleted: 0 };

  const safe = safeEventId(eventId);
  const prefix = `${PREFIX}${safe}.`;
  try {
    const api = await apiFor(acct);
    const files = await api.list();
    let driveDeleted = 0;
    for (const f of files) {
      if (!f.id) continue;
      if (!f.name.startsWith(prefix)) continue;
      try { await api.delete(f.id); driveDeleted += 1; } catch { /* skip one, keep going */ }
    }
    return { driveDeleted };
  } catch (e) {
    return { driveDeleted: 0, error: e instanceof Error ? e.message : String(e) };
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
