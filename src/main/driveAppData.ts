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

export interface AppDataFile {
  id: string;
  name: string;
  size?: string;
  modifiedTime?: string;
}

export class DriveAppDataAPI {
  private drive: drive_v3.Drive;
  constructor(auth: OAuth2Client) {
    this.drive = google.drive({ version: 'v3', auth });
  }

  async list(): Promise<AppDataFile[]> {
    const res = await this.drive.files.list({
      spaces: 'appDataFolder',
      // pageSize defaults to 100. yCal writes ≤ 6 files; one page is
      // plenty. If we ever blow past, paginate.
      pageSize: 100,
      fields: 'files(id, name, size, modifiedTime)',
    });
    return (res.data.files ?? []) as AppDataFile[];
  }

  async file(name: string): Promise<AppDataFile | null> {
    const res = await this.drive.files.list({
      spaces: 'appDataFolder',
      pageSize: 10,
      // Drive query language: name='settings.json' AND space='appDataFolder'
      // (the spaces param above already constrains the space, but Drive
      // accepts the name filter too).
      q: `name='${name.replace(/'/g, "\\'")}'`,
      fields: 'files(id, name, size, modifiedTime)',
    });
    const files = (res.data.files ?? []) as AppDataFile[];
    return files[0] ?? null;
  }

  async read(fileId: string): Promise<Buffer> {
    // alt=media downloads the raw body; default returns metadata.
    const res = await this.drive.files.get(
      { fileId, alt: 'media' },
      { responseType: 'arraybuffer' },
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
      const res = await this.drive.files.update({
        fileId: existing.id,
        media,
        fields: 'id',
      });
      return existing.id ?? (res.data.id ?? '');
    }
    const res = await this.drive.files.create({
      requestBody: {
        name,
        // The magic string that places the file in the hidden app folder.
        // Without this the file lands in the user's main Drive.
        parents: ['appDataFolder'],
      },
      media,
      fields: 'id',
    });
    if (!res.data.id) throw new Error('Drive create returned no file id');
    return res.data.id;
  }

  async delete(fileId: string): Promise<void> {
    await this.drive.files.delete({ fileId });
  }
}
