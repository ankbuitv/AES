/**
 * Reel source parsing.
 *
 * A member imports a short video by pasting its URL. We never download or
 * re-host that video: we extract the platform + video id and build the URL of
 * that platform's *own* embed player, which is the only way to show third-party
 * short-form video without breaking each network's terms of service.
 *
 * Everything here is deliberately pure and offline — no network call at import
 * time, no oEmbed round trip, no API key. A paste either matches one of the
 * known URL shapes or it is rejected, so a hostile string can never reach an
 * `<iframe src>`: the embed URL is *rebuilt* from a validated id rather than
 * echoed back from user input.
 */

export type ReelProvider = 'upload' | 'youtube' | 'tiktok' | 'instagram' | 'facebook';

export interface ParsedReelSource {
  provider: Exclude<ReelProvider, 'upload'>;
  /** Platform-native video id, already validated against a strict charset. */
  externalId: string;
  /** Canonical public page, for the "watch on …" link. */
  sourceUrl: string;
  /** iframe src, assembled by us from the id above. */
  embedUrl: string;
}

/** Human labels used by the UI; kept beside the parser so they cannot drift. */
export const PROVIDER_LABELS: Record<ReelProvider, string> = {
  upload: 'AES',
  youtube: 'YouTube',
  tiktok: 'TikTok',
  instagram: 'Instagram',
  facebook: 'Facebook',
};

/**
 * Hosts each platform serves embeds from. `frame-src` in the CSP is built from
 * this list, so adding a provider is a single-place change.
 */
export const EMBED_ORIGINS: readonly string[] = [
  'https://www.youtube-nocookie.com',
  'https://www.youtube.com',
  'https://www.tiktok.com',
  'https://www.instagram.com',
  'https://www.facebook.com',
];

const YOUTUBE_ID = /^[A-Za-z0-9_-]{6,20}$/;
const TIKTOK_ID = /^[0-9]{6,32}$/;
const INSTAGRAM_ID = /^[A-Za-z0-9_-]{5,32}$/;
const FACEBOOK_ID = /^[0-9]{6,32}$/;

function host(url: URL): string {
  return url.hostname.replace(/^www\./, '').toLowerCase();
}

/**
 * Parse a pasted URL into an embeddable reel.
 * Returns `null` for anything we do not recognise — the caller turns that into
 * a 400 with a helpful message rather than guessing.
 */
export function parseReelUrl(input: string): ParsedReelSource | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  // Only ever follow http(s). `javascript:` and `data:` must never survive
  // this far, and a scheme check here means the rest of the file can assume it.
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;

  const name = host(url);
  const segments = url.pathname.split('/').filter(Boolean);

  // --- YouTube (Shorts, watch?v=, youtu.be) ---------------------------------
  if (name === 'youtube.com' || name === 'm.youtube.com' || name === 'youtube-nocookie.com') {
    const id =
      (segments[0] === 'shorts' || segments[0] === 'embed' || segments[0] === 'live'
        ? segments[1]
        : null) ?? url.searchParams.get('v');
    if (id && YOUTUBE_ID.test(id)) return youtube(id);
    return null;
  }
  if (name === 'youtu.be') {
    const id = segments[0];
    if (id && YOUTUBE_ID.test(id)) return youtube(id);
    return null;
  }

  // --- TikTok ---------------------------------------------------------------
  if (name === 'tiktok.com' || name.endsWith('.tiktok.com')) {
    // https://www.tiktok.com/@user/video/1234567890123456789
    const videoIndex = segments.indexOf('video');
    const id = videoIndex >= 0 ? segments[videoIndex + 1] : segments[segments.length - 1];
    // Short links (vm.tiktok.com/XXXX) resolve server-side only, and we do not
    // make network calls here — ask for the full URL instead of guessing.
    if (id && TIKTOK_ID.test(id)) {
      return {
        provider: 'tiktok',
        externalId: id,
        sourceUrl: `https://www.tiktok.com/@i/video/${id}`,
        embedUrl: `https://www.tiktok.com/embed/v2/${id}`,
      };
    }
    return null;
  }

  // --- Instagram (reels and posts share one embed shape) --------------------
  if (name === 'instagram.com' || name.endsWith('.instagram.com')) {
    const kindIndex = segments.findIndex((s) => s === 'reel' || s === 'reels' || s === 'p' || s === 'tv');
    const id = kindIndex >= 0 ? segments[kindIndex + 1] : null;
    if (id && INSTAGRAM_ID.test(id)) {
      return {
        provider: 'instagram',
        externalId: id,
        sourceUrl: `https://www.instagram.com/reel/${id}/`,
        embedUrl: `https://www.instagram.com/reel/${id}/embed/captioned/`,
      };
    }
    return null;
  }

  // --- Facebook Reels / videos ----------------------------------------------
  if (name === 'facebook.com' || name === 'fb.watch' || name.endsWith('.facebook.com')) {
    const reelIndex = segments.findIndex((s) => s === 'reel' || s === 'videos' || s === 'v');
    const id = (reelIndex >= 0 ? segments[reelIndex + 1] : null) ?? url.searchParams.get('v');
    if (id && FACEBOOK_ID.test(id)) {
      const canonical = `https://www.facebook.com/reel/${id}`;
      return {
        provider: 'facebook',
        externalId: id,
        sourceUrl: canonical,
        // Facebook's plugin takes the canonical URL as an *encoded query
        // parameter*, so the id still round-trips through our own validation.
        embedUrl: `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(
          canonical,
        )}&show_text=false&autoplay=false`,
      };
    }
    return null;
  }

  return null;
}

function youtube(id: string): ParsedReelSource {
  return {
    provider: 'youtube',
    externalId: id,
    sourceUrl: `https://www.youtube.com/shorts/${id}`,
    // -nocookie keeps the player from setting tracking cookies before play.
    embedUrl: `https://www.youtube-nocookie.com/embed/${id}?rel=0&modestbranding=1&playsinline=1`,
  };
}

/**
 * Poster frame for an embedded reel, where the platform exposes a stable
 * thumbnail URL. Only YouTube does without an API call; the others fall back to
 * a gradient placeholder rendered in CSS.
 */
export function posterFor(provider: ReelProvider, externalId: string): string {
  if (provider === 'youtube' && YOUTUBE_ID.test(externalId)) {
    return `https://i.ytimg.com/vi/${externalId}/hqdefault.jpg`;
  }
  return '';
}
