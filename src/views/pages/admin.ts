/**
 * `/admin` — moderation dashboard.
 *
 * Authorisation happens server-side before this view is ever called; the view
 * only hides controls the viewer cannot use. Every action is a POST form with
 * a CSRF token and is written to `audit_logs` by the moderation service.
 */

import { html, raw } from '../../utils/html';
import type { AuthUser } from '../../types/models';
import type { DashboardStats } from '../../db/repositories/moderation';
import { relativeTime, toIso } from '../../utils/time';

export type AdminTab = 'overview' | 'reports' | 'users' | 'posts' | 'audit';

export interface AdminReportRow {
  id: string;
  targetType: string;
  targetId: string;
  reason: string;
  description: string;
  status: string;
  resolution: string | null;
  reporterUsername: string | null;
  reviewerUsername: string | null;
  createdAt: number;
  reviewedAt: number | null;
}

export interface AdminUserRow {
  id: string;
  username: string;
  displayName: string;
  email?: string;
  role: string;
  status: string;
  level: number;
  xp: number;
  postCount: number;
  createdAt: number;
  lastLoginAt?: number | null;
}

export interface AdminPostRow {
  id: string;
  slug: string;
  title: string | null;
  excerpt: string;
  status: string;
  visibility: string;
  authorUsername: string;
  reactionCount: number;
  commentCount: number;
  createdAt: number;
}

export interface AdminAuditRow {
  id: string;
  actorUsername: string | null;
  action: string;
  targetType: string;
  targetId: string;
  metadata: unknown;
  createdAt: number;
}

export interface AdminDayRow {
  day: string;
  new_users: number;
  new_posts: number;
  new_comments: number;
  new_reactions: number;
  active_users: number;
  media_bytes: number;
}

export interface AdminPageInput {
  viewer: AuthUser;
  tab: AdminTab;
  csrfToken: string | null;
  stats: DashboardStats;
  days: AdminDayRow[];
  reports: AdminReportRow[];
  users: AdminUserRow[];
  posts: AdminPostRow[];
  audit: AdminAuditRow[];
  nextCursor?: string | null;
  baseHref: string;
}

const TABS: { key: AdminTab; label: string; adminOnly?: boolean }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'reports', label: 'Reports' },
  { key: 'users', label: 'Users' },
  { key: 'posts', label: 'Posts' },
  { key: 'audit', label: 'Audit log', adminOnly: true },
];

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function statCard(label: string, value: string | number, hint?: string): string {
  return html`
    <div class="statcard">
      <span class="statcard__value">${String(value)}</span>
      <span class="statcard__label">${label}</span>
      ${hint ? raw(html`<span class="statcard__hint muted">${hint}</span>`) : ''}
    </div>
  `;
}

/** A single moderation action button wrapped in its own CSRF-protected form. */
function actionForm(
  csrf: string,
  action: string,
  targetId: string,
  label: string,
  variant = 'ghost',
): string {
  return html`
    <form class="inlineform" method="post" action="/api/admin/actions" data-settings-form data-reload="1">
      <input type="hidden" name="_csrf" value="${csrf}">
      <input type="hidden" name="action" value="${action}">
      <input type="hidden" name="targetId" value="${targetId}">
      <input type="hidden" name="reason" value="Moderator action from dashboard">
      <button class="btn btn--small btn--${variant}" type="submit">${label}</button>
    </form>
  `;
}

function overview(input: AdminPageInput): string {
  const s = input.stats;
  return html`
    <section class="panel" aria-labelledby="admin-overview">
      <h2 class="panel__title" id="admin-overview">At a glance</h2>
      <div class="statgrid statgrid--admin">
        ${raw(statCard('Members', s.users, `${s.activeUsers} active · ${s.suspendedUsers} restricted`))}
        ${raw(statCard('Posts', s.posts, `${s.publishedPosts} published · ${s.hiddenPosts} hidden`))}
        ${raw(statCard('Comments', s.comments))}
        ${raw(statCard('Reactions', s.reactions))}
        ${raw(statCard('Media files', s.media, formatBytes(s.mediaBytes)))}
        ${raw(statCard('Open reports', s.openReports))}
        ${raw(statCard('Active sessions', s.activeSessions))}
        ${raw(statCard('New today', `${s.newUsers24h} / ${s.newPosts24h}`, 'members / posts in 24h'))}
      </div>
    </section>

    <section class="panel" aria-labelledby="admin-trend">
      <h2 class="panel__title" id="admin-trend">Daily rollup</h2>
      ${input.days.length
        ? raw(html`
            <div class="tablewrap">
              <table class="table">
                <caption class="sr-only">Aggregated activity per day, newest first</caption>
                <thead>
                  <tr>
                    <th scope="col">Day</th><th scope="col">Members</th><th scope="col">Posts</th>
                    <th scope="col">Comments</th><th scope="col">Reactions</th>
                    <th scope="col">Active</th><th scope="col">Media</th>
                  </tr>
                </thead>
                <tbody>
                  ${input.days.map(
                    (day) => raw(html`
                      <tr>
                        <th scope="row">${day.day}</th>
                        <td>${day.new_users}</td>
                        <td>${day.new_posts}</td>
                        <td>${day.new_comments}</td>
                        <td>${day.new_reactions}</td>
                        <td>${day.active_users}</td>
                        <td>${formatBytes(day.media_bytes)}</td>
                      </tr>`),
                  )}
                </tbody>
              </table>
            </div>`)
        : raw(html`<p class="muted">No rollups yet — the nightly cron writes the first row after midnight UTC.</p>`)}
    </section>
  `;
}

