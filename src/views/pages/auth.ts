/**
 * Sign in, register and password-reset screens.
 *
 * These are ordinary forms that post to the API with a CSRF field, so they
 * work with JavaScript disabled; the client intercepts them for inline error
 * messages. Errors are passed in from the route, never read from `location`.
 */

import { html, raw } from '../../utils/html';
import { LIMITS } from '../../config';

export interface AuthPageInput {
  csrfToken: string | null;
  error?: string | null;
  notice?: string | null;
  /** Path to return to after a successful sign-in. */
  next?: string;
  registrationOpen?: boolean;
  siteName?: string;
}

function alerts(input: AuthPageInput): string {
  return html`
    ${input.error ? raw(html`<p class="alert alert--error" role="alert">${input.error}</p>`) : ''}
    ${input.notice ? raw(html`<p class="alert alert--info" role="status">${input.notice}</p>`) : ''}
  `;
}

export function renderLoginPage(input: AuthPageInput): string {
  return html`
    <section class="authcard" aria-labelledby="auth-title">
      <img class="authcard__logo" src="/logo-mark.svg" width="40" height="40" alt="">
      <h1 class="authcard__title" id="auth-title">Welcome back</h1>
      <p class="muted">Sign in to ${input.siteName ?? 'AES'} to post, comment and follow.</p>
      ${raw(alerts(input))}

      <form class="form" method="post" action="/api/auth/login" data-auth-form data-redirect="${input.next ?? '/'}">
        <input type="hidden" name="_csrf" value="${input.csrfToken ?? ''}">
        <input type="hidden" name="next" value="${input.next ?? '/'}">

        <div class="field">
          <label for="identifier">Username or email</label>
          <input id="identifier" name="identifier" type="text" required autocomplete="username"
                 autocapitalize="none" spellcheck="false" maxlength="255">
        </div>

        <div class="field">
          <label for="password">Password</label>
          <input id="password" name="password" type="password" required autocomplete="current-password"
                 minlength="${LIMITS.passwordMin}" maxlength="${LIMITS.passwordMax}">
        </div>

        <label class="checkbox">
          <input type="checkbox" name="remember" value="true" checked>
          <span>Keep me signed in on this device</span>
        </label>

        <button class="btn btn--primary btn--block" type="submit">Sign in</button>
        <p class="form__error" data-form-error role="alert" hidden></p>
      </form>

      <p class="authcard__foot">
        <a href="/forgot-password">Forgot your password?</a> ·
        New here? <a href="/register">Create an account</a>
      </p>
    </section>
  `;
}

export function renderRegisterPage(input: AuthPageInput): string {
  if (input.registrationOpen === false) {
    return html`
      <section class="authcard" aria-labelledby="auth-title">
        <h1 class="authcard__title" id="auth-title">Registration is closed</h1>
        <p class="muted">New accounts are paused right now. Check back soon.</p>
        <a class="btn btn--ghost btn--block" href="/">Back to the feed</a>
      </section>
    `;
  }

  return html`
    <section class="authcard" aria-labelledby="auth-title">
      <img class="authcard__logo" src="/logo-mark.svg" width="40" height="40" alt="">
      <h1 class="authcard__title" id="auth-title">Join AES</h1>
      <p class="muted">Pick a handle. You can change your display name later.</p>
      ${raw(alerts(input))}

      <form class="form" method="post" action="/api/auth/register" data-auth-form data-redirect="/">
        <input type="hidden" name="_csrf" value="${input.csrfToken ?? ''}">

        <div class="field">
          <label for="username">Username</label>
          <input id="username" name="username" type="text" required autocomplete="username"
                 autocapitalize="none" spellcheck="false"
                 minlength="${LIMITS.usernameMin}" maxlength="${LIMITS.usernameMax}"
                 pattern="[A-Za-z0-9_]+" aria-describedby="username-hint">
          <p class="field__hint" id="username-hint">Letters, numbers and underscores. ${LIMITS.usernameMin}–${LIMITS.usernameMax} characters.</p>
        </div>

        <div class="field">
          <label for="email">Email</label>
          <input id="email" name="email" type="email" required autocomplete="email" maxlength="255">
        </div>

        <div class="field">
          <label for="displayName">Display name (optional)</label>
          <input id="displayName" name="displayName" type="text" maxlength="${LIMITS.displayNameMax}" autocomplete="name">
        </div>

        <div class="field">
          <label for="password">Password</label>
          <input id="password" name="password" type="password" required autocomplete="new-password"
                 minlength="${LIMITS.passwordMin}" maxlength="${LIMITS.passwordMax}" aria-describedby="password-hint">
          <p class="field__hint" id="password-hint">At least ${LIMITS.passwordMin} characters. Use something unique.</p>
        </div>

        <button class="btn btn--primary btn--block" type="submit">Create account</button>
        <p class="form__error" data-form-error role="alert" hidden></p>
      </form>

      <p class="authcard__foot">Already a member? <a href="/login">Sign in</a></p>
    </section>
  `;
}

export function renderForgotPasswordPage(input: AuthPageInput): string {
  return html`
    <section class="authcard" aria-labelledby="auth-title">
      <h1 class="authcard__title" id="auth-title">Reset your password</h1>
      <p class="muted">Enter your email and we will send a reset link if the address is registered.</p>
      ${raw(alerts(input))}

      <form class="form" method="post" action="/api/auth/password/reset" data-auth-form data-redirect="">
        <input type="hidden" name="_csrf" value="${input.csrfToken ?? ''}">
        <div class="field">
          <label for="email">Email</label>
          <input id="email" name="email" type="email" required autocomplete="email" maxlength="255">
        </div>
        <button class="btn btn--primary btn--block" type="submit">Send reset link</button>
        <p class="form__error" data-form-error role="alert" hidden></p>
      </form>

      <p class="authcard__foot"><a href="/login">Back to sign in</a></p>
    </section>
  `;
}

export function renderResetPasswordPage(input: AuthPageInput & { token: string }): string {
  return html`
    <section class="authcard" aria-labelledby="auth-title">
      <h1 class="authcard__title" id="auth-title">Choose a new password</h1>
      ${raw(alerts(input))}

      <form class="form" method="post" action="/api/auth/password/reset/confirm" data-auth-form data-redirect="/login">
        <input type="hidden" name="_csrf" value="${input.csrfToken ?? ''}">
        <input type="hidden" name="token" value="${input.token}">
        <div class="field">
          <label for="password">New password</label>
          <input id="password" name="password" type="password" required autocomplete="new-password"
                 minlength="${LIMITS.passwordMin}" maxlength="${LIMITS.passwordMax}">
        </div>
        <button class="btn btn--primary btn--block" type="submit">Update password</button>
        <p class="form__error" data-form-error role="alert" hidden></p>
      </form>
    </section>
  `;
}
