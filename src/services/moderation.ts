/**
 * Moderation and administration service.
 *
 * Two invariants drive this file:
 *  1. Every privileged action is authorised here on the server, by role, and
 *     the caller's role comes from the session — never from the request body.
 *  2. Every privileged action writes an audit log entry. `act()` is the single
 *     funnel so an action cannot be added without being audited.
 */

import type { ServiceContext } from './context';
import { AppError } from '../utils/errors';
import type {
  AuthUser,
  ReportReason,
  ReportStatus,
  ReportTargetType,
  UserRole,
} from '../types/models';
import { buildPage, type Cursor } from '../utils/cursor';
import { NotificationService } from './notifications';
import { now } from '../utils/time';

export type ModerationAction =
  | 'hide_post'
  | 'restore_post'
  | 'delete_post'
  | 'hide_comment'
  | 'restore_comment'
  | 'delete_comment'
  | 'suspend_user'
  | 'unsuspend_user'
  | 'ban_user'
  | 'promote_moderator'
  | 'demote_moderator'
  | 'delete_media';

/** Actions only a full admin may perform. */
const ADMIN_ONLY: ReadonlySet<ModerationAction> = new Set([
  'ban_user',
  'promote_moderator',
  'demote_moderator',
]);

export class ModerationService {
  private readonly notifications: NotificationService;

  constructor(private readonly ctx: ServiceContext) {
    this.notifications = new NotificationService(ctx);
  }

  // --- Reports (any authenticated user) -------------------------------------

  async report(input: {
    reporter: AuthUser;
    targetType: ReportTargetType;
    targetId: string;
    reason: ReportReason;
    description: string;
  }): Promise<{ id: string; duplicate: boolean }> {
    await this.assertTargetExists(input.targetType, input.targetId);

    const result = await this.ctx.repos.reports.create({
      reporterId: input.reporter.id,
      targetType: input.targetType,
      targetId: input.targetId,
      reason: input.reason,
      description: input.description,
    });

    if (!result.duplicate) {
      this.ctx.logger.info('report_created', {
        reportId: result.id,
        targetType: input.targetType,
      });
    }
    return result;
  }

  async listReports(options: {
    viewer: AuthUser;
    cursor: Cursor | null;
    limit: number;
    status?: ReportStatus;
    targetType?: ReportTargetType;
  }) {
    this.assertStaff(options.viewer);
    const rows = await this.ctx.repos.reports.list(options);
    return buildPage(
      rows,
      options.limit,
      (row) => ({
        id: row.id,
        targetType: row.target_type,
        targetId: row.target_id,
        reason: row.reason,
        description: row.description,
        status: row.status,
        resolution: row.resolution,
        reporterUsername: row.reporter_username,
        reviewerUsername: row.reviewer_username,
        createdAt: row.created_at,
        reviewedAt: row.reviewed_at,
      }),
      (row) => ({ v: row.created_at, i: row.id }),
    );
  }

  async resolveReport(input: {
    viewer: AuthUser;
    reportId: string;
    status: ReportStatus;
    resolution: string;
  }): Promise<void> {
    this.assertStaff(input.viewer);
    const report = await this.ctx.repos.reports.findById(input.reportId);
    if (!report) throw AppError.notFound('Report not found');

    const changed = await this.ctx.repos.reports.resolve({
      id: input.reportId,
      status: input.status,
      resolution: input.resolution,
      reviewerId: input.viewer.id,
    });
    if (!changed) throw AppError.conflict('That report has already been reviewed');

    await this.ctx.repos.audit.log({
      actorId: input.viewer.id,
      action: `report.${input.status}`,
      targetType: 'report',
      targetId: input.reportId,
      metadata: { resolution: input.resolution.slice(0, 200) },
    });
  }

  // --- Moderation actions ---------------------------------------------------

