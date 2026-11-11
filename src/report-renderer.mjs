/** Adapt bounded assistant Markdown to card Markdown without enabling mentions, actions or image fetches. */
const MAX_INPUT_CHARACTERS = 4000;
const MAX_OUTPUT_BYTES = 24 * 1024;
const TRUNCATION_NOTE = '\n\n（飞书排版超出长度限制，余下内容请在桌面聊天查看）';

/** Escape raw extensions before the platform can treat HTML-like text as people, mentions or controls. */
function escapeText(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** Keep a generated link label literal while preserving ordinary emphasis and inline code markers. */
function escapeLabel(value) {
  return escapeText(value.replace(/[\r\n]+/g, ' ').replace(/\\([\[\]])/g, '$1'))
    .replace(/[\[\]]/g, '\\$&');
}

/** Reference labels are case-insensitive and fold internal whitespace in common Markdown. */
function referenceKey(value) { return value.trim().replace(/\s+/g, ' ').toLowerCase(); }

/** Extract a destination only; optional Markdown link titles never become platform markup. */
function destination(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith('<')) {
    const end = trimmed.indexOf('>');
    return end > 0 ? trimmed.slice(1, end) : '';
  }
  return trimmed.split(/\s/, 1)[0].replace(/\\([()])/g, '$1');
}

/** Normalize host syntax first so short, decimal and expanded loopback spellings share one rule. */
function isLoopbackUrl(url) {
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  return host === 'localhost' || host.endsWith('.localhost') || /^127\./.test(host) || host === '0.0.0.0' || host === '[::1]' || host === '::1';
}

/** Only explicit HTTP(S) navigation is active; no local, desktop, script or data scheme survives. */
function linkText(label, rawTarget) {
  const text = escapeLabel(label), target = destination(rawTarget);
  if (/^(?:\/|file:)/i.test(target)) return `${text}（本机文件）`;
  if (/^codex:/i.test(target)) return `${text}（桌面链接）`;
  if (/^https?:\/\//i.test(target) && !/[<>\x00-\x20\x7f]/u.test(target)) {
    try {
      const url = new URL(target);
      if (['https:', 'http:'].includes(url.protocol)) {
        if (isLoopbackUrl(url)) {
          return `${text.replace(/https?:\/\//gi, (scheme) => scheme.replace(':', '：'))}（本机页面）`;
        }
        const href = url.href.replaceAll('(', '%28').replaceAll(')', '%29');
        return `[${text}](${href})`;
      }
    } catch { /* A malformed URL is rendered as a non-clickable label below. */ }
  }
  return `${text}（链接未启用）`;
}

/** Find a matching bracket/parenthesis with bounded nesting and escaped delimiters. */
function closingDelimiter(text, start, opening, closing) {
  let depth = 0;
  for (let index = start; index < text.length; index++) {
    if (text[index] === '\\') { index++; continue; }
    if (text[index] === opening) depth++;
    else if (text[index] === closing && --depth === 0) return index;
  }
  return -1;
}

/** Match the whole backtick run; a suffix of an unmatched run cannot open a different code span. */
function codeSpan(text, start) {
  const marker = /^`+/.exec(text.slice(start))[0];
  let close = start + marker.length;
  while ((close = text.indexOf(marker, close)) !== -1) {
    if (text[close - 1] !== '`' && text[close + marker.length] !== '`') return { marker, end: close + marker.length };
    close += marker.length;
  }
  return { marker, end: -1 };
}

/** Leave reference-looking lines inside multiline inline code untouched. */
function insideInlineCode(text, offset) {
  for (let index = 0; index < offset;) {
    if (text[index] === '\\') { index += 2; continue; }
    if (text[index] === '`') {
      const span = codeSpan(text, index);
      if (span.end > offset) return true;
      index = span.end === -1 ? index + span.marker.length : span.end;
    } else index++;
  }
  return false;
}

/** Split fenced code before processing text; raw code stays inside a safely closed code fence. */
function fencedParts(text) {
  const lines = text.split('\n'), parts = [], plain = [];
  const flush = (terminated = false) => {
    if (plain.length) { parts.push({ code: false, text: plain.join('\n') + (terminated ? '\n' : '') }); plain.length = 0; }
  };
  for (let index = 0; index < lines.length; index++) {
    const opening = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)\r?$/.exec(lines[index]);
    if (!opening || (opening[1][0] === '`' && opening[2].includes('`'))) { plain.push(lines[index]); continue; }
    flush(true);
    const marker = opening[1][0], length = opening[1].length, body = [];
    const language = opening[2].trim().split(/\s/, 1)[0];
    for (index++; index < lines.length; index++) {
      const candidate = new RegExp(`^ {0,3}${marker}{${length},}[ \\t]*\\r?$`);
      if (candidate.test(lines[index])) break;
      body.push(lines[index]);
    }
    if (language.toLowerCase() === 'mermaid') {
      parts.push({ code: true, text: '（流程图请在桌面聊天查看）' });
    } else {
      const content = body.join('\n');
      const runs = content.match(/`+/g) ?? [];
      const fence = '`'.repeat(Math.max(3, ...runs.map((run) => run.length + 1)));
      const safeLanguage = /^[a-zA-Z0-9_+.-]{1,32}$/.test(language) ? language : '';
      parts.push({ code: true, text: `${fence}${safeLanguage}\n${content}\n${fence}` });
    }
    if (index < lines.length - 1) parts.push({ code: false, text: '\n' });
  }
  flush();
  return parts;
}

