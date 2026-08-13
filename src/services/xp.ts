/**
 * Gamification: XP, levels and badges.
 *
 * Every award is computed on the server from an action that actually happened;
 * the client can never submit XP. Two anti-abuse mechanisms apply:
 *
 *  1. Idempotency — `xp_events` has a unique index on
 *     (user_id, reason, target_type, target_id), so replaying an action (like
 *     un-liking and re-liking a post) awards nothing the second time.
 *  2. Cooldowns — time-based rewards (daily login) are gated by a timestamp
 *     column updated with a conditional UPDATE, so a burst of parallel
 *     requests can only win once.
 *
 * Levels are derived from the authoritative XP total, never incremented
 * independently, so they cannot drift.
 */

import type { ServiceContext } from './context';
import { BADGES, XP_RULES, levelForXp, levelProgress, xpForLevel } from '../config';
import type { PublicUser } from '../types/models';

export type XpReason = keyof typeof XP_RULES;

export interface XpAward {
  reason: XpReason;
  amount: number;
  targetType: string;
  targetId: string;
}

export interface LevelSnapshot {
  xp: number;
  level: number;
  current: number;
  needed: number;
  pct: number;
  nextLevelAt: number;
  badges: { code: string; name: string; description: string; icon: string }[];
}

export class XpService {
  constructor(private readonly ctx: ServiceContext) {}

  /**
   * Award XP for an action. Safe to call from a deferred task: a duplicate is
   * a silent no-op, and failures never break the originating request.
   */
  async award(
    userId: string,
    reason: XpReason,
    target: { type: string; id: string },
  ): Promise<boolean> {
    const amount = XP_RULES[reason];
    if (!amount) return false;
    const granted = await this.ctx.repos.users.awardXp(userId, amount, reason, target);
    if (granted) {
      this.ctx.logger.debug('xp_awarded', { userId, reason, amount });
      await this.evaluateBadges(userId);
    }
    return granted;
  }

  /** Remove XP when the action is undone (un-react, deleted post). */
  async revoke(
    userId: string,
    reason: XpReason,
    target: { type: string; id: string },
  ): Promise<void> {
    await this.ctx.repos.users.revokeXp(userId, reason, target);
  }

  /**
   * Re-check every badge rule for a user. Cheap enough to run after an award:
   * it is a handful of counters already denormalised on the user row.
   */
  async evaluateBadges(userId: string): Promise<string[]> {
    const user = await this.ctx.repos.users.findById(userId);
    if (!user || user.status !== 'active') return [];

    const owned = new Set(await this.ctx.repos.users.listBadges(userId));
    const earned: string[] = [];

    const rules: { code: string; ok: boolean }[] = [
      { code: 'first_post', ok: user.post_count >= 1 },
      { code: 'conversationalist', ok: user.comment_count >= 25 },
      { code: 'popular', ok: user.reaction_received_count >= 100 },
      { code: 'connector', ok: user.follower_count >= 25 },
      { code: 'veteran', ok: user.created_at <= Math.floor(Date.now() / 1000) - 365 * 86400 },
      { code: 'level_10', ok: levelForXp(user.xp) >= 10 },
    ];

    for (const rule of rules) {
      if (!rule.ok || owned.has(rule.code)) continue;
      if (await this.ctx.repos.users.awardBadge(userId, rule.code)) {
        earned.push(rule.code);
        await this.ctx.repos.notifications.create({
          userId,
          actorId: null,
          type: 'SYSTEM',
          targetType: 'badge',
          targetId: rule.code,
          data: {
            title: 'New badge unlocked',
            badge: rule.code,
            badgeName: BADGES[rule.code]?.name ?? rule.code,
          },
        });
      }
    }

    if (earned.length) this.ctx.logger.info('badges_awarded', { userId, badges: earned });
    return earned;
  }

  /** Progress panel shown on the profile and settings pages. */
  async snapshot(user: Pick<PublicUser, 'id' | 'xp'>): Promise<LevelSnapshot> {
    const progress = levelProgress(user.xp);
    const codes = await this.ctx.repos.users.listBadges(user.id);
    return {
      xp: user.xp,
      level: progress.level,
      current: progress.current,
      needed: progress.needed,
      pct: progress.pct,
      nextLevelAt: xpForLevel(progress.level + 1),
      badges: codes.map((code) => ({
        code,
        name: BADGES[code]?.name ?? code,
        description: BADGES[code]?.description ?? '',
        icon: BADGES[code]?.icon ?? '🎖️',
      })),
    };
  }

  /** Public leaderboard — a small, cacheable read. */
  async leaderboard(limit = 20) {
    return this.ctx.repos.users.topByXp(limit);
  }
}
