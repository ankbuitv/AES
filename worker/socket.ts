/**
 * WebSocket upgrade for a conversation.
 *
 * This lives outside the Hono app on purpose. Hono's `c.res` setter re-wraps a
 * response with `new Response(body, init)`, which silently drops the
 * non-standard `webSocket` property that a 101 must carry — routing the
 * upgrade through the app would hand the client a broken handshake. So the
 * entrypoint checks for this one path first, does its own authentication, and
 * returns the 101 untouched.
 *
 * Because the handshake is a GET, the CSRF middleware would not have run
 * either. The checks that middleware normally provides are therefore made
 * explicit here:
 *   1. `Origin` must match this deployment — a WebSocket is not subject to CORS,
 *      so without this any site could open an authenticated socket.
 *   2. The session cookie must resolve to an active user.
 *   3. The user must be a member of the conversation.
 * Only then is the request forwarded to the Durable Object, with the verified
 * identity attached as headers the browser had no way to set.
 */

import type { Bindings } from '../src/types/env';
import { SESSION_COOKIE, resolveOrigin } from '../src/config';
import { getCookie } from '../src/utils/cookies';
import { createRepositories } from '../src/db/repositories';
import { toAuthUser } from '../src/db/repositories/users';

const SOCKET_PATH = /^\/api\/community\/conversations\/([A-Za-z0-9_-]{3,64})\/socket$/;

/**
 * @returns a Response when the request is a conversation upgrade (including
 * every failure mode), or `null` to let the normal Hono app handle it.
 */
export async function handleConversationSocket(
  request: Request,
  env: Bindings,
): Promise<Response | null> {
  const url = new URL(request.url);
  const match = SOCKET_PATH.exec(url.pathname);
  if (!match) return null;

  const conversationId = match[1] ?? '';
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
    // Not an upgrade: fall through so the router can answer with a 404/405
    // rather than pretending this endpoint does not exist.
    return null;
  }

  if (!env.CONVERSATIONS) {
    // Deployed without the Durable Object migration. Say so explicitly: the
    // client falls back to polling on 501 instead of retrying the handshake.
    return new Response('WebSocket transport is not enabled', { status: 501 });
  }

  const origin = request.headers.get('origin');
  if (!isAllowedOrigin(origin, request, env)) {
    return new Response('Forbidden origin', { status: 403 });
  }

  const token = getCookie(request, SESSION_COOKIE);
  if (!token) return new Response('Unauthorized', { status: 401 });

  const repos = createRepositories(env.DB);
  const resolved = await repos.sessions.resolve(token);
  if (!resolved) return new Response('Unauthorized', { status: 401 });
  const user = toAuthUser(resolved.user);

  const member = await repos.messages.isMember(conversationId, user.id);
  // 404, not 403: a stranger must not be able to probe which rooms exist.
  if (!member) return new Response('Not found', { status: 404 });

  const namespace = env.CONVERSATIONS;
  const stub = namespace.get(namespace.idFromName(conversationId));

  // Forward the original request (the runtime needs the upgrade headers) with
  // the verified identity added.
  const headers = new Headers(request.headers);
  headers.set('x-aes-user-id', user.id);
  headers.set('x-aes-username', user.username);
  headers.set('x-aes-display-name', user.displayName || user.username);

  return stub.fetch(
    new Request(`https://conversation.internal/socket?c=${encodeURIComponent(conversationId)}`, {
      method: 'GET',
      headers,
    }),
  );
}

/**
 * A missing `Origin` is rejected: every browser sends one on a WebSocket
 * handshake, so its absence means a non-browser client, which has no business
 * using a cookie-authenticated socket.
 */
function isAllowedOrigin(origin: string | null, request: Request, env: Bindings): boolean {
  if (!origin) return false;
  const url = new URL(request.url);
  const allowed = new Set([`${url.protocol}//${url.host}`, resolveOrigin(env, request)]);
  // The dev/preview proxy terminates TLS, so accept the https twin of the host.
  allowed.add(`https://${url.host}`);
  return allowed.has(origin);
}