/** Tokenize inline code and links so output limiting never splits a code fence or active link. */
function inlineTokens(text, references) {
  const tokens = [];
  for (let index = 0; index < text.length;) {
    if (text[index] === '\\' && index + 1 < text.length) {
      tokens.push(escapeText(text.slice(index, index + 2))); index += 2; continue;
    }
    if (text[index] === '`') {
      const span = codeSpan(text, index);
      if (span.end !== -1) { tokens.push(text.slice(index, span.end)); index = span.end; continue; }
      tokens.push(span.marker); index += span.marker.length; continue;
    }
    const image = text[index] === '!' && text[index + 1] === '[';
    const start = image ? index + 1 : index;
    if (text[start] === '[') {
      const end = closingDelimiter(text, start, '[', ']');
      if (end !== -1) {
        const label = text.slice(start + 1, end);
        let consumed = end + 1, target;
        if (text[consumed] === '(') {
          const closing = closingDelimiter(text, consumed, '(', ')');
          if (closing !== -1) { target = text.slice(consumed + 1, closing); consumed = closing + 1; }
        } else if (text[consumed] === '[') {
          const closing = closingDelimiter(text, consumed, '[', ']');
          if (closing !== -1) {
            target = references.get(referenceKey(text.slice(consumed + 1, closing) || label)) ?? '';
            consumed = closing + 1;
          }
        } else target = references.get(referenceKey(label));
        if (image) {
          tokens.push(`${escapeLabel(label) || '图片'}（图片待接入）`); index = consumed; continue;
        }
        if (target !== undefined) { tokens.push(linkText(label, target)); index = consumed; continue; }
        if (text[end + 1] === ':') {
          // Definitions nested in blockquotes/lists are outside the small reference adapter.
          tokens.push(`\\[${escapeLabel(label)}\\]:`); index = end + 2; continue;
        }
      }
    }
    if (text[index] === '<') {
      const end = text.indexOf('>', index + 1), target = text.slice(index + 1, end);
      if (end !== -1 && /^https?:\/\//i.test(target) && !/\s/.test(target)) {
        tokens.push(linkText(target, target)); index = end + 1; continue;
      }
    }
    const bareUrl = /^https?:\/\/[^\s<>\[\]`]+/i.exec(text.slice(index));
    if (bareUrl) {
      const target = bareUrl[0].replace(/[),.;!?，。；！？]+$/u, '');
      try {
        if (isLoopbackUrl(new URL(target))) {
          tokens.push(`${escapeText(target.replace(':', '：'))}（本机页面）`); index += target.length; continue;
        }
      } catch { /* Leave malformed bare text for ordinary escaping instead of inventing a link. */ }
    }
    const blockedScheme = /^(?:javascript|data|file|codex|mailto):/i.exec(text.slice(index));
    if (blockedScheme) {
      tokens.push(`${blockedScheme[0].slice(0, -1)}：`); index += blockedScheme[0].length; continue;
    }
    const character = String.fromCodePoint(text.codePointAt(index));
    const lineStart = text.lastIndexOf('\n', index - 1) + 1;
    const quoteMarker = character === '>' && /^[ \t]{0,3}(?:>[ \t]*)*$/.test(text.slice(lineStart, index));
    tokens.push(quoteMarker ? '>' : escapeText(character)); index += character.length;
  }
  return tokens;
}

/** Preserve supported Markdown, degrade local media/diagrams, and emit at most 24 KiB of UTF-8. */
export function renderReportMarkdown(text) {
  if (typeof text !== 'string' || [...text].length > MAX_INPUT_CHARACTERS) throw new Error('report_markdown_invalid_input');
  const parts = fencedParts(text), references = new Map();
  for (const part of parts) {
    if (part.code) continue;
    part.text = part.text.replace(/(^|\n) {0,3}\[([^\]\r\n]+)\]:[ \t]*([^\r\n]*)(?=\n|$)/g, (match, line, name, target, offset, original) => {
      if (insideInlineCode(original, offset + line.length)) return match;
      const key = referenceKey(name);
      if (!references.has(key)) references.set(key, target);
      return line;
    });
  }
  const tokens = parts.flatMap((part) => part.code ? [part.text] : inlineTokens(part.text, references));
  const reserve = Buffer.byteLength(TRUNCATION_NOTE), output = [];
  let bytes = 0;
  for (const token of tokens) {
    const size = Buffer.byteLength(token);
    if (bytes + size > MAX_OUTPUT_BYTES - reserve) return output.join('') + TRUNCATION_NOTE;
    output.push(token); bytes += size;
  }
  return output.join('');
}
