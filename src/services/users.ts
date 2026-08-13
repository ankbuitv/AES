/**
 * User-facing profile service: profiles, follows, blocks, discovery and
 * account settings. Authorisation lives here, never in the client.
 */

import type { ServiceContext } from './context';
import { AppError } from '../utils/errors';
import { toPublicUser } from '../db/repositories/users';
import type { AuthUser, PublicUser, UserRow } from '../types/models';
import type { Cursor } from '../utils/cursor';
import { NotificationService } from './notifications';
import { XpService } from './xp';
import { BADGES, LIMITS } from '../config';
import { toPlainText } from '../utils/markdown';

export interface ProfileView extends PublicUser {
  badges: string[];
  badgeDetails: { code: string; name: string; description: string; icon: string }[];
  isFollowing: boolean;
  isFollowedBy: boolean;
  isBlocked: boolean;
  isSelf: boolean;
  levelProgress: { level: number; current: number; needed: number; pct: number };
  canModerate: boolean;
}

export class UserService {
  private readonly notifications: NotificationService;
  private readonly xp: XpService;

  constructor(private readonly ctx: ServiceContext) {
    this.notifications = new NotificationService(ctx);
    this.xp = new XpService(ctx);
  }

  /** Full profile with viewer-relative state. */
  async profile(username: string, viewer: AuthUser | null): Promise<ProfileView> {
    const row = await this.ctx.repos.users.findByUsername(username.toLowerCase());
    if (!row) throw AppError.notFound('That profile does not exist');

    const isSelf = viewer?.id === row.id;
    const isStaff = viewer?.role === 'admin' || viewer?.role === 'moderator';

    // Deleted or banned accounts are hidden from everyone but staff.
    if ((row.status === 'deleted' || row.status === 'banned') && !isSelf && !isStaff) {
      throw AppError.notFound('That profile does not exist');
    }

    const [badges, isFollowing, isFollowedBy, isBlocked] = await Promise.all([
      this.ctx.repos.users.listBadges(row.id),
      viewer && !isSelf ? this.ctx.repos.users.isFollowing(viewer.id, row.id) : Promise.resolve(false),
      viewer && !isSelf ? this.ctx.repos.users.isFollowing(row.id, viewer.id) : Promise.resolve(false),
      viewer && !isSelf ? this.ctx.repos.users.isBlocked(viewer.id, row.id) : Promise.resolve(false),
    ]);

    const snapshot = await this.xp.snapshot(row);

    return {
      ...toPublicUser(row),
      badges,
      badgeDetails: badges.map((code) => ({
        code,
        name: BADGES[code as keyof typeof BADGES]?.name ?? code,
        description: BADGES[code as keyof typeof BADGES]?.description ?? '',
        icon: BADGES[code as keyof typeof BADGES]?.icon ?? '★',
      })),
      isFollowing,
      isFollowedBy,
      isBlocked,
      isSelf: !!isSelf,
      levelProgress: {
        level: snapshot.level,
        current: snapshot.current,
        needed: snapshot.needed,
        pct: snapshot.pct,
      },
      canModerate: !!isStaff,
    };
  }

  /** Lightweight lookup used by SSR headers and API responses. */
  async publicById(id: string): Promise<PublicUser | null> {
    const row = await this.ctx.repos.users.findById(id);
    return row ? toPublicUser(row) : null;
  }

  async updateProfile(
    viewer: AuthUser,
    patch: {
      displayName?: string;
      bio?: string;
      location?: string;
      website?: string;
    },
  ): Promise<PublicUser> {
    // Bio is stored raw but rendered escaped; strip control characters and cap
    // length here so the stored value is always sane.
    const clean = {
      ...(patch.displayName !== undefined ? { displayName: patch.displayName.trim() } : {}),
      ...(patch.bio !== undefined ? { bio: toPlainText(patch.bio, LIMITS.bioMax) } : {}),
      ...(patch.location !== undefined ? { location: patch.location.trim().slice(0, 80) } : {}),
      ...(patch.website !== undefined ? { website: normaliseWebsite(patch.website) } : {}),
    };

    await this.ctx.repos.users.updateProfile(viewer.id, clean);
    const row = await this.ctx.repos.users.findById(viewer.id);
    if (!row) throw AppError.notFound('Account not found');
    return toPublicUser(row);
  }

