/**
 * `GET /media/{media_id}` — the public read path for stored objects.
 *
 * This is a streaming proxy in front of the storage bucket. It exists so that
 * (a) bucket credentials and object keys never leave the Worker, and (b) every
 * read is permission-checked against the media row's visibility.
 *
 * `?v=thumb|medium|original` selects a variant; when a derived variant has not
 * been produced the original is served instead (see MediaService).
 */

import { Hono } from 'hono';
import type { AppContext } from '../types/env';
import type { MediaVariant } from '../types/models';
import { serviceContext } from '../services/context';
import { MediaService } from '../services/media';
import { readLimit } from '../middleware/rateLimit';
import { idSchema, parseOrThrow } from '../validators/common';

const route = new Hono<AppContext>();

function variantOf(value: string | undefined): MediaVariant {
  return value === 'thumb' || value === 'medium' ? value : 'original';
}

route.on(['GET', 'HEAD'], '/:id', readLimit(), async (c) => {
  const id = parseOrThrow(idSchema, c.req.param('id'));
  const viewer = c.get('user');
  const service = new MediaService(serviceContext(c));

  const row = await service.resolveForRead(
    id,
    variantOf(c.req.query('v')),
    viewer ? { id: viewer.id, role: viewer.role } : null,
  );

  const response = await service.serve(row, c.req.raw);

  // HEAD must not carry a body but keeps every header, so clients can probe
  // size and type before downloading.
  if (c.req.method === 'HEAD') {
    return new Response(null, { status: response.status, headers: response.headers });
  }
  return response;
});

export default route;
