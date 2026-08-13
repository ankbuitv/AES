/**
 * Comment-level operations. Creating a comment lives under
 * `/api/posts/:id/comments`; everything that addresses an existing comment by
 * id lives here.
 */

import { Hono } from 'hono';
import type { AppContext } from '../../types/env';
import { serviceContext } from '../../services/context';
import { PostService } from '../../services/posts';
import { readBody } from '../../middleware/body';
import { rateLimit } from '../../middleware/rateLimit';
import { requireAuth, requireUser } from '../../middleware/auth';
import { json, noContent } from '../../utils/response';
import { idSchema, parseOrThrow, reactionTypeSchema } from '../../validators/common';
import { updateCommentSchema } from '../../validators/posts';
import { z } from 'zod';

const comments = new Hono<AppContext>();

comments.patch('/:id', requireAuth(), rateLimit('write'), async (c) => {
  const viewer = requireUser(c.get('user'));
  const body = await readBody(c);
  const input = parseOrThrow(updateCommentSchema, body.fields);

  const comment = await new PostService(serviceContext(c)).updateComment({
    viewer,
    commentId: parseOrThrow(idSchema, c.req.param('id')),
    content: input.content,
  });
  return json(c, { comment });
});

comments.delete('/:id', requireAuth(), rateLimit('write'), async (c) => {
  const viewer = requireUser(c.get('user'));
  await new PostService(serviceContext(c)).removeComment({
    viewer,
    commentId: parseOrThrow(idSchema, c.req.param('id')),
  });
  return noContent();
});

comments.post('/:id/reactions', requireAuth(), rateLimit('write'), async (c) => {
  const viewer = requireUser(c.get('user'));
  const body = await readBody(c);
  const input = parseOrThrow(z.object({ reaction: reactionTypeSchema }), body.fields);

  const result = await new PostService(serviceContext(c)).react({
    viewer,
    targetType: 'comment',
    targetId: parseOrThrow(idSchema, c.req.param('id')),
    reaction: input.reaction,
  });
  return json(c, result);
});

export default comments;
