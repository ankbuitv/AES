/**
 * Repository registry.
 *
 * One instance per request, built from the D1 binding. Services take this
 * object rather than the raw database, so no layer above `src/db` ever sees
 * SQL.
 */

import { Db } from '../client';
import { UserRepository } from './users';
import { SessionRepository } from './sessions';
import { PostRepository } from './posts';
import { CommentRepository } from './comments';
import { BookmarkRepository, ReactionRepository } from './reactions';
import { MediaRepository } from './media';
import { JobRepository, NotificationRepository } from './notifications';
import { AuditRepository, ReportRepository, StatsRepository } from './moderation';
import { CategoryRepository, SettingsRepository, TagRepository } from './tags';
import { MentionRepository } from './mentions';

export interface Repositories {
  db: Db;
  users: UserRepository;
  sessions: SessionRepository;
  posts: PostRepository;
  comments: CommentRepository;
  reactions: ReactionRepository;
  bookmarks: BookmarkRepository;
  media: MediaRepository;
  notifications: NotificationRepository;
  jobs: JobRepository;
  reports: ReportRepository;
  audit: AuditRepository;
  stats: StatsRepository;
  tags: TagRepository;
  categories: CategoryRepository;
  settings: SettingsRepository;
  mentions: MentionRepository;
}

export function createRepositories(d1: D1Database): Repositories {
  const db = new Db(d1);
  return {
    db,
    users: new UserRepository(db),
    sessions: new SessionRepository(db),
    posts: new PostRepository(db),
    comments: new CommentRepository(db),
    reactions: new ReactionRepository(db),
    bookmarks: new BookmarkRepository(db),
    media: new MediaRepository(db),
    notifications: new NotificationRepository(db),
    jobs: new JobRepository(db),
    reports: new ReportRepository(db),
    audit: new AuditRepository(db),
    stats: new StatsRepository(db),
    tags: new TagRepository(db),
    categories: new CategoryRepository(db),
    settings: new SettingsRepository(db),
    mentions: new MentionRepository(db),
  };
}

export * from './users';
export * from './sessions';
export * from './posts';
export * from './comments';
export * from './reactions';
export * from './media';
export * from './notifications';
export * from './moderation';
export * from './tags';
export * from './mentions';
