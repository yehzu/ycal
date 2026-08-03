// yCal — Google Drive `appdata` REST client.
//
// Wraps just the few endpoints DriveSync needs:
//   list()         → enumerate files in the hidden per-app folder
//   read(fileId)   → read raw body bytes
//   upsert(name)   → create or update a file by name; returns the file id
//   delete(name)   → remove (only used for cleanup)
//
// `appdata` = the hidden folder Google Drive provides every app that asks
// for the `drive.appdata` scope. Files there are NOT visible at
// drive.google.com — only this app sees them. The same folder is
// addressable from iOS yCal with the same OAuth client (different
// installed-app credentials, same Cloud project, same appdata bucket).

import { google, type drive_v3 } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import { NETWORK_TIMEOUT_MS, withNetworkTimeout } from './networkTimeout';
import { rlog } from './recorderLog';

export interface AppDataFile {
  id: string;
  name: string;
  size?: string;
  modifiedTime?: string;
}

// Ceiling on how many pages list() will follow. At Drive's max pageSize
// of 1000 this is 100k files — orders of magnitude past any real appdata
// bucket, so reaching it means something is wrong rather than big.
const MAX_LIST_PAGES = 100;

export class DriveAppDataAPI {
  private drive: drive_v3.Drive;
  constructor(auth: OAuth2Client) {
    this.drive = google.drive({ version: 'v3', auth });
  }

  // Enumerate the WHOLE appdata bucket, following Drive's pagination.
  // This used to take the first page only ("yCal writes ≤ 6 files") — but
  // meeting archives put up to 6 files in here per recorded event, so the
  // bucket is hundreds of files deep. A single page silently truncated the
  // listing: recordings past the cut vanished from the Notes view and
  // `ycal recordings`, and driveSync could stop seeing settings.json.
  // Every caller expects the complete set, so page until Drive stops
  // handing back a token.
  async list(): Promise<AppDataFile[]> {
    const out: AppDataFile[] = [];
    let pageToken: string | undefined;
    let pages = 0;
    // Belt-and-braces against a server that keeps handing back a token:
    // 1000 files/page × 100 pages is far beyond any real appdata bucket.
    while (pages < MAX_LIST_PAGES) {
      const res = await withNetworkTimeout('drive.list', () =>
        this.drive.files.list(
          {
            // 1000 is Drive's maximum page size — fewest round trips.
            pageSize: 1000,
            spaces: 'appDataFolder',
            pageToken,
            fields: 'nextPageToken, files(id, name, size, modifiedTime)',
          },
          { timeout: NETWORK_TIMEOUT_MS },
        ),
      );
      out.push(...((res.data.files ?? []) as AppDataFile[]));
      pages += 1;
      pageToken = res.data.nextPageToken ?? undefined;
      if (!pageToken) break;
    }
    // Hitting the cap means we're handing back a TRUNCATED listing — the
    // exact failure mode this method was rewritten to eliminate, so it
    // must not be silent. Deliberately a warn and not a throw: every
    // caller is written to tolerate a degraded/offline listing, and
    // failing the whole Notes view over this would be worse than showing
    // most of it. If this ever fires, the cap (or the query) is wrong.
    //
    // console.warn alone is not reachable evidence: this runs in the
    // Electron main process, which the GUI starts via `open -g -a` with no
    // attached terminal, and the CLI path swaps in its own StringSink. So
    // also append to ~/Library/Logs/yCal/recorder.log, which outlives the
    // launch that produced it and is somewhere a user can be pointed at.
    if (pageToken) {
      const msg =
        `[yCal driveAppData] appdata listing truncated at ${pages} pages / `
        + `${out.length} files — Drive still had more. Callers are seeing an `
        + 'INCOMPLETE listing; raise MAX_LIST_PAGES.';
      console.warn(msg);
      rlog(msg);
    }
    return out;
  }

  async file(name: string): Promise<AppDataFile | null> {
    const res = await withNetworkTimeout(`drive.file(${name})`, () =>
      this.drive.files.list(
        {
          spaces: 'appDataFolder',
          pageSize: 10,
          // Drive query language: name='settings.json' AND space='appDataFolder'
          // (the spaces param above already constrains the space, but Drive
          // accepts the name filter too).
          q: `name='${name.replace(/'/g, "\\'")}'`,
          fields: 'files(id, name, size, modifiedTime)',
        },
        { timeout: NETWORK_TIMEOUT_MS },
      ),
    );
    const files = (res.data.files ?? []) as AppDataFile[];
    return files[0] ?? null;
  }

  async read(fileId: string): Promise<Buffer> {
    // alt=media downloads the raw body; default returns metadata.
    const res = await withNetworkTimeout(`drive.read(${fileId})`, () =>
      this.drive.files.get(
        { fileId, alt: 'media' },
        { responseType: 'arraybuffer', timeout: NETWORK_TIMEOUT_MS },
      ),
    );
    // googleapis types `data` as unknown for arraybuffer responses; the
    // runtime value is the raw bytes.
    return Buffer.from(res.data as ArrayBuffer);
  }

  /// Create-if-missing-or-update-existing on `name`. Returns the resulting
  /// file id. Mirrors iOS DriveAppDataAPI's `upsert(name:body:)`.
  async upsert(name: string, body: Buffer | string): Promise<string> {
    const existing = await this.file(name);
    const media = {
      // Google's mime guesser is forgiving here — we use generic types so
      // syncing tasks.md (text/markdown) and *.json works without us
      // computing it from the suffix.
      mimeType: name.endsWith('.json') ? 'application/json' : 'text/plain',
      body: typeof body === 'string'
        ? body
        : require('node:stream').Readable.from(body),
    };
    if (existing?.id) {
      const res = await withNetworkTimeout(`drive.update(${name})`, () =>
        this.drive.files.update(
          {
            fileId: existing.id,
            media,
            fields: 'id',
          },
          { timeout: NETWORK_TIMEOUT_MS },
        ),
      );
      return existing.id ?? (res.data.id ?? '');
    }
    const res = await withNetworkTimeout(`drive.create(${name})`, () =>
      this.drive.files.create(
        {
          requestBody: {
            name,
            // The magic string that places the file in the hidden app folder.
            // Without this the file lands in the user's main Drive.
            parents: ['appDataFolder'],
          },
          media,
          fields: 'id',
        },
        { timeout: NETWORK_TIMEOUT_MS },
      ),
    );
    if (!res.data.id) throw new Error('Drive create returned no file id');
    return res.data.id;
  }

  async delete(fileId: string): Promise<void> {
    await withNetworkTimeout(`drive.delete(${fileId})`, () =>
      this.drive.files.delete({ fileId }, { timeout: NETWORK_TIMEOUT_MS }),
    );
  }
}
