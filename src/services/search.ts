/**
 * Search.
 *
 * Callers depend on the `SearchProvider` interface only. The shipped
 * implementation is `Fts5SearchProvider`, backed by the SQLite FTS5 virtual
 * table created in migration 0008 and kept in sync by triggers — a real
 * inverted index, not a LIKE scan. Swapping in an external engine
 * (Typesense/Algolia/Vectorize) later means writing one more class and
 * changing the factory, with no route changes.
 *
 * Known limitation: FTS5 ranks by BM25 over the whole index and cannot filter
 * by the viewer's follow graph, so post results are re-checked for visibility
 * in SQL and only then paginated. Pagination for FTS uses an offset-free
 * approach where possible; because BM25 ranks are not monotonic keys, ranked
 * post search falls back to a bounded rank window (see `searchPosts`) — the
 * result set is capped at `MAX_SEARCH_DEPTH` items, which is the standard
 * production trade-off for relevance-ranked search.
 */

import type { Db } from '../db/client';
import type { Repositories } from '../db/repositories';
import { toPublicUser } from '../db/repositories/users';
import type { PostWithAuthor } from '../db/repositories/posts';
import type { PublicUser } from '../types/models';
import type { TagRow } from '../db/repositories/tags';
import { AppError } from '../utils/errors';

export interface SearchHitPost {
  post: PostWithAuthor;
  /** Relevance score; higher is better. */
  score: number;
}

export interface SearchResults {
  posts: SearchHitPost[];
  users: PublicUser[];
  tags: TagRow[];
  /** Offset-style token for the next slice of ranked results, or null. */
  nextCursor: string | null;
  hasMore: boolean;
  /** Echoed back so the UI can highlight what was actually searched. */
  query: string;
}

export interface SearchQuery {
  query: string;
  type: 'posts' | 'users' | 'tags' | 'all';
  viewerId: string | null;
  limit: number;
  /** Rank offset produced by a previous page. */
  offset?: number;
}

export interface SearchProvider {
  readonly name: string;
  search(input: SearchQuery): Promise<SearchResults>;
  /**
   * Hook for providers that maintain an external index. The FTS5 provider is
   * trigger-driven so these are no-ops, but the contract exists so a future
   * provider can be dropped in without touching the post service.
   */
  indexPost?(postId: string): Promise<void>;
  removePost?(postId: string): Promise<void>;
}

/** Ranked search cannot page forever; cap the reachable depth. */
export const MAX_SEARCH_DEPTH = 200;

/**
 * Turn free user input into a safe FTS5 MATCH expression.
 *
 * FTS5 has its own query syntax (NEAR, column filters, `-`, `"`, `*`, `^`).
 * Passing raw input through would let a visitor trigger syntax errors or
 * expensive queries, so every token is quoted as a literal and a trailing
 * prefix wildcard is added to the last token for as-you-type behaviour.
 */