  /**
   * The single entry point for every privileged content/user action.
   * Authorises, performs, notifies, resolves related reports and audits.
   */
  async act(input: {
    viewer: AuthUser;
    action: ModerationAction;
    targetId: string;
    reason: string;
    durationHours?: number;
  }): Promise<{ ok: true }> {
    this.assertStaff(input.viewer);
    if (ADMIN_ONLY.has(input.action) && input.viewer.role !== 'admin') {
      throw AppError.forbidden('That action requires an administrator');
    }

    const metadata: Record<string, unknown> = { reason: input.reason.slice(0, 300) };
    let targetType: ReportTargetType = 'post';

    switch (input.action) {
      case 'hide_post':
      case 'restore_post':
      case 'delete_post': {
        const post = await this.ctx.repos.posts.findById(input.targetId);
        if (!post) throw AppError.notFound('Post not found');
        targetType = 'post';

        const status =
          input.action === 'hide_post'
            ? 'hidden'
            : input.action === 'restore_post'
              ? 'published'
              : 'deleted';
        await this.ctx.repos.posts.setStatus(post.id, status);
        metadata['authorId'] = post.author_id;
        metadata['status'] = status;

        if (status !== 'published') {
          await this.notifyAuthor(post.author_id, {
            title:
              status === 'hidden'
                ? 'Your post was hidden by a moderator'
                : 'Your post was removed by a moderator',
            reason: input.reason,
            targetType: 'post',
            targetId: post.id,
            postSlug: post.slug,
          });
        }
        break;
      }

      case 'hide_comment':
      case 'restore_comment':
      case 'delete_comment': {
        const comment = await this.ctx.repos.comments.findById(input.targetId);
        if (!comment) throw AppError.notFound('Comment not found');
        targetType = 'comment';

        if (input.action === 'delete_comment') {
          await this.ctx.repos.comments.softDelete(comment.id, comment.post_id);
        } else {
          await this.ctx.repos.comments.setStatus(
            comment.id,
            input.action === 'hide_comment' ? 'hidden' : 'published',
          );
        }
        metadata['authorId'] = comment.author_id;

        if (input.action !== 'restore_comment') {
          await this.notifyAuthor(comment.author_id, {
            title: 'Your comment was removed by a moderator',
            reason: input.reason,
            targetType: 'comment',
            targetId: comment.id,
            postSlug: comment.post_slug,
          });
        }
        break;
      }

      case 'suspend_user':
      case 'unsuspend_user':
      case 'ban_user': {
        const user = await this.ctx.repos.users.findById(input.targetId);
        if (!user) throw AppError.notFound('User not found');
        targetType = 'user';

        // Staff cannot be actioned by peers; only an admin can act on staff,
        // and nobody can action themselves.
        if (user.id === input.viewer.id) throw AppError.badRequest('You cannot moderate yourself');
        if (user.role !== 'user' && input.viewer.role !== 'admin') {
          throw AppError.forbidden('Only an administrator can moderate staff accounts');
        }

        if (input.action === 'unsuspend_user') {
          await this.ctx.repos.users.setStatus(user.id, 'active', '');
        } else if (input.action === 'suspend_user') {
          const until = now() + (input.durationHours ?? 24) * 3600;
          await this.ctx.repos.users.setStatus(user.id, 'suspended', input.reason, until);
          // A suspended account must lose its live sessions immediately.
          await this.ctx.repos.sessions.revokeAllForUser(user.id);
          metadata['until'] = until;
        } else {
          await this.ctx.repos.users.setStatus(user.id, 'banned', input.reason);
          await this.ctx.repos.sessions.revokeAllForUser(user.id);
        }

        await this.notifyAuthor(user.id, {
          title:
            input.action === 'unsuspend_user'
              ? 'Your account has been reinstated'
              : input.action === 'suspend_user'
                ? 'Your account has been suspended'
                : 'Your account has been banned',
          reason: input.reason,
          targetType: 'user',
          targetId: user.id,
        });
        break;
      }

      case 'promote_moderator':
      case 'demote_moderator': {
        const user = await this.ctx.repos.users.findById(input.targetId);
        if (!user) throw AppError.notFound('User not found');
        if (user.role === 'admin') throw AppError.forbidden('Administrators cannot be demoted here');
        targetType = 'user';

        const role: UserRole = input.action === 'promote_moderator' ? 'moderator' : 'user';
        await this.ctx.repos.users.setRole(user.id, role);
        metadata['role'] = role;
        break;
      }

      case 'delete_media': {
        const media = await this.ctx.repos.media.findById(input.targetId);
        if (!media) throw AppError.notFound('Media not found');
        targetType = 'media';
        await this.ctx.repos.media.softDeleteWithVariants(media.id);
        metadata['ownerId'] = media.owner_id;
        break;
      }

      default: {
        // Exhaustiveness guard: adding an action without handling it fails to
        // compile rather than silently doing nothing.
        const never: never = input.action;
        throw AppError.badRequest(`Unsupported action: ${String(never)}`);
      }
    }

    // Any open report about this target is now handled.
    await this.ctx.repos.reports.resolveForTarget(
      targetType,
      input.targetId,
      input.viewer.id,
      `Action taken: ${input.action}`,
    );

    await this.ctx.repos.audit.log({
      actorId: input.viewer.id,
      action: `moderation.${input.action}`,
      targetType,
      targetId: input.targetId,
      metadata,
    });

    this.ctx.logger.info('moderation_action', {
      action: input.action,
      targetType,
      targetId: input.targetId,
      actorId: input.viewer.id,
    });

    return { ok: true };
  }

