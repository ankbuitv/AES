/**
 * A small, dependency-free Markdown renderer with a security-first design.
 *
 * Design: we never sanitise HTML *after* generating it (that is the fragile
 * approach). Instead the renderer is a whitelist generator — every character of
 * user input is HTML-escaped first, and only the tags this file emits itself
 * can ever appear in the output. Raw HTML in the source is therefore inert by
 * construction, so there is no bypass via malformed tags, mixed encodings or
 * exotic entities.
 *
 * Supported: headings, bold/italic/strikethrough, inline code, fenced code
 * blocks, links (http/https/relative only), images (site media only),
 * blockquotes, ordered/unordered lists, horizontal rules, @mentions, #hashtags,
 * autolinks, line breaks and paragraphs.
 */

import { escapeHtml, safeUrl } from './html';

export interface RenderOptions {
  /** Allow block-level constructs (headings, lists, code fences, quotes). */
  blocks?: boolean;
  /** Turn bare URLs into links. */
  autolink?: boolean;
  /** Render @mentions as profile links. */
  mentions?: boolean;
  /** Render #hashtags as tag links. */
  hashtags?: boolean;
}

const DEFAULTS: Required<RenderOptions> = {
  blocks: true,
  autolink: true,
  mentions: true,
  hashtags: true,
};

const MENTION_RE = /(^|[^\w/])@([a-z0-9_]{3,24})\b/gi;
const HASHTAG_RE = /(^|[^\w&/])#([\p{L}\p{N}_]{1,50})/gu;
const URL_RE = /\bhttps?:\/\/[^\s<>"')]+/gi;

/** Placeholder markers keep already-rendered spans safe from later passes. */
const PLACEHOLDER_PREFIX = '\u0000ANK';
const PLACEHOLDER_SUFFIX = '\u0000';

class Placeholders {
  private items: string[] = [];

  add(htmlFragment: string): string {
    const index = this.items.push(htmlFragment) - 1;
    return `${PLACEHOLDER_PREFIX}${index}${PLACEHOLDER_SUFFIX}`;
  }

  restore(text: string): string {
    return text.replace(
      new RegExp(`${PLACEHOLDER_PREFIX}(\\d+)${PLACEHOLDER_SUFFIX}`, 'g'),
      (_m, i: string) => this.items[Number(i)] ?? '',
    );
  }
}

/**
 * Render Markdown to sanitised HTML.
 * Input is treated as untrusted text — it is escaped before any markup runs.
 */
export function renderMarkdown(source: string, options: RenderOptions = {}): string {
  const opts = { ...DEFAULTS, ...options };
  const ph = new Placeholders();

  // Normalise newlines, strip control characters (except \n and \t).
  let text = String(source ?? '')
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');

  // 1. Extract fenced code blocks BEFORE escaping so their content is literal.
  if (opts.blocks) {
    text = text.replace(
      /^```([a-z0-9+#._-]{0,20})[ \t]*\n([\s\S]*?)^```[ \t]*$/gim,
      (_match, lang: string, code: string) => {
        const language = lang ? lang.toLowerCase() : '';
        const cls = language ? ` class="language-${escapeHtml(language)}"` : '';
        const label = language
          ? `<span class="code-lang">${escapeHtml(language)}</span>`
          : '';
        return ph.add(
          `<div class="code-block">${label}<pre><code${cls}>${escapeHtml(
            code.replace(/\n$/, ''),
          )}</code></pre></div>`,
        );
      },
    );
  }

  // 2. Inline code, also before escaping.
  text = text.replace(/`([^`\n]+)`/g, (_m, code: string) =>
    ph.add(`<code class="inline-code">${escapeHtml(code)}</code>`),
  );

  // 3. Escape EVERYTHING else. After this point no user-supplied '<' survives.
  text = escapeHtml(text);

  // 4. Links: [label](url) — url validated against a scheme allowlist.
  text = text.replace(
    /\[([^\]\n]{1,200})\]\(([^)\s]{1,2000})\)/g,
    (match, label: string, url: string) => {
      const decoded = decodeEntities(url);
      const safe = safeUrl(decoded);
      if (!safe) return match;
      const external = /^https?:\/\//i.test(safe);
      const rel = external ? ' rel="noopener noreferrer nofollow" target="_blank"' : '';
      return ph.add(
        `<a href="${escapeHtml(safe)}"${rel} class="md-link">${renderInlineText(label, ph, opts)}</a>`,
      );
    },
  );

  // 5. Images: only same-origin media routes (no external beacons / tracking).
  text = text.replace(
    /!\[([^\]\n]{0,200})\]\(([^)\s]{1,2000})\)/g,
    (match, alt: string, url: string) => {
      const decoded = decodeEntities(url);
      if (!/^\/media\/[A-Za-z0-9_-]+/.test(decoded)) return match;
      return ph.add(
        `<img src="${escapeHtml(decoded)}" alt="${escapeHtml(alt)}" loading="lazy" decoding="async" class="md-image">`,
      );
    },
  );

  // 6. Inline emphasis + entities.
  text = applyInlineFormatting(text);

  // 7. Autolink, mentions, hashtags.
  if (opts.autolink) text = applyAutolinks(text, ph);
  if (opts.mentions) text = applyMentions(text, ph);
  if (opts.hashtags) text = applyHashtags(text, ph);

  // 8. Block structure.
  const rendered = opts.blocks ? renderBlocks(text) : renderInlineOnly(text);

  return ph.restore(rendered);
}

function renderInlineText(label: string, ph: Placeholders, opts: Required<RenderOptions>): string {
  let out = applyInlineFormatting(escapeHtml(label));
  if (opts.mentions) out = applyMentions(out, ph);
  return out;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function applyInlineFormatting(text: string): string {
  return text
    .replace(/\*\*\*([^*\n]+)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/(^|[\s(])_([^_\n]+)_/g, '$1<em>$2</em>')
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
}

function applyAutolinks(text: string, ph: Placeholders): string {
  return text.replace(URL_RE, (match) => {
    // Skip URLs already inside a rendered anchor placeholder.
    const safe = safeUrl(decodeEntities(match));
    if (!safe) return match;
    const display = match.length > 60 ? `${match.slice(0, 57)}…` : match;
    return ph.add(
      `<a href="${escapeHtml(safe)}" rel="noopener noreferrer nofollow" target="_blank" class="md-link">${escapeHtml(display)}</a>`,
    );
  });
}

function applyMentions(text: string, ph: Placeholders): string {
  return text.replace(MENTION_RE, (_match, lead: string, username: string) => {
    const handle = username.toLowerCase();
    return (
      lead +
      ph.add(`<a href="/u/${encodeURIComponent(handle)}" class="mention">@${escapeHtml(username)}</a>`)
    );
  });
}

function applyHashtags(text: string, ph: Placeholders): string {
  return text.replace(HASHTAG_RE, (_match, lead: string, tag: string) => {
    const slug = tag.toLowerCase();
    return (
      lead + ph.add(`<a href="/tag/${encodeURIComponent(slug)}" class="hashtag">#${escapeHtml(tag)}</a>`)
    );
  });
}

