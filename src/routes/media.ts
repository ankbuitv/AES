/**
 * `GET /media/{media_id}` — the public read path for stored objects.
 *
 * This is a streaming proxy in front of the storage bucket. It exists so that
 * (a) bucket credentials and object keys never leave the Worker, and (b) every
 * read is permission-checked against the media row's visibility.
 *
 * `?v=thumb|medium|original` selects a variant; when a derived variant has not
 * been produced the original is served instead (see MediaService).
 *
 * Failures are special here. An `<img>` element cannot render a JSON envelope
 * or an HTML error page — the browser just shows the `alt` text and the post
 * looks broken. So when the request came from an image element we answer with
 * a placeholder SVG carrying the original status code (see
 * `services/mediaPlaceholder`). API clients, which send `Accept: application/
 * json`, keep getting the normal error envelope.
 */

import { Hono } from 'hono';
import type { AppContext } from '../types/env';
import type { MediaVariant } from '../types/models';
import { serviceContext } from '../services/context';
import { MediaService } from '../services/media';
import { readLimit } from '../middleware/rateLimit';
import { idSchema, parseOrThrow } from '../validators/common';
import { isAppError } from '../utils/errors';
import { placeholderResponse, wantsImage, type PlaceholderKind } from '../services/mediaPlaceholder';

const route = new Hono<AppContext>();

function variantOf(value: string | undefined): MediaVariant {
  return value === 'thumb' || value === 'medium' ? value : 'original';
}

/** Map a failure to the artwork that explains it. */
function kindFor(error: unknown): PlaceholderKind {
  if (!isAppError(error)) return 'error';
  switch (error.code) {
    case 'NOT_FOUND':
      return 'missing';
    case 'FORBIDDEN':
    case 'UNAUTHENTICATED':
      return 'private';
    case 'STORAGE_ERROR':
    case 'SERVICE_UNAVAILABLE':
      return 'unavailable';
    default:
      return 'error';
  }
}

route.on(['GET', 'HEAD'], '/:id', readLimit(), async (c) => {
  const id = parseOrThrow(idSchema, c.req.param('id'));
  const viewer = c.get('user');
  const ctx = serviceContext(c);
  const service = new MediaService(ctx);

  let response: Response;
  try {
    const row = await service.resolveForRead(
      id,
      variantOf(c.req.query('v')),
      viewer ? { id: viewer.id, role: viewer.role } : null,
    );
    response = await service.serve(row, c.req.raw);
  } catch (error) {
    // Rate limiting still has to reach the client as a real error, and a
    // non-image consumer wants the JSON envelope, so only image requests are
    // rewritten.
    if (!wantsImage(c.req.raw) || (isAppError(error) && error.code === 'RATE_LIMITED')) throw error;
    const status = isAppError(error) ? error.status : 500;
    ctx.logger.warn('media_placeholder_served', {
      mediaId: id,
      status,
      code: isAppError(error) ? error.code : 'UNKNOWN',
    });
    response = placeholderResponse(kindFor(error), status);
  }

  // HEAD must not carry a body but keeps every header, so clients can probe
  // size and type before downloading.
  if (c.req.method === 'HEAD') {
    return new Response(null, { status: response.status, headers: response.headers });
  }
  return response;
});

export default route;
