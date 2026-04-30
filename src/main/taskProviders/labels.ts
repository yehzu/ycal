// yCal — Troika-style label parser.
//
// In the user's Troika system, labels carry the calendar-relevant metadata
// for each task. We don't try to enumerate every label they might use —
// we recognise three patterns and let everything else fall through to
// `location` (in Troika, most labels tag *where* a task happens — e.g.
// `home`, `office`, `cafe`, `gym`, `desk`).
//
// Patterns we recognise on a label:
//
//   • Duration:    "30m"  "1h"  "1h30m"  "1h30"  (optional `~` prefix)
//   • Energy:      "low" | "mid" | "high"  (optional `-energy` suffix)
//   • Anything else → location (first such label wins)
//
// We also keep the legacy yCal inline tags working so users mid-migration
// don't lose chips: `~30m` / `@cafe` / `[high]` inside the title or
// description still get picked up. Inline tags are stripped from the
// rendered title when found.

const ENERGY_LABEL = /^(low|mid|high)(?:[-_ ]?energy)?$/i;
const DUR_INLINE = /(?:^|\s)~(\d+)h(?:(\d+)m)?\b|(?:^|\s)~(\d+)([hm])\b/i;
const LOC_INLINE = /(?:^|\s)@([^\n#@]+?)(?=$|\s\s|\s#)/;
const ENERGY_INLINE = /(?:^|\s)\[(low|mid|high)\]/i;

export interface ParsedTaskMeta {
  /** Cleaned title — inline `~30m` / `@cafe` / `[high]` chunks stripped. */
  title: string;
  durMin: number;
  energy: 'low' | 'mid' | 'high';
  location: string;
}

// Parse a single label as a duration. Returns 0 when the label isn't a
// duration shape — caller routes non-durations to other classifiers.
function parseDurLabel(lbl: string): number {
  // Must mention `h` or `m`; pure numbers are rejected so a "2026" label
  // doesn't accidentally become 2026 minutes.
  if (!/[hm]/i.test(lbl)) return 0;
  const s = lbl.replace(/^~/, '').toLowerCase();
  const m = s.match(/^(?:(\d+)h)?(\d+)?m?$/);
  if (!m) return 0;
  const h = parseInt(m[1] ?? '0', 10) || 0;
  const mins = parseInt(m[2] ?? '0', 10) || 0;
  const total = h * 60 + mins;
  return total > 0 ? total : 0;
}

export function parseTaskMeta(
  rawTitle: string,
  description: string,
  labels: string[],
): ParsedTaskMeta {
  let title = rawTitle;
  let durMin = 0;
  let energy: 'low' | 'mid' | 'high' = 'mid';
  let location = '';

  for (const raw of labels) {
    const lbl = raw.trim();
    if (!lbl) continue;

    if (durMin === 0) {
      const d = parseDurLabel(lbl);
      if (d > 0) { durMin = d; continue; }
    }
    if (energy === 'mid') {
      const e = lbl.match(ENERGY_LABEL);
      if (e) { energy = e[1].toLowerCase() as 'low' | 'mid' | 'high'; continue; }
    }
    if (!location) location = lbl;
  }

  // Inline fallbacks for users still tagging in the title/description.
  if (durMin === 0) {
    const m = title.match(DUR_INLINE);
    if (m) {
      const h1 = parseInt(m[1] ?? '0', 10) || 0;
      const m1 = parseInt(m[2] ?? '0', 10) || 0;
      const n2 = parseInt(m[3] ?? '0', 10) || 0;
      const u2 = (m[4] ?? '').toLowerCase();
      durMin = h1 > 0 ? h1 * 60 + m1 : (u2 === 'h' ? n2 * 60 : n2);
      title = title.replace(m[0], '');
    }
  }
  if (energy === 'mid') {
    const m = title.match(ENERGY_INLINE) ?? description.match(ENERGY_INLINE);
    if (m) {
      energy = m[1].toLowerCase() as 'low' | 'mid' | 'high';
      title = title.replace(ENERGY_INLINE, '');
    }
  }
  if (!location) {
    const m = title.match(LOC_INLINE) ?? description.match(LOC_INLINE);
    if (m) {
      location = m[1].trim();
      title = title.replace(LOC_INLINE, '');
    }
  }

  return { title: title.trim(), durMin, energy, location };
}