  // --- Follows --------------------------------------------------------------

  async follow(viewer: AuthUser, username: string): Promise<{ following: boolean; followerCount: number }> {
    const target = await this.requireActive(username);
    if (target.id === viewer.id) throw AppError.badRequest('You cannot follow yourself');

    if (await this.ctx.repos.users.isBlocked(viewer.id, target.id)) {
      throw AppError.forbidden('You cannot follow this account');
    }

    const created = await this.ctx.repos.users.follow(viewer.id, target.id);
    if (created) {
      this.ctx.defer(async () => {
        await this.xp.award(target.id, 'followReceived', { type: 'user', id: viewer.id });
        await this.notifications.notify({
          userId: target.id,
          actorId: viewer.id,
          type: 'FOLLOW',
          targetType: 'user',
          targetId: viewer.id,
          data: {},
        });
      });
    }

    const fresh = await this.ctx.repos.users.findById(target.id);
    return { following: true, followerCount: fresh?.follower_count ?? target.follower_count };
  }

  async unfollow(viewer: AuthUser, username: string): Promise<{ following: boolean; followerCount: number }> {
    const target = await this.requireActive(username);
    const removed = await this.ctx.repos.users.unfollow(viewer.id, target.id);

    if (removed) {
      this.ctx.defer(async () => {
        await this.xp.revoke(target.id, 'followReceived', { type: 'user', id: viewer.id });
        await this.notifications.undo({
          userId: target.id,
          actorId: viewer.id,
          type: 'FOLLOW',
          targetType: 'user',
          targetId: viewer.id,
        });
      });
    }

    const fresh = await this.ctx.repos.users.findById(target.id);
    return { following: false, followerCount: fresh?.follower_count ?? target.follower_count };
  }

  async followers(username: string, cursor: Cursor | null, limit: number) {
    const target = await this.requireActive(username);
    return this.ctx.repos.users.listFollowers(target.id, cursor, limit);
  }

  async following(username: string, cursor: Cursor | null, limit: number) {
    const target = await this.requireActive(username);
    return this.ctx.repos.users.listFollowing(target.id, cursor, limit);
  }

  // --- Blocks ---------------------------------------------------------------

  async block(viewer: AuthUser, username: string): Promise<void> {
    const target = await this.requireActive(username);
    if (target.id === viewer.id) throw AppError.badRequest('You cannot block yourself');
    await this.ctx.repos.users.block(viewer.id, target.id);
  }

  async unblock(viewer: AuthUser, username: string): Promise<void> {
    const target = await this.requireActive(username);
    await this.ctx.repos.users.unblock(viewer.id, target.id);
  }

  // --- Discovery ------------------------------------------------------------

  async suggested(viewerId: string | null, limit = 5): Promise<PublicUser[]> {
    const rows = await this.ctx.repos.users.suggested(viewerId, limit);
    return rows.map(toPublicUser);
  }

  async leaderboard(limit = 20) {
    return this.xp.leaderboard(limit);
  }

  private async requireActive(username: string): Promise<UserRow> {
    const row = await this.ctx.repos.users.findByUsername(username.toLowerCase());
    if (!row || row.status === 'deleted') throw AppError.notFound('That profile does not exist');
    if (row.status === 'banned') throw AppError.forbidden('That account is not available');
    return row;
  }
}

/** Accept a bare domain, force http(s), drop anything else. */
function normaliseWebsite(input: string): string {
  const value = input.trim();
  if (!value) return '';
  const withScheme = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.toString().slice(0, 200);
  } catch {
    return '';
  }
}