function reports(input: AdminPageInput): string {
  const csrf = input.csrfToken ?? '';
  if (!input.reports.length) {
    return html`<section class="panel"><p class="muted">No reports in this view. Nice.</p></section>`;
  }

  return html`
    <section class="panel" aria-labelledby="admin-reports">
      <h2 class="panel__title" id="admin-reports">Reports</h2>
      <ul class="modlist">
        ${input.reports.map(
          (report) => raw(html`
            <li class="modlist__item">
              <div class="modlist__head">
                <span class="pill">${report.targetType}</span>
                <span class="pill pill--muted">${report.status}</span>
                <strong>${report.reason}</strong>
                <time class="muted" datetime="${toIso(report.createdAt)}">${relativeTime(report.createdAt)}</time>
              </div>
              ${report.description ? raw(html`<p class="modlist__desc">${report.description}</p>`) : ''}
              <p class="muted">
                Reported by ${report.reporterUsername ? raw(html`<a href="/u/${report.reporterUsername}">@${report.reporterUsername}</a>`) : 'a deleted account'}
                · target <code>${report.targetId}</code>
                ${report.reviewerUsername ? raw(html`· reviewed by @${report.reviewerUsername}`) : ''}
              </p>
              ${report.resolution ? raw(html`<p class="muted">Resolution: ${report.resolution}</p>`) : ''}

              <div class="modlist__actions">
                ${report.targetType === 'post'
                  ? raw(actionForm(csrf, 'hide_post', report.targetId, 'Hide post', 'danger') + actionForm(csrf, 'restore_post', report.targetId, 'Restore post'))
                  : ''}
                ${report.targetType === 'comment'
                  ? raw(actionForm(csrf, 'hide_comment', report.targetId, 'Hide comment', 'danger') + actionForm(csrf, 'restore_comment', report.targetId, 'Restore comment'))
                  : ''}
                ${report.targetType === 'user'
                  ? raw(actionForm(csrf, 'suspend_user', report.targetId, 'Suspend', 'danger') + actionForm(csrf, 'unsuspend_user', report.targetId, 'Unsuspend'))
                  : ''}
                ${report.targetType === 'media'
                  ? raw(actionForm(csrf, 'delete_media', report.targetId, 'Delete media', 'danger'))
                  : ''}

                <form class="inlineform" method="post" action="/api/admin/reports/${report.id}/resolve"
                      data-settings-form data-reload="1">
                  <input type="hidden" name="_csrf" value="${csrf}">
                  <label class="sr-only" for="res-${report.id}">Resolution for report ${report.id}</label>
                  <select id="res-${report.id}" name="status">
                    <option value="reviewing">Reviewing</option>
                    <option value="resolved">Resolved</option>
                    <option value="rejected">Rejected</option>
                  </select>
                  <input type="text" name="resolution" maxlength="500" placeholder="Note (optional)">
                  <button class="btn btn--small btn--primary" type="submit">Save</button>
                </form>
              </div>
            </li>`),
        )}
      </ul>
    </section>
  `;
}

