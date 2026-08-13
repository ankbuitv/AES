/**
 * Shared right-rail composition for the HTML routes.
 *
 * Every widget is optional and degrades to an empty string, so a fresh install
 * renders a clean page. The data is fetched in parallel and is deliberately
 * *not* personalised on anonymous pages, which is what lets those pages be
 * briefly edge-cached.
 */

import type { Context } from 'hono';
import type { AppContext } from '../../types/env';
import { serviceContext } from '../../services/context';
import { UserService } from '../../services/users';
import { getConfig } from '../../config';
import {
  aboutWidget,
  leaderboardWidget,
  suggestedUsersWidget,
  trendingTagsWidget,
  type LeaderRow,
} from '../../views/components/rail';

export async function defaultRail(c: Context<AppContext>): Promise<string> {
  const ctx = serviceContext(c);
  const config = getConfig(c.env);
  const viewer = c.get('user') ?? null;
  const users = new UserService(ctx);

  const [tags, suggested, leaders] = await Promise.all([
    ctx.repos.tags.trending(6).catch(() => []),
    viewer ? users.suggested(viewer.id, 4).catch(() => []) : Promise.resolve([]),
    users.leaderboard(5).catch(() => [] as LeaderRow[]),
  ]);

  return [
    trendingTagsWidget(tags.map((t) => ({ slug: t.slug, name: t.name, postCount: t.post_count }))),
    suggestedUsersWidget(suggested, c.get('csrfToken') ?? null),
    leaderboardWidget(leaders as LeaderRow[]),
    aboutWidget(config.siteName, config.siteDescription),
  ].join('\n');
}
