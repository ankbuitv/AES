/**
 * Media API.
 *
 * The Worker is the only party that talks to the bucket. Browsers upload here
 * and read back through `/media/{id}` — no bucket hostname, key or credential
 * is ever handed to the client.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import type { AppContext } from '../../types/env';
import type { MediaUsage, Visibility } from '../../types/models';
import { serviceContext } from '../../services/context';
import { MediaService } from '../../services/media';
import { readBody } from '../../middleware/body';
import { rateLimit } from '../../middleware/rateLimit';
import { requireAuth, requireUser } from '../../middleware/auth';
import { json, noContent } from '../../utils/response';
import { idSchema, parseOrThrow } from '../../validators/common';
import { AppError } from '../../utils/errors';
import { decodeCursor, parseLimit } from '../../utils/cursor';

const media = new Hono<AppContext>();

const uploadFieldsSchema = z.object({
  usage: z.enum(['avatar', 'cover', 'post', 'attachment']).optional().default('attachment'),
  visibility: z.enum(['public', 'followers', 'private']).optional().default('public'),
  altText: z.string().trim().max(500).optional().default(''),
});

media.post('/upload', requireAuth(), rateLimit('upload'), async (c) => {
  const owner = requireUser(c.get('user'));
  const body = await readBody(c);

  if (body.kind !== 'multipart') {
    throw AppError.badRequest('Upload requests must be multipart/form-data');
  }

  const file = body.files.file ?? body.files.image ?? Object.values(body.files)[0];
  if (!file) throw AppError.badRequest('No file was attached');

  const fields = parseOrThrow(uploadFieldsSchema, body.fields);

  const dto = await new MediaService(serviceContext(c)).upload({
    owner,
    file,
    // Declared type and filename are hints only; the service classifies by
    // inspecting the bytes and rejects any disagreement.
    declaredType: file.type,
    filename: file.name,
    usage: fields.usage as MediaUsage,
    visibility: fields.visibility as Visibility,
    altText: fields.altText,
  });

  return json(c, { media: dto }, 201);
});

media.get('/', requireAuth(), async (c) => {
  const owner = requireUser(c.get('user'));
  const page = await new MediaService(serviceContext(c)).listForOwner({
    ownerId: owner.id,
    cursor: decodeCursor(c.req.query('cursor')),
    limit: parseLimit(c.req.query('limit')),
  });
  c.header('cache-control', 'private, no-store');
  return json(c, page);
});

media.delete('/:id', requireAuth(), rateLimit('write'), async (c) => {
  const viewer = requireUser(c.get('user'));
  await new MediaService(serviceContext(c)).remove({
    viewer,
    mediaId: parseOrThrow(idSchema, c.req.param('id')),
  });
  return noContent();
});

export default media;