function usersPanel(input: AdminPageInput): string {
  const csrf = input.csrfToken ?? '';
  const isAdmin = input.viewer.role === 'admin';

  return html`
    <section class="panel" aria-labelledby="admin-users">
      <h2 class="panel__title" id="admin-users">Members</h2>

      <form class="form form--inline" method="get" action="/admin" role="search">
        <input type="hidden" name="tab" value="users">
        <label class="sr-only" for="admin-user-q">Search members</label>
        <input id="admin-user-q" type="search" name="q" maxlength="64" placeholder="username or email">
        <label class="sr-only" for="admin-user-status">Status</label>
        <select id="admin-user-status" name="status">
          <option value="">Any status</option>
          <option value="active">Active</option>
          <option value="suspended">Suspended</option>
          <option value="banned">Banned</option>
        </select>
        <button class="btn btn--small btn--primary" type="submit">Filter</button>
      </form>

      <div class="tablewrap">
        <table class="table">
          <caption class="sr-only">Registered members</caption>
          <thead>
            <tr>
              <th scope="col">Member</th><th scope="col">Role</th><th scope="col">Status</th>
              <th scope="col">Level</th><th scope="col">Posts</th><th scope="col">Joined</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            ${input.users.map(
              (user) => raw(html`
                <tr>
                  <th scope="row">
                    <a href="/u/${user.username}">@${user.username}</a>
                    <span class="muted">${user.displayName}</span>
                  </th>
                  <td>${user.role}</td>
                  <td>${user.status}</td>
                  <td>${user.level}</td>
                  <td>${user.postCount}</td>
                  <td><time datetime="${toIso(user.createdAt)}">${relativeTime(user.createdAt)}</time></td>
                  <td class="table__actions">
                    ${user.status === 'active'
                      ? raw(actionForm(csrf, 'suspend_user', user.id, 'Suspend', 'danger'))
                      : raw(actionForm(csrf, 'unsuspend_user', user.id, 'Reinstate'))}
                    ${isAdmin && user.role === 'user' ? raw(actionForm(csrf, 'promote_moderator', user.id, 'Make mod')) : ''}
                    ${isAdmin && user.role === 'moderator' ? raw(actionForm(csrf, 'demote_moderator', user.id, 'Remove mod')) : ''}
                    ${isAdmin && user.status !== 'banned' ? raw(actionForm(csrf, 'ban_user', user.id, 'Ban', 'danger')) : ''}
                  </td>
                </tr>`),
            )}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function postsPanel(input: AdminPageInput): string {
  const csrf = input.csrfToken ?? '';
  return html`
    <section class="panel" aria-labelledby="admin-posts">
      <h2 class="panel__title" id="admin-posts">Posts</h2>
      <div class="tablewrap">
        <table class="table">
          <caption class="sr-only">Recent posts</caption>
          <thead>
            <tr>
              <th scope="col">Post</th><th scope="col">Author</th><th scope="col">Status</th>
              <th scope="col">Engagement</th><th scope="col">Created</th><th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            ${input.posts.map(
              (post) => raw(html`
                <tr>
                  <th scope="row"><a href="/post/${post.slug}">${post.title || post.excerpt.slice(0, 60) || 'Untitled'}</a></th>
                  <td><a href="/u/${post.authorUsername}">@${post.authorUsername}</a></td>
                  <td>${post.status} / ${post.visibility}</td>
                  <td>${post.reactionCount} ♥ · ${post.commentCount} 💬</td>
                  <td><time datetime="${toIso(post.createdAt)}">${relativeTime(post.createdAt)}</time></td>
                  <td class="table__actions">
                    ${post.status === 'published'
                      ? raw(actionForm(csrf, 'hide_post', post.id, 'Hide', 'danger'))
                      : raw(actionForm(csrf, 'restore_post', post.id, 'Restore'))}
                    ${raw(actionForm(csrf, 'delete_post', post.id, 'Delete', 'danger'))}
                  </td>
                </tr>`),
            )}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function auditPanel(input: AdminPageInput): string {
  return html`
    <section class="panel" aria-labelledby="admin-audit">
      <h2 class="panel__title" id="admin-audit">Audit log</h2>
      <p class="muted">Every moderation action is recorded here with the acting account and target.</p>
      <ul class="auditlist">
        ${input.audit.map(
          (entry) => raw(html`
            <li class="auditlist__item">
              <code>${entry.action}</code>
              <span>by ${entry.actorUsername ? raw(html`<a href="/u/${entry.actorUsername}">@${entry.actorUsername}</a>`) : 'system'}</span>
              <span class="muted">${entry.targetType} <code>${entry.targetId}</code></span>
              <time class="muted" datetime="${toIso(entry.createdAt)}">${relativeTime(entry.createdAt)}</time>
            </li>`),
        )}
      </ul>
    </section>
  `;
}

export function renderAdminPage(input: AdminPageInput): string {
  const visibleTabs = TABS.filter((tab) => !tab.adminOnly || input.viewer.role === 'admin');

  return html`
    <div class="pagehead">
      <h1 class="pagehead__title">Moderation</h1>
      <p class="pagehead__sub muted">
        Signed in as @${input.viewer.username} (${input.viewer.role})
        ${input.stats.openReports ? raw(html` · <strong>${input.stats.openReports}</strong> open reports`) : ''}
      </p>
    </div>

    <nav class="tabs" aria-label="Moderation sections">
      ${visibleTabs.map((tab) => {
        const active = tab.key === input.tab;
        return raw(html`
          <a class="tab ${active ? 'is-active' : ''}" href="/admin?tab=${tab.key}"
             ${active ? raw('aria-current="page"') : ''}>${tab.label}</a>`);
      })}
    </nav>

    ${input.tab === 'overview' ? raw(overview(input)) : ''}
    ${input.tab === 'reports' ? raw(reports(input)) : ''}
    ${input.tab === 'users' ? raw(usersPanel(input)) : ''}
    ${input.tab === 'posts' ? raw(postsPanel(input)) : ''}
    ${input.tab === 'audit' && input.viewer.role === 'admin' ? raw(auditPanel(input)) : ''}
  `;
}
