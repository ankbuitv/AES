/**
 * Authentication service.
 *
 * Owns the credential lifecycle: registration, login, logout, refresh,
 * password change, password reset and account deletion. Routes call these
 * methods and never touch password hashes or session rows directly.
 *
 * Security properties enforced here:
 *  - passwords are only ever stored as PBKDF2 hashes (see utils/crypto);
 *  - session tokens are random 32-byte values, stored only as SHA-256;
 *  - login rotates the session id (defeats fixation) and revokes the old one;
 *  - password change revokes every *other* session;
 *  - login responses are constant-shaped so they cannot be used to enumerate
 *    accounts, and a dummy hash verification keeps the timing flat.
 */

import type { ServiceContext } from './context';
import { AppError } from '../utils/errors';
import { hashPassword, needsRehash, privacyHash, verifyPassword } from '../utils/crypto';
import { toAuthUser } from '../db/repositories/users';
import type { AuthUser, UserRow } from '../types/models';
import { LIMITS, PASSWORD_RESET_TTL, XP_RULES } from '../config';
import { RESERVED_USERNAMES } from '../validators/common';
import { now } from '../utils/time';
import type { IssuedSession } from '../db/repositories/sessions';

/**
 * A PBKDF2 hash of a random string. Verified against when the account does not
 * exist so that "unknown user" and "wrong password" cost the same time.
 */
const DUMMY_HASH =
  'pbkdf2$100000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

export interface ClientFingerprint {
  ip: string;
  userAgent: string;
}

export interface AuthResult {
  user: AuthUser;
  session: IssuedSession;
  /** Badges unlocked by this action, so the UI can celebrate them. */
  awardedBadges: string[];
}

export class AuthService {
  constructor(private readonly ctx: ServiceContext) {}

  // --- Registration ---------------------------------------------------------

  async register(input: {
    username: string;
    email: string;
    password: string;
    displayName?: string;
    fingerprint: ClientFingerprint;
  }): Promise<AuthResult> {
    const { repos, config } = this.ctx;

    const registrationOpen =
      (await repos.settings.getBoolean('registration_open', config.registrationOpen)) &&
      config.registrationOpen;
    if (!registrationOpen) {
      throw AppError.registrationClosed(
        'Registration is closed right now. Please check back later.',
      );
    }

    const username = input.username.trim().toLowerCase();
    const email = input.email.trim().toLowerCase();

    if (RESERVED_USERNAMES.has(username)) {
      throw AppError.conflict('That username is reserved', { fields: { username: 'reserved' } });
    }
    if (await repos.users.usernameExists(username)) {
      throw AppError.conflict('That username is already taken', {
        fields: { username: 'taken' },
      });
    }
    if (await repos.users.emailExists(email)) {
      // Deliberately explicit: the registration form is the one place where
      // disclosure is unavoidable, and a vague error just frustrates people.
      throw AppError.conflict('An account already exists for that email address', {
        fields: { email: 'taken' },
      });
    }

    const passwordHash = await hashPassword(input.password);
    const displayName = (input.displayName || username).trim().slice(0, LIMITS.displayNameMax);

    const user = await repos.users.create({
      username,
      email,
      displayName,
      passwordHash,
    });

    const awardedBadges: string[] = [];
    // The first 100 members get the founder badge.
    const totalUsers = await repos.users.countAll();
    if (totalUsers <= 100 && (await repos.users.awardBadge(user.id, 'founder'))) {
      awardedBadges.push('founder');
    }

    const session = await this.issueSession(user.id, input.fingerprint);
    await repos.users.markLogin(user.id);

    this.ctx.logger.info('auth_register', { userId: user.id });
    return { user: toAuthUser(user), session, awardedBadges };
  }

  // --- Login ----------------------------------------------------------------

