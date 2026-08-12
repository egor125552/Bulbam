import { ApiError } from "../../../core/errors";
import type { DurableObjectNamespace } from "../../../platform/cloudflare";
import type {
  VoiceReadResult,
  VoiceStorage,
  VoiceStoredObject,
  VoiceUploadSession
} from "../ports/voice-storage";

export class DurableObjectVoiceStorage implements VoiceStorage {
  constructor(private readonly namespace: DurableObjectNamespace) {}

  async initialize(): Promise<void> {}

  async create(
    sessionId: string,
    conversationId: string,
    senderUserId: string,
    mimeType: string,
    bitrateBps: number
  ): Promise<VoiceUploadSession> {
    return this.json<VoiceUploadSession>(sessionId, "/internal/init", {
      method: "POST",
      body: JSON.stringify({ sessionId, conversationId, senderUserId, mimeType, bitrateBps })
    });
  }

  async inspect(
    sessionId: string,
    conversationId: string,
    senderUserId: string
  ): Promise<VoiceUploadSession | null> {
    const response = await this.request(sessionId, "/internal/inspect", {
      headers: contextHeaders(conversationId, senderUserId)
    });
    if (response.status === 404) return null;
    return parseJson<VoiceUploadSession>(response);
  }

  async writeChunk(
    sessionId: string,
    conversationId: string,
    senderUserId: string,
    partNumber: number,
    bytes: Uint8Array
  ): Promise<{ duplicate: boolean; sizeBytes: number }> {
    const body = new Uint8Array(bytes.byteLength);
    body.set(bytes);
    return this.json(sessionId, `/internal/chunk?partNumber=${partNumber}`, {
      method: "POST",
      headers: contextHeaders(conversationId, senderUserId, { "content-type": "application/octet-stream" }),
      body: body.buffer
    });
  }

  async complete(
    sessionId: string,
    conversationId: string,
    senderUserId: string,
    expectedChunkCount: number,
    expectedSizeBytes: number
  ): Promise<VoiceStoredObject> {
    return this.json<VoiceStoredObject>(sessionId, "/internal/complete", {
      method: "POST",
      headers: contextHeaders(conversationId, senderUserId),
      body: JSON.stringify({ expectedChunkCount, expectedSizeBytes })
    });
  }

  async abort(sessionId: string, conversationId: string, senderUserId: string): Promise<void> {
    const response = await this.request(sessionId, "/internal/upload", {
      method: "DELETE",
      headers: contextHeaders(conversationId, senderUserId)
    });
    if (!response.ok && response.status !== 404) await throwResponse(response);
  }

  async delete(objectKey: string): Promise<void> {
    const response = await this.request(objectKey, "/internal/object", { method: "DELETE" });
    if (!response.ok && response.status !== 404) await throwResponse(response);
  }

  async read(objectKey: string, requestHeaders: Headers): Promise<VoiceReadResult | null> {
    const headers = new Headers();
    const range = requestHeaders.get("range");
    if (range) headers.set("range", range);
    const response = await this.request(objectKey, "/internal/media", { headers });
    if (response.status === 404) return null;
    if (!response.ok && response.status !== 206 && response.status !== 416) await throwResponse(response);
    if (!response.body) return null;
    return {
      status: response.status,
      headers: new Headers(response.headers),
      body: response.body as ReadableStream<Uint8Array>
    };
  }

  private async json<T>(sessionId: string, path: string, init: RequestInit): Promise<T> {
    return parseJson<T>(await this.request(sessionId, path, init));
  }

  private request(sessionId: string, path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    return this.namespace.getByName(sessionId).fetch(
      new Request(`https://voice.internal${path}`, { ...init, headers })
    );
  }
}

function contextHeaders(
  conversationId: string,
  senderUserId: string,
  extra?: HeadersInit
): Headers {
  const headers = new Headers(extra);
  headers.set("x-bulbam-conversation-id", conversationId);
  headers.set("x-bulbam-user-id", senderUserId);
  return headers;
}

async function parseJson<T>(response: Response): Promise<T> {
  if (!response.ok) await throwResponse(response);
  const payload = await response.json() as T;
  return payload;
}

async function throwResponse(response: Response): Promise<never> {
  let code = "voice_storage_failed";
  let message = `Хранилище голосового вернуло HTTP ${response.status}.`;
  try {
    const payload = await response.json() as { code?: unknown; message?: unknown };
    if (typeof payload.code === "string") code = payload.code;
    if (typeof payload.message === "string") message = payload.message;
  } catch {
    const text = await response.text().catch(() => "");
    if (text) message = text;
  }
  throw new ApiError(response.status || 500, code, message);
}