export function toFtsMatchExpression(raw: string): string {
  const tokens = String(raw ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_#@-]/gu, ' ')
    .split(/\s+/)
    .map((token) => token.replace(/^[#@]/, '').trim())
    .filter((token) => token.length > 0 && token.length <= 40)
    .slice(0, 8);

  if (!tokens.length) return '';

  return tokens
    .map((token, index) => {
      const quoted = `"${token.replace(/"/g, '')}"`;
      // Prefix-match only the final token so partial words still match.
      return index === tokens.length - 1 && token.length >= 2 ? `${quoted}*` : quoted;
    })
    .join(' AND ');
}

export class Fts5SearchProvider implements SearchProvider {
  readonly name = 'fts5';

  constructor(
    private readonly db: Db,
    private readonly repos: Repositories,
  ) {}

  async search(input: SearchQuery): Promise<SearchResults> {
    const query = input.query.trim();
    if (!query) throw AppError.badRequest('Enter a search term');

    const wantPosts = input.type === 'posts' || input.type === 'all';
    const wantUsers = input.type === 'users' || input.type === 'all';
    const wantTags = input.type === 'tags' || input.type === 'all';

    // "all" shows a preview of each section; a focused tab gets the full page.
    const postLimit = input.type === 'all' ? Math.min(input.limit, 10) : input.limit;
    const sideLimit = input.type === 'all' ? 5 : input.limit;

    const [posts, users, tags] = await Promise.all([
      wantPosts
        ? this.searchPosts(query, input.viewerId, postLimit, input.offset ?? 0)
        : Promise.resolve({ hits: [], hasMore: false }),
      wantUsers ? this.searchUsers(query, sideLimit) : Promise.resolve([]),
      wantTags ? this.repos.tags.search(query, sideLimit) : Promise.resolve([]),
    ]);

    const nextOffset = (input.offset ?? 0) + postLimit;
    return {
      posts: posts.hits,
      users,
      tags,
      hasMore: posts.hasMore,
      nextCursor: posts.hasMore && nextOffset < MAX_SEARCH_DEPTH ? String(nextOffset) : null,
      query,
    };
  }

  /**
   * Post search: FTS5 MATCH joined back to `posts` so the viewer's visibility
   * rules are applied in SQL. Blocked authors and non-public posts can never
   * surface through search.
   */
  private async searchPosts(
    query: string,
    viewerId: string | null,
    limit: number,
    offset: number,
  ): Promise<{ hits: SearchHitPost[]; hasMore: boolean }> {
    const match = toFtsMatchExpression(query);
    if (!match) return { hits: [], hasMore: false };

    const safeOffset = Math.max(0, Math.min(offset, MAX_SEARCH_DEPTH));
    const params: (string | number)[] = [match];

    let visibility: string;
    if (viewerId) {
      visibility = `(
        p.author_id = ?
        OR (
          p.visibility = 'public'
          OR (p.visibility = 'followers'
              AND EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = ? AND f.following_id = p.author_id))
        )
      )
      AND NOT EXISTS (
        SELECT 1 FROM blocks b
        WHERE (b.blocker_id = ? AND b.blocked_id = p.author_id)
           OR (b.blocker_id = p.author_id AND b.blocked_id = ?)
      )`;
      params.push(viewerId, viewerId, viewerId, viewerId);
    } else {
      visibility = `p.visibility = 'public'`;
    }

    // bm25() returns a *negative* score where lower is better; negate it so
    // "higher is better" holds for callers.
    const rows = await this.db.all<PostWithAuthor & { score: number }>(
      `SELECT p.*,
              u.username           AS author_username,
              u.display_name       AS author_display_name,
              u.avatar_media_id    AS author_avatar_media_id,
              u.role               AS author_role,
              u.level              AS author_level,
              u.status             AS author_status,
              c.slug               AS category_slug,
              c.name               AS category_name,
              c.color              AS category_color,
              -bm25(posts_fts, 8.0, 1.0) AS score
       FROM posts_fts
       JOIN posts p ON p.id = posts_fts.post_id
       JOIN users u ON u.id = p.author_id
       LEFT JOIN categories c ON c.id = p.category_id
       WHERE posts_fts MATCH ?
         AND p.status = 'published'
         AND u.status = 'active'
         AND ${visibility}
       ORDER BY score DESC, p.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limit + 1, safeOffset],
    );

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      hits: page.map((row) => ({ post: row, score: row.score })),
      hasMore,
    };
  }

  /**
   * User search stays on the B-tree index (`idx_users_display_name`):
   * usernames are short and prefix matching is what people expect, so FTS
   * would add cost without improving results.
   */
  private async searchUsers(query: string, limit: number): Promise<PublicUser[]> {
    const rows = await this.repos.users.search(query.replace(/^@/, ''), limit);
    return rows.map((row) => toPublicUser(row));
  }
}

/**
 * Provider factory. Today there is exactly one implementation; the indirection
 * is what keeps `search` swappable per the storage/search abstraction rule.
 */
export function getSearchProvider(db: Db, repos: Repositories): SearchProvider {
  return new Fts5SearchProvider(db, repos);
}

/** Parse the opaque search page token back into a rank offset. */
export function parseSearchOffset(cursor: string | undefined | null): number {
  if (!cursor) return 0;
  const n = Number(cursor);
  if (!Number.isFinite(n) || n < 0 || n > MAX_SEARCH_DEPTH) {
    throw AppError.badRequest('Invalid cursor');
  }
  return Math.trunc(n);
}