  // --- Admin dashboard reads ------------------------------------------------

  async dashboard(viewer: AuthUser) {
    this.assertStaff(viewer);
    const [stats, days, openReports] = await Promise.all([
      this.ctx.repos.stats.dashboard(),
      this.ctx.repos.stats.recentDays(14),
      this.ctx.repos.reports.countOpen(),
    ]);
    return { stats, days, openReports };
  }

  async listUsers(options: {
    viewer: AuthUser;
    cursor: Cursor | null;
    limit: number;
    status?: string;
    role?: string;
    query?: string;
  }) {
    this.assertStaff(options.viewer);
    return this.ctx.repos.users.listForAdmin(options);
  }

  async listPosts(options: {
    viewer: AuthUser;
    cursor: Cursor | null;
    limit: number;
    status?: string;
  }) {
    this.assertStaff(options.viewer);
    const rows = await this.ctx.repos.posts.listForAdmin(options);
    return buildPage(
      rows,
      options.limit,
      (row) => ({
        id: row.id,
        slug: row.slug,
        title: row.title,
        excerpt: row.excerpt,
        status: row.status,
        visibility: row.visibility,
        authorUsername: row.author_username,
        reactionCount: row.reaction_count,
        commentCount: row.comment_count,
        createdAt: row.created_at,
      }),
      (row) => ({ v: row.created_at, i: row.id }),
    );
  }

  async auditLog(options: {
    viewer: AuthUser;
    cursor: Cursor | null;
    limit: number;
    action?: string;
    actorId?: string;
    targetId?: string;
  }) {
    // The audit trail is admin-only: it can contain moderator identities.
    if (options.viewer.role !== 'admin') {
      throw AppError.forbidden('Only an administrator can read the audit log');
    }
    const rows = await this.ctx.repos.audit.list(options);
    return buildPage(
      rows,
      options.limit,
      (row) => ({
        id: row.id,
        actorUsername: row.actor_username,
        action: row.action,
        targetType: row.target_type,
        targetId: row.target_id,
        metadata: safeParse(row.metadata_json),
        createdAt: row.created_at,
      }),
      (row) => ({ v: row.created_at, i: row.id }),
    );
  }

  // --- helpers --------------------------------------------------------------

  private assertStaff(viewer: AuthUser): void {
    if (viewer.role !== 'admin' && viewer.role !== 'moderator') {
      throw AppError.forbidden('Moderator access required');
    }
  }

  private async assertTargetExists(type: ReportTargetType, id: string): Promise<void> {
    const found =
      type === 'post'
        ? await this.ctx.repos.posts.findById(id)
        : type === 'comment'
          ? await this.ctx.repos.comments.findById(id)
          : type === 'user'
            ? await this.ctx.repos.users.findById(id)
            : await this.ctx.repos.media.findById(id);
    if (!found) throw AppError.notFound('The reported item no longer exists');
  }

  private async notifyAuthor(
    userId: string,
    input: {
      title: string;
      reason: string;
      targetType: string;
      targetId: string;
      postSlug?: string;
    },
  ): Promise<void> {
    await this.notifications.notify({
      userId,
      actorId: null,
      type: 'MODERATION',
      targetType: input.targetType,
      targetId: input.targetId,
      data: {
        title: input.title,
        reason: input.reason.slice(0, 300),
        ...(input.postSlug ? { postSlug: input.postSlug } : {}),
      },
    });
  }
}

function safeParse(json: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(json || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
