import type { DurableObjectState, Env } from "../../../platform/cloudflare";

interface WebSocketPairValue {
  0: WebSocket;
  1: WebSocket;
}

declare const WebSocketPair: {
  new (): WebSocketPairValue;
};

const MAX_EVENT_BYTES = 32 * 1024;

export class UserRealtime {
  constructor(
    private readonly state: DurableObjectState,
    private readonly _env: Env
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

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
