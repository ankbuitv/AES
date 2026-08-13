/**
 * Moderation and administration API.
 *
 * Authorisation is enforced twice on purpose: `requireStaff()` blocks the route
 * and `ModerationService` re-checks the actor's role before every mutation.
 * The frontend never decides who is staff.
 *
 * Every privileged action ends up in `audit_logs` via the service.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import type { AppContext } from '../../types/env';
import type { ReportStatus, ReportTargetType } from '../../types/models';
import { serviceContext } from '../../services/context';
import { ModerationService } from '../../services/moderation';
import { readBody } from '../../middleware/body';
import { rateLimit } from '../../middleware/rateLimit';
import { requireAdmin, requireAuth, requireStaff, requireUser } from '../../middleware/auth';
import { json } from '../../utils/response';
import { idSchema, parseOrThrow } from '../../validators/common';
import { moderationActionSchema, reportSchema, resolveReportSchema } from '../../validators/users';
import { decodeCursor, parseLimit } from '../../utils/cursor';

const admin = new Hono<AppContext>();

// Admin data is never cacheable, anywhere.
admin.use('*', requireStaff(), async (c, next) => {
  c.header('cache-control', 'private, no-store');
  await next();
});

admin.get('/dashboard', async (c) => {
  const viewer = requireUser(c.get('user'));
  const data = await new ModerationService(serviceContext(c)).dashboard(viewer);
  return json(c, data);
});

const reportListSchema = z.object({
  cursor: z.string().max(256).optional(),
  limit: z.union([z.string(), z.number()]).optional(),
  status: z.enum(['open', 'reviewing', 'resolved', 'rejected']).optional(),
  targetType: z.enum(['post', 'comment', 'user', 'media']).optional(),
});

admin.get('/reports', async (c) => {
  const viewer = requireUser(c.get('user'));
  const query = parseOrThrow(reportListSchema, c.req.query());

  const page = await new ModerationService(serviceContext(c)).listReports({
    viewer,
    cursor: decodeCursor(query.cursor),
    limit: parseLimit(query.limit === undefined ? undefined : String(query.limit)),
    ...(query.status ? { status: query.status as ReportStatus } : {}),
    ...(query.targetType ? { targetType: query.targetType as ReportTargetType } : {}),
  });
  return json(c, page);
});

admin.post('/reports/:id/resolve', rateLimit('write'), async (c) => {
  const viewer = requireUser(c.get('user'));
  const body = await readBody(c);
  const input = parseOrThrow(resolveReportSchema, body.fields);

  await new ModerationService(serviceContext(c)).resolveReport({
    viewer,
    reportId: parseOrThrow(idSchema, c.req.param('id')),
    status: input.status,
    resolution: input.resolution,
  });
  return json(c, { resolved: true });
});

admin.post('/actions', rateLimit('write'), async (c) => {
  const viewer = requireUser(c.get('user'));
  const body = await readBody(c);
  const input = parseOrThrow(moderationActionSchema, body.fields);

  await new ModerationService(serviceContext(c)).act({
    viewer,
    action: input.action,
    targetId: input.targetId,
    reason: input.reason,
    ...(input.durationHours ? { durationHours: input.durationHours } : {}),
  });
  return json(c, { ok: true });
});

const userListSchema = z.object({
  cursor: z.string().max(256).optional(),
  limit: z.union([z.string(), z.number()]).optional(),
  status: z.enum(['active', 'suspended', 'banned', 'deleted']).optional(),
  role: z.enum(['user', 'moderator', 'admin']).optional(),
  q: z.string().trim().max(64).optional(),
});

admin.get('/users', async (c) => {
  const viewer = requireUser(c.get('user'));
  const query = parseOrThrow(userListSchema, c.req.query());

  const page = await new ModerationService(serviceContext(c)).listUsers({
    viewer,
    cursor: decodeCursor(query.cursor),
    limit: parseLimit(query.limit === undefined ? undefined : String(query.limit)),
    ...(query.status ? { status: query.status } : {}),
    ...(query.role ? { role: query.role } : {}),
    ...(query.q ? { query: query.q } : {}),
  });
  return json(c, page);
});

admin.get('/posts', async (c) => {
  const viewer = requireUser(c.get('user'));
  const status = c.req.query('status');
  const page = await new ModerationService(serviceContext(c)).listPosts({
    viewer,
    cursor: decodeCursor(c.req.query('cursor')),
    limit: parseLimit(c.req.query('limit')),
    ...(status ? { status } : {}),
  });
  return json(c, page);
});

/** Admin-only: the audit trail can expose which moderator did what. */
admin.get('/audit', requireAdmin(), async (c) => {
  const viewer = requireUser(c.get('user'));
  const page = await new ModerationService(serviceContext(c)).auditLog({
    viewer,
    cursor: decodeCursor(c.req.query('cursor')),
    limit: parseLimit(c.req.query('limit')),
    ...(c.req.query('action') ? { action: c.req.query('action') as string } : {}),
    ...(c.req.query('actorId') ? { actorId: c.req.query('actorId') as string } : {}),
    ...(c.req.query('targetId') ? { targetId: c.req.query('targetId') as string } : {}),
  });
  return json(c, page);
});

export default admin;

// ---------------------------------------------------------------------------
// `/api/reports` — any authenticated member can file a report.
// ---------------------------------------------------------------------------

export const reports = new Hono<AppContext>();

reports.post('/', requireAuth(), rateLimit('report'), async (c) => {
  const reporter = requireUser(c.get('user'));
  const body = await readBody(c);
  const input = parseOrThrow(reportSchema, body.fields);

  const result = await new ModerationService(serviceContext(c)).report({
    reporter,
    targetType: input.targetType,
    targetId: input.targetId,
    reason: input.reason,
    description: input.description,
  });

  return json(c, { reportId: result.id, duplicate: result.duplicate }, 201);
});
