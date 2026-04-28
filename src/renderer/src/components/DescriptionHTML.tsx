import DOMPurify from 'dompurify';
import { useMemo } from 'react';

// Force every anchor to open externally (window.open routes through Electron's
// windowOpenHandler → shell.openExternal). Registered once per process.
let hookInstalled = false;
function installHook(): void {
  if (hookInstalled) return;
  hookInstalled = true;
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });
}

const ALLOWED_TAGS = [
  'a', 'p', 'br', 'b', 'strong', 'i', 'em', 'u', 's', 'strike',
  'ul', 'ol', 'li', 'span', 'div', 'code', 'pre',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'hr',
];
const ALLOWED_ATTR = ['href', 'target', 'rel'];

interface Props {
  html: string;
  className?: string;
}

// Google Calendar's `description` field can be either rich HTML (when entered
// via the web UI) or plain text with `\n` separators (when the event was
// created by Zoom/Outlook/iCal imports). HTML rendering collapses raw
// newlines to spaces, which produced unreadable "wall of text" notes for the
// plain-text case. Detect block-ish HTML markers; if none, convert newlines
// to `<br>` so paragraph breaks survive sanitization.
const HTML_BLOCK_RE = /<(?:p|br|div|ul|ol|h[1-6]|blockquote|pre)\b/i;

function preserveNewlines(input: string): string {
  if (HTML_BLOCK_RE.test(input)) return input;
  return input.replace(/\r\n?|\n/g, '<br>');
}

export function DescriptionHTML({ html, className }: Props) {
  installHook();
  const clean = useMemo(
    () =>
      DOMPurify.sanitize(preserveNewlines(html), {
        ALLOWED_TAGS,
        ALLOWED_ATTR,
        ALLOW_DATA_ATTR: false,
        // Strip URI schemes other than http/https/mailto/tel.
        ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel):|[^a-z]|[a-z+.-]+(?:[^a-z+.-:]|$))/i,
      }),
    [html],
  );
  return (
    <div
      className={`event-desc ${className ?? ''}`.trim()}
      dangerouslySetInnerHTML={{ __html: clean }}
    />
  );
}
