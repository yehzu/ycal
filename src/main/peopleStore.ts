// yCal — People directory.
//
// A simple plaintext map of email → { name, title } that the recorder
// uses to enrich the attendee context fed to Claude's summary prompt.
// "Name" comes from Google Calendar's attendee list by default; the
// directory lets the user override it AND add a job title that Claude
// can use for attribution in the meeting note.
//
// File: people.md, cloudStore-routed (follows the user across Macs).
// Format: one record per line, pipe-separated.
//
//   email@domain.com | Display Name | Title or role
//   short@domain.com | | Just a title  (skip name)
//
// Comments and blank lines are ignored. Lines without a recognizable
// email are silently dropped — the file stays human-editable without
// breaking parsing.
//
// The format is deliberately not JSON/YAML — the user is meant to
// edit this in a textarea inside yCal's Settings → Recording, and a
// flat plaintext is easier to scan and dedup-edit than a structured
// document.

import { readText, writeText } from './cloudStore';

const FILE_NAME = 'people.md';

export interface PersonRecord {
  email: string;
  name: string | null;
  title: string | null;
}

const DEFAULT_TEMPLATE = `# yCal People Directory
#
# One person per line, fields separated by ' | ':
#
#   email@domain.com | Display Name | Title or role
#
# Lines starting with # are ignored. Both name and title are optional;
# leave the cell empty to skip one and the other still binds. The
# directory is used by the meeting recorder to give Claude a sharper
# picture of who's in the room when it drafts the summary.
#
# Example:
#   alex@example.com  | Alex Chen | Engineering Manager
#   sam@example.com   | Sam Smith | Product Manager
`;

export function loadPeopleText(): string {
  return readText(FILE_NAME, DEFAULT_TEMPLATE);
}

export function savePeopleText(body: string): void {
  writeText(FILE_NAME, body);
}

// Parse the people.md body into a map keyed by lower-cased email.
// Returns an empty map for missing / empty file.
export function parsePeople(body: string): Map<string, PersonRecord> {
  const out = new Map<string, PersonRecord>();
  if (!body) return out;
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const cols = line.split('|').map((c) => c.trim());
    const email = cols[0]?.toLowerCase();
    if (!email || !email.includes('@')) continue;
    const name = cols[1] && cols[1].length > 0 ? cols[1] : null;
    const title = cols[2] && cols[2].length > 0 ? cols[2] : null;
    if (!name && !title) continue; // nothing to record
    out.set(email, { email, name, title });
  }
  return out;
}

// Convenience for the recorder: look up one email, returns null if
// the directory has no entry for it. Reads the file each time — the
// directory is small (typically <50 entries) and the recorder hits
// this only once per recording start, so caching isn't worth it.
export function lookupPerson(email: string | null | undefined): PersonRecord | null {
  if (!email) return null;
  const map = parsePeople(loadPeopleText());
  return map.get(email.toLowerCase()) ?? null;
}
