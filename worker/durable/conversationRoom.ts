/**
 * ConversationRoom — one Durable Object per conversation.
 *
 * Its only job is *delivery*. Messages are written to D1 by the API before they
 * ever reach this class (see `MessageService.send`), so the room holds no
 * authoritative state: it keeps the set of sockets currently watching a
 * conversation and pushes each new message, typing signal and presence change
 * to them. Losing the object — eviction, redeploy, an error — costs nothing but
 * a reconnect, and clients recover the gap with `?after=<cursor>`.
 *
 * Authorisation happens in the Worker, never here. A socket only reaches this
 * object after `requireAuth` and a `conversation_members` check, and the
 * verified identity is pinned to the socket as an attachment so a client cannot
 * claim to be someone else afterwards.
 *
 * The WebSocket Hibernation API is used deliberately: an idle room is evicted
 * from memory while its sockets stay open, so an open chat tab costs no
 * duration billing. That is also why per-socket state lives in an attachment
 * rather than in a field — the instance may be recreated between two frames.
 */

const MAX_CLIENT_FRAME_BYTES = 4_096;
/** Frames per socket per window; a client that exceeds it is disconnected. */
const CLIENT_FRAME_LIMIT = 60;
const CLIENT_FRAME_WINDOW_MS = 10_000;

interface SocketIdentity {
  userId: string;
  username: string;
  displayName: string;
  /** Rolling frame-rate window, stored with the socket so hibernation keeps it. */
  windowStart: number;
  frames: number;
}

type ServerFrame =
  | { type: 'ready'; conversationId: string; you: string; online: string[] }
  | { type: 'message'; message: unknown }
  | { type: 'typing'; userId: string; username: string }
  | { type: 'presence'; online: string[] }
  | { type: 'pong'; t: number }
  | { type: 'error'; message: string };

export class ConversationRoom {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: unknown,
  ) {
    void this.env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/broadcast') {
      return this.handleBroadcast(request);
    }
    if (url.pathname === '/socket') {
      return this.handleSocket(request, url);
    }
    return new Response('Not found', { status: 404 });
  }

  /**
   * Server-to-room push. Only ever called by the Worker over the internal
   * binding (Durable Object fetches are not routable from the internet), so no
   * further authentication is needed here.
   */
  private async handleBroadcast(request: Request): Promise<Response> {
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return new Response('Bad request', { status: 400 });
    }
    if (!payload || typeof payload !== 'object') {
      return new Response('Bad request', { status: 400 });
    }
    const delivered = this.broadcast(payload as ServerFrame);
    return Response.json({ delivered });
  }

  /**
   * Upgrade a request that the Worker has already authenticated. The identity
   * arrives as headers the Worker sets — the client cannot forge them because
   * the request is constructed server-side.
   */
  private handleSocket(request: Request, url: URL): Response {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }
    const userId = request.headers.get('x-aes-user-id') ?? '';
    if (!userId) return new Response('Unauthorized', { status: 401 });

    const identity: SocketIdentity = {
      userId,
      username: request.headers.get('x-aes-username') ?? '',
      displayName: request.headers.get('x-aes-display-name') ?? '',
      windowStart: Date.now(),
      frames: 0,
    };
    const conversationId = url.searchParams.get('c') ?? '';

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    // Hibernatable accept: the runtime keeps the socket while this object is
    // evicted, and re-creates the instance only when a frame arrives.
    this.state.acceptWebSocket(server, [userId]);
    server.serializeAttachment(identity);

    this.send(server, {
      type: 'ready',
      conversationId,
      you: userId,
      online: this.onlineUserIds(),
    });
    // Tell everyone else who just arrived.
    this.broadcast({ type: 'presence', online: this.onlineUserIds() }, server);

    return new Response(null, { status: 101, webSocket: client });
  }

  // --- Hibernation callbacks ------------------------------------------------

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return; // binary frames are not part of the protocol
    if (message.length > MAX_CLIENT_FRAME_BYTES) {
      this.send(ws, { type: 'error', message: 'Frame too large' });
      return;
    }

    const identity = this.identityOf(ws);
    if (!identity) {
      ws.close(1008, 'Unknown socket');
      return;
    }
    if (!this.allowFrame(ws, identity)) {
      ws.close(1008, 'Too many frames');
      return;
    }

    let frame: unknown;
    try {
      frame = JSON.parse(message);
    } catch {
      return;
    }
    if (!frame || typeof frame !== 'object') return;
    const type = (frame as { type?: unknown }).type;

    switch (type) {
      case 'ping':
        // Keeps intermediaries from dropping an idle connection. Outgoing
        // frames are not billed, so this is cheap.
        this.send(ws, { type: 'pong', t: Date.now() });
        return;
      case 'typing':
        this.broadcast(
          { type: 'typing', userId: identity.userId, username: identity.username },
          ws,
        );
        return;
      default:
        // Sending is done over the authenticated, CSRF-protected HTTP endpoint
        // so that one code path owns validation, rate limiting and persistence.
        return;
    }
  }

  async webSocketClose(ws: WebSocket, code: number, _reason: string, _wasClean: boolean): Promise<void> {
    try {
      // 1005/1006 are reserved and may not be echoed back.
      ws.close(code === 1005 || code === 1006 ? 1000 : code, 'closed');
    } catch {
      /* already closed */
    }
    this.broadcast({ type: 'presence', online: this.onlineUserIds(ws) }, ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.broadcast({ type: 'presence', online: this.onlineUserIds(ws) }, ws);
  }

  // --- Helpers --------------------------------------------------------------

  private identityOf(ws: WebSocket): SocketIdentity | null {
    try {
      const raw: unknown = ws.deserializeAttachment();
      if (raw && typeof raw === 'object' && typeof (raw as SocketIdentity).userId === 'string') {
        return raw as SocketIdentity;
      }
    } catch {
      /* fall through */
    }
    return null;
  }

  /** Sliding window kept on the socket attachment (survives hibernation). */
  private allowFrame(ws: WebSocket, identity: SocketIdentity): boolean {
    const nowMs = Date.now();
    let { windowStart, frames } = identity;
    if (nowMs - windowStart > CLIENT_FRAME_WINDOW_MS) {
      windowStart = nowMs;
      frames = 0;
    }
    frames += 1;
    try {
      ws.serializeAttachment({ ...identity, windowStart, frames });
    } catch {
      /* socket closing */
    }
    return frames <= CLIENT_FRAME_LIMIT;
  }

  private onlineUserIds(exclude?: WebSocket): string[] {
    const ids = new Set<string>();
    for (const socket of this.state.getWebSockets()) {
      if (exclude && socket === exclude) continue;
      const identity = this.identityOf(socket);
      if (identity) ids.add(identity.userId);
    }
    return [...ids];
  }

  private send(ws: WebSocket, frame: ServerFrame): void {
    try {
      ws.send(JSON.stringify(frame));
    } catch {
      /* a socket that cannot be written to is about to be closed anyway */
    }
  }

  private broadcast(frame: ServerFrame, exclude?: WebSocket): number {
    const payload = JSON.stringify(frame);
    let delivered = 0;
    for (const socket of this.state.getWebSockets()) {
      if (exclude && socket === exclude) continue;
      try {
        socket.send(payload);
        delivered += 1;
      } catch {
        /* drop: the runtime will fire webSocketClose for it */
      }
    }
    return delivered;
  }
}
