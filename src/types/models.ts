/**
 * Domain model types. These mirror the D1 schema (snake_case rows) and the
 * API-facing shapes (camelCase DTOs) produced by the repositories.
 */

export type UserRole = 'user' | 'moderator' | 'admin';
export type UserStatus = 'active' | 'suspended' | 'banned' | 'deleted';

export type PostContentType = 'text' | 'markdown' | 'article' | 'image' | 'link' | 'code';
export type Visibility = 'public' | 'followers' | 'private';
export type PostStatus = 'published' | 'draft' | 'hidden' | 'deleted';
export type CommentStatus = 'published' | 'hidden' | 'deleted';

export type ReactionTargetType = 'post' | 'comment';
export type ReactionType = 'like' | 'love' | 'insightful' | 'funny' | 'sad';

export type MediaVariant = 'original' | 'thumb' | 'medium';
export type MediaStatus = 'pending' | 'ready' | 'processing' | 'missing' | 'deleted';
export type MediaUsage = 'avatar' | 'cover' | 'post' | 'attachment';

export type NotificationType =
  | 'FOLLOW'
  | 'LIKE'
  | 'COMMENT'
  | 'REPLY'
  | 'MENTION'
  | 'SYSTEM'
  | 'MODERATION';

export type ReportTargetType = 'post' | 'comment' | 'user' | 'media';
export type ReportReason =
  | 'spam'
  | 'harassment'
  | 'hate'
  | 'nsfw'
  | 'violence'
  | 'misinformation'
  | 'copyright'
  | 'other';
export type ReportStatus = 'open' | 'reviewing' | 'resolved' | 'rejected';

// ---------------------------------------------------------------------------
// Raw D1 row shapes
// ---------------------------------------------------------------------------

export interface UserRow {
  id: string;
  username: string;
  display_name: string;
  email: string;
  password_hash: string;
  avatar_media_id: string | null;
  cover_media_id: string | null;
  bio: string;
  location: string;
  website: string;
  role: UserRole;
  status: UserStatus;
  status_reason: string;
  suspended_until: number | null;
  level: number;
  xp: number;
  post_count: number;
  comment_count: number;
  reaction_received_count: number;
  follower_count: number;
  following_count: number;
  email_verified_at: number | null;
  created_at: number;
  updated_at: number;
  last_seen_at: number | null;
  last_login_at: number | null;
  last_xp_daily_at: number | null;
}

export interface SessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: number;
  absolute_expiry: number;
  created_at: number;
  last_seen_at: number;
  ip_hash: string;
  user_agent_hash: string;
  revoked_at: number | null;
}

export interface PostRow {
  id: string;
  author_id: string;
  category_id: string | null;
  title: string;
  slug: string;
  content: string;
  excerpt: string;
  content_type: PostContentType;
  link_url: string;
  code_language: string;
  visibility: Visibility;
  status: PostStatus;
  views: number;
  comment_count: number;
  reaction_count: number;
  bookmark_count: number;
  share_count: number;
  hot_score: number;
  comments_locked: number;
  pinned_at: number | null;
  edited_at: number | null;
  scheduled_at?: number | null;
  quote_post_id?: string | null;
  created_at: number;
  updated_at: number;
}

export interface CommentRow {
  id: string;
  post_id: string;
  author_id: string;
  parent_id: string | null;
  root_id: string | null;
  depth: number;
  content: string;
  status: CommentStatus;
  reaction_count: number;
  reply_count: number;
  edited_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface MediaRow {
  id: string;
  owner_id: string;
  storage_key: string;
  storage_provider: string;
  original_name: string;
  mime_type: string;
  size: number;
  width: number | null;
  height: number | null;
  checksum: string;
  variant: MediaVariant;
  parent_id: string | null;
  visibility: Visibility;
  status: MediaStatus;
  usage_context: MediaUsage;
  created_at: number;
  deleted_at: number | null;
}

export interface NotificationRow {
  id: string;
  user_id: string;
  actor_id: string | null;
  type: NotificationType;
  target_type: string;
  target_id: string;
  data_json: string;
  read_at: number | null;
  created_at: number;
}

export interface ReportRow {
  id: string;
  reporter_id: string;
  target_type: ReportTargetType;
  target_id: string;
  reason: ReportReason;
  description: string;
  status: ReportStatus;
  resolution: string;
  reviewed_by: string | null;
  reviewed_at: number | null;
  created_at: number;
}

// ---------------------------------------------------------------------------
// API-facing DTOs
// ---------------------------------------------------------------------------

/** The authenticated principal carried on the request context. */
export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  email: string;
  role: UserRole;
  status: UserStatus;
  level: number;
  xp: number;
  avatarMediaId: string | null;
  createdAt: number;
}

export interface PublicUser {
  id: string;
  username: string;
  displayName: string;
  bio: string;
  location: string;
  website: string;
  role: UserRole;
  status: UserStatus;
  level: number;
  xp: number;
  avatarMediaId: string | null;
  coverMediaId: string | null;
  postCount: number;
  commentCount: number;
  reactionReceivedCount: number;
  followerCount: number;
  followingCount: number;
  createdAt: number;
  lastSeenAt: number | null;
  /** Populated when the request is authenticated. */
  isFollowing?: boolean;
  isFollowedBy?: boolean;
  isSelf?: boolean;
  badges?: string[];
}

