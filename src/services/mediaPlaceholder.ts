/**
 * Placeholder artwork for the media gateway.
 *
 * When `/media/{id}` cannot produce the real bytes — the bucket is not
 * configured, the object vanished, or the viewer is not allowed to see it —
 * returning an HTML/JSON error page means the browser renders nothing but the
 * `alt` text ("Attached image"), which is what users report as "the image is
 * broken and I can't open it".
 *
 * So for requests that came from an `<img>` tag we answer with a tiny inline
 * SVG instead: same status code (the semantics stay honest for API clients and
 * tests), but a real image body the browser can actually paint. The layout
 * keeps its shape and the reason is written on the tile.
 */

export type PlaceholderKind = 'unavailable' | 'missing' | 'private' | 'error';

interface PlaceholderCopy {
  title: string;
  hint: string;
  glyph: string;
}

const COPY: Record<PlaceholderKind, PlaceholderCopy> = {
  unavailable: { title: 'Image unavailable', hint: 'Storage is not reachable right now', glyph: 'cloud' },
  missing: { title: 'Image not found', hint: 'This file is no longer stored', glyph: 'gone' },
  private: { title: 'Image is private', hint: 'You do not have access to this file', glyph: 'lock' },
  error: { title: 'Image unavailable', hint: 'Please try again later', glyph: 'cloud' },
};

/** True when the request looks like an `<img>`/`<video>` fetch rather than an API call. */
export function wantsImage(request: Request): boolean {
  const accept = request.headers.get('accept') ?? '';
  if (accept.includes('image/')) return true;
  // Browsers set `Sec-Fetch-Dest: image` for <img>, and `video`/`audio` for media
  // elements — a reliable signal even when Accept is `*/*`.
  const dest = request.headers.get('sec-fetch-dest') ?? '';
  return dest === 'image' || dest === 'video' || dest === 'audio';
}

function glyphPath(glyph: string): string {
  if (glyph === 'lock') {
    return '<rect x="150" y="146" width="60" height="46" rx="8"/><path d="M164 146v-14a16 16 0 0 1 32 0v14" fill="none" stroke="currentColor" stroke-width="9" stroke-linecap="round"/>';
  }
  if (glyph === 'gone') {
    return '<path d="M141 132h78a10 10 0 0 1 10 10v56a10 10 0 0 1-10 10h-78a10 10 0 0 1-10-10v-56a10 10 0 0 1 10-10zm12 56 20-24 14 17 11-12 19 19z"/><path d="M124 122l112 88" fill="none" stroke="currentColor" stroke-width="10" stroke-linecap="round"/>';
  }
  return '<path d="M141 132h78a10 10 0 0 1 10 10v56a10 10 0 0 1-10 10h-78a10 10 0 0 1-10-10v-56a10 10 0 0 1 10-10zm12 56 20-24 14 17 11-12 19 19z"/>';
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) =>
    ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : '&#39;',
  );
}

/** Self-contained SVG (no external refs, no script) sized to a 4:3 tile. */
export function placeholderSvg(kind: PlaceholderKind): string {
  const copy = COPY[kind];
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 270" width="360" height="270" role="img"',
    ` aria-label="${escapeXml(copy.title)}">`,
    '<rect width="360" height="270" fill="#e9edf3"/>',
    '<g fill="#9aa6b8" color="#9aa6b8">',
    glyphPath(copy.glyph),
    '</g>',
    `<text x="180" y="228" text-anchor="middle" font-family="system-ui,-apple-system,Segoe UI,sans-serif" font-size="17" font-weight="600" fill="#5c6a7e">${escapeXml(
      copy.title,
    )}</text>`,
    `<text x="180" y="250" text-anchor="middle" font-family="system-ui,-apple-system,Segoe UI,sans-serif" font-size="13" fill="#8a97a9">${escapeXml(
      copy.hint,
    )}</text>`,
    '</svg>',
  ].join('');
}

/**
 * Build the placeholder response. The status code is preserved so caches,
 * monitoring and API clients still see the failure; only the body changes.
 */
export function placeholderResponse(kind: PlaceholderKind, status: number): Response {
  return new Response(placeholderSvg(kind), {
    status,
    headers: {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      // Never cache a failure: the real bytes may come back at any moment.
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      'X-Media-Placeholder': kind,
    },
  });
}
