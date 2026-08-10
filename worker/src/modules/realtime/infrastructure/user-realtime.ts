import type { DurableObjectState, Env } from "../../../platform/cloudflare";

interface WebSocketPairValue {
  0: WebSocket;
  1: WebSocket;
}

declare const WebSocketPair: {
  new (): WebSocketPairValue;
};

interface StoredActiveCall {
  call: Record<string, unknown>;
  expiresAt: number;
}

const MAX_EVENT_BYTES = 32 * 1024;
const ACTIVE_CALL_KEY = "activeCall";

export class UserRealtime {
  constructor(
    private readonly state: DurableObjectState,
    private readonly _env: Env
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/presence") {
      return Response.json({ connected: this.state.getWebSockets().length > 0 });
    }

    if (request.method === "POST" && url.pathname === "/active-call") {
      let payload: unknown;
      try {
        payload = await request.json();
      } catch {
        return new Response("invalid active call", { status: 400 });
      }
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return new Response("invalid active call", { status: 400 });
      }
      const body = payload as Record<string, unknown>;
      if (body.call === null) {
        await this.state.storage.delete(ACTIVE_CALL_KEY);
        return new Response(null, { status: 204 });
      }
      if (!body.call || typeof body.call !== "object" || Array.isArray(body.call)) {
        return new Response("invalid active call", { status: 400 });
      }
      const expiresAt = Number(body.expiresAt);
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
        return new Response("invalid active call expiry", { status: 400 });
      }
      await this.state.storage.put<StoredActiveCall>(ACTIVE_CALL_KEY, {
        call: body.call as Record<string, unknown>,
        expiresAt
      });
      return new Response(null, { status: 204 });
    }

    if (request.method === "POST" && url.pathname === "/emit") {
      const text = await request.text();
      if (new TextEncoder().encode(text).byteLength > MAX_EVENT_BYTES) {
        return new Response("event too large", { status: 413 });
      }
      try {
        const event = JSON.parse(text);
        if (!event || typeof event !== "object" || Array.isArray(event)) {
          return new Response("invalid event", { status: 400 });
        }
      } catch {
        return new Response("invalid event", { status: 400 });
      }

      this.broadcast(text);
      return new Response(null, { status: 204 });
    }

    const upgrade = request.headers.get("upgrade") ?? "";
    if (upgrade.toLowerCase() !== "websocket") {
      return new Response("WebSocket required", { status: 426 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.state.acceptWebSocket(server);
    safeSend(server, JSON.stringify({ type: "realtime.ready" }));

    const active = await this.activeCall();
    if (active) {
      safeSend(server, JSON.stringify({ type: "call.active", call: active.call }));
    }

    return new Response(null, {
      status: 101,
      webSocket: client
    } as ResponseInit);
  }

  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message !== "string") return;
    if (message === "ping") safeSend(socket, JSON.stringify({ type: "pong", at: Date.now() }));
  }

  webSocketClose(): void {}

  webSocketError(): void {}

  private async activeCall(): Promise<StoredActiveCall | null> {
    const active = await this.state.storage.get<StoredActiveCall>(ACTIVE_CALL_KEY);
    if (!active) return null;
    if (!Number.isFinite(active.expiresAt) || active.expiresAt <= Date.now()) {
      await this.state.storage.delete(ACTIVE_CALL_KEY);
      return null;
    }
    return active;
  }

  private broadcast(message: string): void {
    for (const socket of this.state.getWebSockets()) {
      safeSend(socket, message);
    }
  }
}

function safeSend(socket: WebSocket, message: string): void {
  try {
    socket.send(message);
  } catch {
    // A dead socket will be removed by the runtime; realtime is best-effort.
  }
}