export interface PostMediaDTO {
  id: string;
  mimeType: string;
  width: number | null;
  height: number | null;
  altText: string;
  position: number;
  /** Worker-served URLs; the storage bucket is never addressed by the browser. */
  url: string;
  thumbUrl: string;
}

export interface PostDTO {
  id: string;
  slug: string;
  title: string;
  /** Sanitised, render-ready HTML. Never raw user input. */
  html: string;
  /** Raw source, only returned to users allowed to edit the post. */
  source?: string;
  excerpt: string;
  contentType: PostContentType;
  linkUrl: string;
  codeLanguage: string;
  visibility: Visibility;
  status: PostStatus;
  views: number;
  commentCount: number;
  reactionCount: number;
  bookmarkCount: number;
  shareCount: number;
  createdAt: number;
  updatedAt: number;
  editedAt: number | null;
  author: PublicUser;
  category: { id: string; slug: string; name: string; color: string } | null;
  tags: { slug: string; name: string }[];
  media: PostMediaDTO[];
  viewerReaction: ReactionType | null;
  viewerBookmarked: boolean;
  canEdit: boolean;
  canDelete: boolean;
  canModerate: boolean;
  pinned: boolean;
  canPin: boolean;
  readingMinutes: number;
  scheduledAt?: number | null;
  quotePost?: { id: string; slug: string; title: string; excerpt: string; authorUsername: string } | null;
  poll?: {
    options: { id: string; label: string; voteCount: number }[];
    viewerOptionId: string | null;
    totalVotes: number;
  } | null;
}

export interface CommentDTO {
  id: string;
  postId: string;
  /** Permalink slug of the parent post; used by the profile "replies" tab. */
  postSlug: string;
  parentId: string | null;
  rootId: string | null;
  depth: number;
  html: string;
  source?: string;
  status: CommentStatus;
  reactionCount: number;
  replyCount: number;
  createdAt: number;
  editedAt: number | null;
  author: PublicUser;
  viewerReaction: ReactionType | null;
  canEdit: boolean;
  canDelete: boolean;
  replies?: CommentDTO[];
}

export interface NotificationDTO {
  id: string;
  type: NotificationType;
  targetType: string;
  targetId: string;
  data: Record<string, unknown>;
  readAt: number | null;
  createdAt: number;
  actor: Pick<PublicUser, 'id' | 'username' | 'displayName' | 'avatarMediaId'> | null;
}

export type MessagePeer = Pick<PublicUser, 'id' | 'username' | 'displayName' | 'avatarMediaId'>;

/**
 * What a bubble carries. `text` is the default and the only kind that existed
 * before rich messages; the others always keep a readable `content` fallback so
 * inbox previews, notifications and screen readers never render an empty line.
 */
export type MessageKind = 'text' | 'image' | 'audio' | 'sticker';

export interface MessageDTO {
  id: string;
  conversationId: string;
  content: string;
  kind: MessageKind;
  /** Worker-served attachment URL for `image`/`audio` bubbles. */
  mediaUrl: string | null;
  /** Voice-clip length in milliseconds; 0 when unknown or not audio. */
  durationMs: number;
  createdAt: number;
  /** True when the signed-in viewer wrote it — drives the bubble alignment. */
  mine: boolean;
  sender: MessagePeer;
}

export interface ConversationDTO {
  id: string;
  updatedAt: number;
  peer: MessagePeer & { role: UserRole };
  lastMessage: { content: string; createdAt: number; mine: boolean } | null;
  unreadCount: number;
}

/** A short vertical video: either self-hosted or an official third-party embed. */
export interface ReelDTO {
  id: string;
  provider: 'upload' | 'youtube' | 'tiktok' | 'instagram' | 'facebook';
  providerLabel: string;
  externalId: string;
  /** Canonical page on the source platform, for the "watch on …" link. */
  sourceUrl: string;
  /** iframe src for embedded reels; empty for uploads. */
  embedUrl: string;
  /** Worker-served video URL for uploads; empty for embeds. */
  videoUrl: string;
  posterUrl: string;
  title: string;
  caption: string;
  viewCount: number;
  likeCount: number;
  commentCount: number;
  createdAt: number;
  viewerLiked: boolean;
  canDelete: boolean;
  author: Pick<PublicUser, 'id' | 'username' | 'displayName' | 'avatarMediaId' | 'level'>;
}

export interface MediaDTO {
  id: string;
  mimeType: string;
  size: number;
  width: number | null;
  height: number | null;
  variant: MediaVariant;
  visibility: Visibility;
  status: MediaStatus;
  usageContext: MediaUsage;
  createdAt: number;
  url: string;
  thumbUrl: string;
}

/** Cursor-paginated collection returned by every feed endpoint. */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}