/** Turn the escaped, inline-rendered text into block-level HTML. */
function renderBlocks(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let paragraph: string[] = [];
  let listType: 'ul' | 'ol' | null = null;
  let quote: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length) {
      out.push(`<p>${paragraph.join('<br>')}</p>`);
      paragraph = [];
    }
  };
  const flushList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };
  const flushQuote = () => {
    if (quote.length) {
      out.push(`<blockquote>${quote.map((q) => `<p>${q}</p>`).join('')}</blockquote>`);
      quote = [];
    }
  };
  const flushAll = () => {
    flushParagraph();
    flushList();
    flushQuote();
  };

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed) {
      flushAll();
      continue;
    }

    // Whole-line placeholder (fenced code block) — emit as its own block.
    if (new RegExp(`^${PLACEHOLDER_PREFIX}\\d+${PLACEHOLDER_SUFFIX}$`).test(trimmed)) {
      flushAll();
      out.push(trimmed);
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      flushAll();
      const level = Math.min(6, heading[1]!.length) + 1; // h1 is reserved for the page
      const tag = `h${Math.min(6, level)}`;
      out.push(`<${tag}>${heading[2]}</${tag}>`);
      continue;
    }

    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flushAll();
      out.push('<hr>');
      continue;
    }

    const quoteMatch = /^&gt;\s?(.*)$/.exec(trimmed);
    if (quoteMatch) {
      flushParagraph();
      flushList();
      quote.push(quoteMatch[1] ?? '');
      continue;
    }
    flushQuote();

    const ulMatch = /^[-*+]\s+(.*)$/.exec(trimmed);
    if (ulMatch) {
      flushParagraph();
      if (listType !== 'ul') {
        flushList();
        out.push('<ul>');
        listType = 'ul';
      }
      out.push(`<li>${ulMatch[1]}</li>`);
      continue;
    }

    const olMatch = /^(\d{1,3})[.)]\s+(.*)$/.exec(trimmed);
    if (olMatch) {
      flushParagraph();
      if (listType !== 'ol') {
        flushList();
        out.push('<ol>');
        listType = 'ol';
      }
      out.push(`<li>${olMatch[2]}</li>`);
      continue;
    }

    flushList();
    paragraph.push(trimmed);
  }

  flushAll();
  return out.join('\n');
}

/** Plain-text mode: paragraphs and line breaks only (used for short comments). */
function renderInlineOnly(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((block) => `<p>${block.split('\n').join('<br>')}</p>`)
    .join('\n');
}

/**
 * Render a post body according to its declared content type.
 * `code` posts are never markdown-parsed — the body is shown verbatim.
 */
export function renderPostContent(
  content: string,
  contentType: string,
  codeLanguage = '',
): string {
  switch (contentType) {
    case 'code': {
      const cls = codeLanguage ? ` class="language-${escapeHtml(codeLanguage)}"` : '';
      const label = codeLanguage
        ? `<span class="code-lang">${escapeHtml(codeLanguage)}</span>`
        : '';
      return `<div class="code-block">${label}<pre><code${cls}>${escapeHtml(content)}</code></pre></div>`;
    }
    case 'markdown':
    case 'article':
      return renderMarkdown(content, { blocks: true });
    case 'link':
    case 'image':
    case 'text':
    default:
      return renderMarkdown(content, { blocks: false });
  }
}

/** Plain-text summary for meta descriptions, feed previews and excerpts. */
export function toPlainText(source: string, maxLength = 200): string {
  const text = String(source ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_~#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

/** Extract unique @usernames referenced in a body (server-side mention source). */
export function extractMentions(source: string, limit = 10): string[] {
  const found = new Set<string>();
  for (const match of String(source ?? '').matchAll(MENTION_RE)) {
    const username = match[2]?.toLowerCase();
    if (username) found.add(username);
    if (found.size >= limit) break;
  }
  return [...found];
}

/** Extract unique #hashtags referenced in a body. */
export function extractHashtags(source: string, limit = 10): string[] {
  const found = new Set<string>();
  for (const match of String(source ?? '').matchAll(HASHTAG_RE)) {
    const tag = match[2]?.toLowerCase();
    if (tag && tag.length <= 50) found.add(tag);
    if (found.size >= limit) break;
  }
  return [...found];
}
