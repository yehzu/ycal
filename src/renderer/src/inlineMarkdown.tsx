// yCal — render a single line of lightweight Markdown inline.
//
// Task descriptions (and the markdown task provider's indented prose) are
// stored as Markdown, but the Task sheet used to print them verbatim, so
// `[label](url)` links and `**bold**` showed up as raw punctuation. This is a
// deliberately small inline parser — NOT a full CommonMark engine — covering
// the tokens that actually appear in a todo note:
//
//   `code`            → <code class="code-inline">
//   [label](url)      → external link (opens in the default browser)
//   **bold**          → <strong>
//   *italic*          → <em>
//   https://bare.url  → autolinked
//
// Block structure (lists, headings, paragraphs) is intentionally out of
// scope: the caller already splits on newlines into <p> rows. Anything not
// matched is emitted as plain text, so passing a non-Markdown string is safe.

import { Fragment } from 'react';

// Emphasis inners exclude their own delimiter and disallow a leading space so
// `2 * 3 = 6` and `** heading **` don't get mistaken for emphasis. Ordered so
// that at a given position `**` (bold) is tried before `*` (italic), and code
// wins first so its contents are never re-parsed.
const PATTERN = [
  '(`[^`\\n]+`)', //                              1 code
  '(\\[[^\\]\\n]+\\]\\([^)\\s]+\\))', //          2 link  [label](url)
  '(\\*\\*[^\\s*][^*\\n]*?\\*\\*)', //            3 bold  **...**
  '(\\*[^\\s*][^*\\n]*?\\*)', //                  4 italic *...*
  '(https?://[^\\s<]+)', //                       5 autolink
].join('|');

// Route through window.open so Electron's setWindowOpenHandler (main/index.ts)
// forwards it to shell.openExternal — the renderer can't reach the shell and
// must never navigate itself to an external URL.
function openExternal(url: string): void {
  window.open(url, '_blank', 'noopener');
}

function anchor(key: number, href: string, label: React.ReactNode): React.ReactNode {
  return (
    <a
      key={key}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => {
        e.preventDefault();
        openExternal(href);
      }}
    >
      {label}
    </a>
  );
}

// Split trailing sentence punctuation off a bare URL so "see https://x.com."
// doesn't swallow the period into the link (and unbalanced closing parens too).
function splitAutolink(url: string): [string, string] {
  let href = url;
  let trail = '';
  const m = /[.,;:!?]+$/.exec(href);
  if (m) {
    trail = m[0];
    href = href.slice(0, -trail.length);
  }
  if (href.endsWith(')') && !href.includes('(')) {
    trail = ')' + trail;
    href = href.slice(0, -1);
  }
  return [href, trail];
}

export function renderInlineMarkdown(text: string): React.ReactNode {
  if (!text) return text;
  // Fresh regex per call: the `g` flag carries lastIndex state, and this
  // function recurses (bold/link labels can contain other tokens), so a shared
  // instance would corrupt the outer scan.
  const re = new RegExp(PATTERN, 'g');
  const nodes: React.ReactNode[] = [];
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      nodes.push(<Fragment key={key++}>{text.slice(last, m.index)}</Fragment>);
    }
    const [full, code, link, bold, italic, url] = m;
    if (code) {
      nodes.push(
        <code key={key++} className="code-inline">
          {code.slice(1, -1)}
        </code>,
      );
    } else if (link) {
      const sep = link.indexOf('](');
      const label = link.slice(1, sep);
      const href = link.slice(sep + 2, -1);
      nodes.push(anchor(key++, href, renderInlineMarkdown(label)));
    } else if (bold) {
      nodes.push(<strong key={key++}>{renderInlineMarkdown(bold.slice(2, -2))}</strong>);
    } else if (italic) {
      nodes.push(<em key={key++}>{renderInlineMarkdown(italic.slice(1, -1))}</em>);
    } else if (url) {
      const [href, trail] = splitAutolink(url);
      nodes.push(anchor(key++, href, href));
      if (trail) nodes.push(<Fragment key={key++}>{trail}</Fragment>);
    }
    last = m.index + full.length;
  }
  if (last < text.length) {
    nodes.push(<Fragment key={key++}>{text.slice(last)}</Fragment>);
  }
  if (nodes.length === 0) return text;
  return nodes.length === 1 ? nodes[0] : nodes;
}
