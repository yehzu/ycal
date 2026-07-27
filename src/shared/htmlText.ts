const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: ' ',
  quot: '"',
};

function decodeHtmlEntities(value: string): string {
  return value.replace(
    /&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi,
    (match, decimal: string | undefined, hex: string | undefined, named: string | undefined) => {
      if (named) return NAMED_ENTITIES[named.toLowerCase()] ?? match;
      const codePoint = Number.parseInt(decimal ?? hex ?? '', hex ? 16 : 10);
      if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10FFFF) {
        return match;
      }
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return match;
      }
    },
  );
}

function anchorAsText(_match: string, attrs: string, body: string): string {
  const quotedHref = attrs.match(/\bhref\s*=\s*(["'])(.*?)\1/i);
  const bareHref = attrs.match(/\bhref\s*=\s*([^\s"'<>`]+)/i);
  const href = decodeHtmlEntities(quotedHref?.[2] ?? bareHref?.[1] ?? '').trim();
  const label = decodeHtmlEntities(body.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();

  if (!href || /^(?:javascript|data):/i.test(href)) return label;
  if (!label || label === href) return href;
  return `${label} (${href})`;
}

/**
 * Convert Google Calendar's rich event description into readable plain text.
 * Block structure and link destinations survive because EventKit notes do not
 * render HTML; active/script content and all remaining tags are discarded.
 */
export function htmlToPlainText(value: string | null | undefined): string | null {
  if (!value) return null;

  const text = value
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi, anchorAsText)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '• ')
    .replace(/<\/li\s*>/gi, '\n')
    .replace(/<\/(?:p|div|blockquote|h[1-6]|tr)\s*>/gi, '\n\n')
    .replace(/<\/(?:td|th)\s*>/gi, '\t')
    .replace(/<[^>]*>/g, '')
    .replace(/\r\n?/g, '\n');

  const cleaned = decodeHtmlEntities(text)
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return cleaned || null;
}
