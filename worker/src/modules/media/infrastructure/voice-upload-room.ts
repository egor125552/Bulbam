import { ApiError } from "../../../core/errors";
import type { DurableObjectState, Env } from "../../../platform/cloudflare";
import { VOICE_CHUNK_SIZE_BYTES } from "../ports/voice-storage";
import { D1VoiceStorage } from "./d1-voice-storage";

interface WebSocketPairValue {
  0: WebSocket;
  1: WebSocket;
}

declare const WebSocketPair: {
  new (): WebSocketPairValue;
};

interface VoiceSocketAttachment {
  userId: string;
  conversationId: string;
  sessionId: string;
}

interface HibernatingWebSocket extends WebSocket {
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

export class VoiceUploadRoom {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env
  ) {}

  async fetch(request: Request): Promise<Response> {
    if (!this.env.DB) return new Response("D1 storage unavailable", { status: 503 });
    const upgrade = request.headers.get("upgrade") ?? "";
    if (upgrade.toLowerCase() !== "websocket") return new Response("WebSocket required", { status: 426 });

    const userId = request.headers.get("x-bulbam-user-id") ?? "";
    const conversationId = request.headers.get("x-bulbam-conversation-id") ?? "";
    const sessionId = request.headers.get("x-bulbam-voice-session-id") ?? "";
    if (!userId || !conversationId || !sessionId) return new Response("Voice upload context missing", { status: 400 });

    const storage = new D1VoiceStorage(this.env.DB);
    const session = await storage.inspect(sessionId, conversationId, userId);
    if (!session) return new Response("Voice upload not found", { status: 404 });
    if (session.state !== "uploading") return new Response("Voice upload already completed", { status: 409 });

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1] as HibernatingWebSocket;
    this.state.acceptWebSocket(server);
    server.serializeAttachment({ userId, conversationId, sessionId } satisfies VoiceSocketAttachment);
    safeSend(server, JSON.stringify({
      type: "voice.upload.ready",
      sessionId,
      chunkSizeBytes: VOICE_CHUNK_SIZE_BYTES,
      receivedParts: session.receivedParts
    }));

    return new Response(null, { status: 101, webSocket: client } as ResponseInit);
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message === "string") {
      if (message === "ping") safeSend(socket, JSON.stringify({ type: "voice.upload.pong", at: Date.now() }));
      return;
    }
    if (!this.env.DB) {
      safeSend(socket, JSON.stringify({ type: "voice.upload.error", code: "storage_missing", message: "D1 недоступен." }));
      return;
    }

    const attachment = (socket as HibernatingWebSocket).deserializeAttachment() as VoiceSocketAttachment | null;
    if (!attachment?.userId || !attachment.conversationId || !attachment.sessionId) {
      safeSend(socket, JSON.stringify({ type: "voice.upload.error", code: "session_lost", message: "Контекст загрузки потерян." }));
      return;
    }

    const frame = new Uint8Array(message);
    if (frame.byteLength <= 4 || frame.byteLength > VOICE_CHUNK_SIZE_BYTES + 4) {
      safeSend(socket, JSON.stringify({ type: "voice.upload.error", code: "invalid_voice_part", message: "Некорректный размер части голосового." }));
      return;
    }

    const partNumber = new DataView(message, 0, 4).getUint32(0, false);
    const payload = frame.slice(4);
    try {
      const result = await new D1VoiceStorage(this.env.DB).writeChunk(
        attachment.sessionId,
        attachment.conversationId,
        attachment.userId,
        partNumber,
        payload
      );
      safeSend(socket, JSON.stringify({
        type: "voice.upload.ack",
        sessionId: attachment.sessionId,
        partNumber,
        sizeBytes: result.sizeBytes,
        duplicate: result.duplicate
      }));
    } catch (error) {
      const code = error instanceof ApiError ? error.code : "voice_upload_failed";
      const messageText = error instanceof Error ? error.message : "Не удалось сохранить часть голосового.";
      safeSend(socket, JSON.stringify({ type: "voice.upload.error", code, partNumber, message: messageText }));
    }
  }

  webSocketClose(): void {}

  webSocketError(): void {}
}

function safeSend(socket: WebSocket, data: string): void {
  try {
    socket.send(data);
  } catch {
    // The client will reconnect and the D1 acknowledgements remain the source of truth.
  }
}