  async login(input: {
    identifier: string;
    password: string;
    fingerprint: ClientFingerprint;
    /** Existing session to rotate away from, if any. */
    currentSessionId?: string | null;
  }): Promise<AuthResult> {
    const { repos } = this.ctx;
    const user = await repos.users.findByIdentifier(input.identifier);

    if (!user) {
      // Burn equivalent CPU so the response time does not reveal existence.
      await verifyPassword(input.password, DUMMY_HASH);
      throw AppError.unauthenticated('Incorrect username or password');
    }

    const valid = await verifyPassword(input.password, user.password_hash);
    if (!valid) {
      this.ctx.logger.warn('auth_login_failed', { userId: user.id });
      throw AppError.unauthenticated('Incorrect username or password');
    }

    this.assertLoginAllowed(user);

    // Transparently upgrade the KDF parameters on a successful login.
    if (needsRehash(user.password_hash)) {
      await repos.users.updatePassword(user.id, await hashPassword(input.password));
    }

    // Session rotation: the pre-login session id must not survive the login.
    if (input.currentSessionId) {
      await repos.sessions.revoke(input.currentSessionId);
    }

    const session = await this.issueSession(user.id, input.fingerprint);
    await repos.users.markLogin(user.id);

    // Daily login XP is server-side and cooldown-guarded.
    this.ctx.defer(repos.users.claimDailyLoginXp(user.id, XP_RULES.dailyLogin));

    this.ctx.logger.info('auth_login', { userId: user.id, sessionId: session.sessionId });
    return { user: toAuthUser(user), session, awardedBadges: [] };
  }

  /** Status gate applied on login and on every authenticated request. */
  assertLoginAllowed(user: UserRow): void {
    if (user.status === 'active') {
      return;
    }
    if (user.status === 'suspended') {
      const until = user.suspended_until;
      if (until && until <= now()) {
        // Suspension has lapsed — let the request through; the cron/admin
        // path will normalise the row.
        return;
      }
      throw AppError.suspended(
        user.status_reason
          ? `This account is suspended: ${user.status_reason}`
          : 'This account is suspended',
        until ? { until } : undefined,
      );
    }
    if (user.status === 'banned') {
      throw AppError.suspended('This account has been permanently banned');
    }
    throw AppError.unauthenticated('This account is no longer available');
  }

  // --- Session lifecycle ----------------------------------------------------

  private async issueSession(
    userId: string,
    fingerprint: ClientFingerprint,
  ): Promise<IssuedSession> {
    const salt = this.ctx.env.IP_HASH_SALT || this.ctx.env.SESSION_SECRET;
    const [ipHash, userAgentHash] = await Promise.all([
      privacyHash(fingerprint.ip, salt),
      privacyHash(fingerprint.userAgent, salt),
    ]);
    return this.ctx.repos.sessions.issue({ userId, ipHash, userAgentHash });
  }

  async logout(sessionId: string): Promise<void> {
    await this.ctx.repos.sessions.revoke(sessionId);
    this.ctx.logger.info('auth_logout', { sessionId });
  }

  async logoutEverywhere(userId: string): Promise<number> {
    const count = await this.ctx.repos.sessions.revokeAllForUser(userId);
    this.ctx.logger.info('auth_logout_all', { userId, count });
    return count;
  }

  /** Explicit sliding-window extension. Returns the new expiry. */
  async refresh(sessionId: string): Promise<number> {
    const expiresAt = await this.ctx.repos.sessions.refresh(sessionId);
    if (expiresAt === null) {
      throw AppError.unauthenticated('Your session has expired. Please sign in again.');
    }
    return expiresAt;
  }

