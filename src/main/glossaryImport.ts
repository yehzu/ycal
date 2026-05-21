// Glossary import — accept JSON, markdown, or CSV and produce a list of
// GlossaryEntry rows. The user keeps their domain-specific glossary
// (e.g. GoFreight terminology) in whichever format suits their own
// workflow (Heptabase note, Confluence export, plain CSV) and imports
// it into yCal one-shot. Parsing is forgiving — missing fields fall
// back to defaults rather than aborting the whole import.

import { randomUUID } from 'node:crypto';
import type { GlossaryCategory, GlossaryEntry } from '@shared/types';

const VALID_CATEGORIES: GlossaryCategory[] = ['person', 'company', 'product', 'term', 'other'];

function normalizeCategory(raw: unknown): GlossaryCategory {
  if (typeof raw !== 'string') return 'other';
  const s = raw.trim().toLowerCase();
  if (VALID_CATEGORIES.includes(s as GlossaryCategory)) return s as GlossaryCategory;
  if (s === 'people' || s === 'name' || s === 'names') return 'person';
  if (s === 'companies' || s === 'org' || s === 'organisation' || s === 'organization') return 'company';
  if (s === 'products' || s === 'product/company') return 'product';
  if (s === 'terms' || s === 'jargon' || s === 'acronym' || s === 'acronyms') return 'term';
  return 'other';
}

function makeEntry(
  canonical: string,
  aliases: string[],
  category: GlossaryCategory = 'other',
): GlossaryEntry | null {
  const trimmed = canonical.trim();
  if (!trimmed) return null;
  const cleanedAliases = aliases
    .map((a) => a.trim())
    .filter((a) => a.length > 0 && a.toLowerCase() !== trimmed.toLowerCase());
  return {
    id: randomUUID(),
    canonical: trimmed,
    aliases: cleanedAliases,
    category,
    addedAt: Date.now(),
    source: 'import',
  };
}

// JSON: accepts either GlossaryFile shape, an array of entries, or a
// loose array of {canonical, aliases, category} objects.
function parseJson(body: string): GlossaryEntry[] {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch (e) {
    throw new Error(`invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  let rows: unknown[] = [];
  if (Array.isArray(data)) {
    rows = data;
  } else if (data && typeof data === 'object' && Array.isArray((data as { entries?: unknown[] }).entries)) {
    rows = (data as { entries: unknown[] }).entries;
  } else {
    throw new Error('JSON must be an array of entries or a {entries: [...]} object');
  }
  const out: GlossaryEntry[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const canonical = typeof r.canonical === 'string'
      ? r.canonical
      : typeof r.name === 'string'
        ? r.name
        : typeof r.term === 'string'
          ? r.term
          : '';
    const aliasesRaw = Array.isArray(r.aliases) ? r.aliases
      : Array.isArray(r.alias) ? r.alias
        : Array.isArray(r.misspellings) ? r.misspellings
          : [];
    const aliases = aliasesRaw.map((a) => (typeof a === 'string' ? a : '')).filter(Boolean);
    const entry = makeEntry(canonical, aliases, normalizeCategory(r.category));
    if (entry) out.push(entry);
  }
  return out;
}

// Markdown: H2 sections delineate categories; each list item is
// "Canonical :: alias1, alias2".
//
//   ## 人名
//   - Shawn Huang :: Sean, 順
//   - Tzu-Hui Yeh :: 慈惠
//
//   ## Companies
//   - GoFreight :: Go Freight, GoFlight
//
// Also accepts a "->" or "|" separator instead of "::" — first
// occurrence wins. A bare line with no separator is treated as a
// canonical with no aliases.
function parseMarkdown(body: string): GlossaryEntry[] {
  const out: GlossaryEntry[] = [];
  let currentCategory: GlossaryCategory = 'other';
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const heading = /^#{1,6}\s+(.+)$/.exec(line);
    if (heading) {
      currentCategory = normalizeCategory(heading[1]);
      continue;
    }
    const item = /^[-*+]\s+(.+)$/.exec(line);
    if (!item) continue;
    const body = item[1];
    const sepMatch = /(::|->|\|)/.exec(body);
    let canonical: string;
    let aliasPart = '';
    if (sepMatch) {
      const idx = sepMatch.index;
      canonical = body.slice(0, idx).trim();
      aliasPart = body.slice(idx + sepMatch[1].length).trim();
    } else {
      canonical = body.trim();
    }
    const aliases = aliasPart
      ? aliasPart.split(/[,/、，；;]/).map((a) => a.trim()).filter(Boolean)
      : [];
    const entry = makeEntry(canonical, aliases, currentCategory);
    if (entry) out.push(entry);
  }
  return out;
}

// CSV: `canonical,aliases,category` with `;`-separated aliases.
// First line may be a header — auto-detected by checking for the literal
// "canonical" in column 0.
function parseCsv(body: string): GlossaryEntry[] {
  const lines = body.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length === 0) return [];
  const out: GlossaryEntry[] = [];
  const looksLikeHeader = /\bcanonical\b/i.test(lines[0]);
  const start = looksLikeHeader ? 1 : 0;
  for (let i = start; i < lines.length; i += 1) {
    const cols = parseCsvLine(lines[i]);
    if (cols.length === 0) continue;
    const canonical = cols[0];
    const aliasPart = cols[1] ?? '';
    const categoryPart = cols[2] ?? '';
    const aliases = aliasPart.split(/[;|]/).map((a) => a.trim()).filter(Boolean);
    const entry = makeEntry(canonical, aliases, normalizeCategory(categoryPart));
    if (entry) out.push(entry);
  }
  return out;
}

// Minimal CSV line parser — handles quoted commas; not RFC 4180-complete
// but good enough for hand-edited glossary CSVs.
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

export type ImportFormat = 'json' | 'markdown' | 'csv' | 'auto';

// Sniff the body — `{` or `[` → JSON, leading `#` or `-` → markdown,
// comma in first line → CSV, else default to markdown.
function detectFormat(body: string): ImportFormat {
  const trimmed = body.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return 'json';
  const firstLine = trimmed.split(/\r?\n/, 1)[0] ?? '';
  if (firstLine.startsWith('#') || /^[-*+]\s/.test(firstLine)) return 'markdown';
  if (firstLine.includes(',')) return 'csv';
  return 'markdown';
}

export function parseGlossary(
  body: string, format: ImportFormat = 'auto',
): GlossaryEntry[] {
  const fmt = format === 'auto' ? detectFormat(body) : format;
  switch (fmt) {
    case 'json':
      return parseJson(body);
    case 'csv':
      return parseCsv(body);
    case 'markdown':
    default:
      return parseMarkdown(body);
  }
}
