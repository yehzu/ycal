// yCal — render `code-fenced` segments inline.
//
// Used by task titles and descriptions: any run wrapped in matching
// backticks becomes a small <code> chip. Falls back to plain text when
// the input has no backticks, so callers can pass strings unconditionally.

import { Fragment } from 'react';

const SEGMENT_RE = /(`[^`\n]+`)/g;

export function renderInlineCode(text: string): React.ReactNode {
  if (!text || !text.includes('`')) return text;
  const parts = text.split(SEGMENT_RE);
  return parts.map((part, i) => {
    if (part.length >= 2 && part.startsWith('`') && part.endsWith('`')) {
      return (
        <code key={i} className="code-inline">{part.slice(1, -1)}</code>
      );
    }
    return <Fragment key={i}>{part}</Fragment>;
  });
}