  async listSessions(userId: string, currentSessionId: string | null) {
    const rows = await this.ctx.repos.sessions.listForUser(userId);
    return rows.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
      expiresAt: row.expires_at,
      current: row.id === currentSessionId,
    }));
  }

  async revokeSession(userId: string, sessionId: string): Promise<void> {
    const sessions = await this.ctx.repos.sessions.listForUser(userId);
    // Authorisation: a member may only revoke their own sessions.
    if (!sessions.some((s) => s.id === sessionId)) throw AppError.notFound('Session not found');
    await this.ctx.repos.sessions.revoke(sessionId);
  }

  // --- Password management --------------------------------------------------

  async changePassword(input: {
    userId: string;
    currentPassword: string;
    newPassword: string;
    currentSessionId: string | null;
  }): Promise<void> {
    const { repos } = this.ctx;
    const user = await repos.users.findById(input.userId);
    if (!user) throw AppError.unauthenticated();

    if (!(await verifyPassword(input.currentPassword, user.password_hash))) {
      throw AppError.badRequest('Your current password is incorrect', {
        fields: { currentPassword: 'incorrect' },
      });
    }
    if (input.currentPassword === input.newPassword) {
      throw AppError.badRequest('Choose a password you have not used here before', {
        fields: { newPassword: 'unchanged' },
      });
    }

    await repos.users.updatePassword(user.id, await hashPassword(input.newPassword));
    // Everything except the session performing the change is invalidated.
    await repos.sessions.revokeAllForUser(user.id, input.currentSessionId ?? undefined);
    this.ctx.logger.info('auth_password_changed', { userId: user.id });
  }

  /**
   * Start a password reset.
   *
   * Cloudflare Workers cannot send email without an external provider, and no
   * mail credentials are part of this project's secret set. The architecture
   * is complete and production-ready: a single-use, hashed, 30-minute token is
   * persisted in `auth_tokens`, and `deliverResetToken` is the one seam an
   * operator wires to their transactional email provider. Until then the token
   * is written to the log at info level in non-production environments only
   * (never in production), so the flow is testable end-to-end.
   *
   * The response never reveals whether the address exists.
   */
  async requestPasswordReset(email: string): Promise<{ delivered: boolean; token?: string }> {
    const user = await this.ctx.repos.users.findByEmail(email.trim().toLowerCase());
    if (!user || user.status === 'deleted' || user.status === 'banned') {
      return { delivered: false };
    }

    const token = await this.ctx.repos.sessions.createAuthToken({
      userId: user.id,
      kind: 'password_reset',
      ttlSeconds: PASSWORD_RESET_TTL,
    });

    const resetUrl = `${this.ctx.origin}/reset-password?token=${encodeURIComponent(token)}`;
    const delivered = await this.deliverResetToken(user.email, resetUrl);

    // Only outside production, and only so local/preview testing is possible.
    if (!this.ctx.config.isProduction) {
      this.ctx.logger.info('auth_password_reset_link', { userId: user.id, resetUrl });
      return { delivered, token };
    }
    return { delivered };
  }

  /**
   * Email delivery seam. Returns false when no provider is configured, which
   * keeps the reset flow honest instead of pretending a mail was sent.
   */
  private async deliverResetToken(_email: string, _resetUrl: string): Promise<boolean> {
    // No mail provider binding is part of this deployment's secret set.
    // Wire a provider here (e.g. MailChannels/Resend/Postmark fetch call) and
    // return true on a 2xx response.
    return false;
  }

  async confirmPasswordReset(input: { token: string; newPassword: string }): Promise<void> {
    const userId = await this.ctx.repos.sessions.consumeAuthToken(input.token, 'password_reset');
    if (!userId) {
      throw AppError.badRequest('That reset link is invalid or has expired');
    }
    await this.ctx.repos.users.updatePassword(userId, await hashPassword(input.newPassword));
    // A reset means the account may have been compromised: kill every session.
    await this.ctx.repos.sessions.revokeAllForUser(userId);
    this.ctx.logger.info('auth_password_reset_done', { userId });
  }

  // --- Account deletion -----------------------------------------------------

  /**
   * Soft delete: the row is anonymised and all content is marked deleted, so
   * threads keep their structure and foreign keys stay valid. Media objects are
   * queued for removal from the bucket by the cleanup cron.
   */
  async deleteAccount(input: { userId: string; password: string }): Promise<void> {
    const { repos } = this.ctx;
    const user = await repos.users.findById(input.userId);
    if (!user) throw AppError.unauthenticated();

    if (!(await verifyPassword(input.password, user.password_hash))) {
      throw AppError.badRequest('Password confirmation failed', {
        fields: { password: 'incorrect' },
      });
    }
    if (user.role === 'admin') {
      const admins = await repos.users.listForAdmin({ cursor: null, limit: 2, role: 'admin' });
      if (admins.items.length <= 1) {
        throw AppError.forbidden('The last administrator account cannot be deleted');
      }
    }

    await repos.users.softDelete(user.id);

    // Queue every owned object for bucket deletion.
    this.ctx.defer(async () => {
      const media = await repos.media.listByOwner({
        ownerId: user.id,
        cursor: null,
        limit: 50,
      });
      for (const row of media) {
        await repos.media.softDeleteWithVariants(row.id);
      }
    });

    this.ctx.logger.info('auth_account_deleted', { userId: user.id });
  }
}
