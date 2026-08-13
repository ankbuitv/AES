/**
 * HTML escaping and safe-markup helpers.
 *
 * Rule: user input is never interpolated into HTML unescaped. Rich text goes
 * through the markdown renderer + sanitizer in `src/utils/markdown.ts`, which
 * emits a restricted tag set only.
 */

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(input: unknown): string {
  if (input === null || input === undefined) return '';
  return String(input).replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]!);
}

/** Escape for use inside a double-quoted HTML attribute. */
export function escapeAttr(input: unknown): string {
  return escapeHtml(input);
}

/**
 * Serialise a value for embedding in a <script> block.
 * `<` is escaped so a string containing `</script>` cannot break out.
 */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value ?? null)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * Tagged template that escapes every interpolated value.
 * Use `raw()` to opt a value out (only for already-sanitised markup).
 */
export interface RawHtml {
  readonly __raw: string;
}

export function raw(value: string): RawHtml {
  return { __raw: value };
}

function isRaw(value: unknown): value is RawHtml {
  return typeof value === 'object' && value !== null && '__raw' in value;
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): string {
  let out = strings[0] ?? '';
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (isRaw(value)) {
      out += value.__raw;
    } else if (Array.isArray(value)) {
      out += value.map((v) => (isRaw(v) ? v.__raw : escapeHtml(v))).join('');
    } else if (value === null || value === undefined || value === false) {
      out += '';
    } else {
      out += escapeHtml(value);
    }
    out += strings[i + 1] ?? '';
  }
  return out;
}

/**
 * Validate a URL for use in href/src.
 * Only http(s) and site-relative links are allowed — this blocks
 * `javascript:`, `data:` and other script-bearing schemes.
 */
export function safeUrl(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) return trimmed;
  try {
    const url = new URL(trimmed);
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.toString();
    return null;
  } catch {
    return null;
  }
}
