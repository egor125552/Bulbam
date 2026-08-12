import { ApiError } from "../../../core/errors";
import type { DurableObjectState, Env } from "../../../platform/cloudflare";
import { VOICE_CHUNK_SIZE_BYTES, type VoiceStoredObject, type VoiceUploadSession } from "../ports/voice-storage";

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

interface VoiceObjectMeta extends VoiceUploadSession {
  createdAt: number;
  updatedAt: number;
  publishedAt: number | null;
  tailPartNumber: number | null;
  tailSizeBytes: number | null;
}

const META_KEY = "voice:meta";
const CHUNK_PREFIX = "voice:chunk:";
const MAX_PART_NUMBER = 100_000;
const ABANDONED_UPLOAD_MS = 7 * 24 * 60 * 60 * 1000;

export class VoiceUploadRoom {
  constructor(
    private readonly state: DurableObjectState,
    private readonly _env: Env
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/internal/init") {
      if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
      return this.initializeUpload(request);
    }
    if (url.pathname === "/internal/inspect") {
      if (request.method !== "GET") return new Response("method not allowed", { status: 405 });
      return this.inspectUpload(request);
    }
    if (url.pathname === "/internal/chunk") {
      if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
      return this.writeInternalChunk(request, url);
    }
    if (url.pathname === "/internal/complete") {
      if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
      return this.completeUpload(request);
    }
    if (url.pathname === "/internal/published") {
      if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
      return this.markPublished();
    }
    if (url.pathname === "/internal/upload") {
      if (request.method !== "DELETE") return new Response("method not allowed", { status: 405 });
      return this.abortUpload(request);
    }
    if (url.pathname === "/internal/object") {
      if (request.method !== "DELETE") return new Response("method not allowed", { status: 405 });
      await this.state.storage.deleteAll();
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/internal/media") {
      if (request.method !== "GET") return new Response("method not allowed", { status: 405 });
      return this.readMedia(request.headers);
    }

    const upgrade = request.headers.get("upgrade") ?? "";
    if (upgrade.toLowerCase() !== "websocket") return new Response("WebSocket required", { status: 426 });

    const userId = request.headers.get("x-bulbam-user-id") ?? "";
    const conversationId = request.headers.get("x-bulbam-conversation-id") ?? "";
    const sessionId = request.headers.get("x-bulbam-voice-session-id") ?? "";
    let meta: VoiceObjectMeta;
    try {
      meta = await this.requireContext(userId, conversationId, sessionId);
    } catch (error) {
      return errorResponse(error);
    }
    if (meta.state !== "uploading") return jsonError(409, "voice_upload_completed", "Голосовое сообщение уже завершено.");

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1] as HibernatingWebSocket;
    this.state.acceptWebSocket(server);
    server.serializeAttachment({ userId, conversationId, sessionId } satisfies VoiceSocketAttachment);
    safeSend(server, JSON.stringify({
      type: "voice.upload.ready",
      sessionId,
      chunkSizeBytes: VOICE_CHUNK_SIZE_BYTES,
      receivedParts: meta.receivedParts
    }));

    return new Response(null, { status: 101, webSocket: client } as ResponseInit);
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message === "string") {
      if (message === "ping") safeSend(socket, JSON.stringify({ type: "voice.upload.pong", at: Date.now() }));
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
      const meta = await this.requireContext(attachment.userId, attachment.conversationId, attachment.sessionId);
      const result = await this.storeChunk(meta, partNumber, payload);
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

  async alarm(): Promise<void> {
    const meta = await this.meta();
    if (!meta) {
      await this.state.storage.deleteAll();
      return;
    }
    if (meta.publishedAt != null) {
      await this.state.storage.deleteAlarm();
      return;
    }
    const expiresAt = meta.updatedAt + ABANDONED_UPLOAD_MS;
    if (expiresAt <= Date.now()) {
      await this.state.storage.deleteAll();
      return;
    }
    await this.state.storage.setAlarm(expiresAt);
  }

  private async initializeUpload(request: Request): Promise<Response> {
    let input: Record<string, unknown>;
    try {
      input = await request.json() as Record<string, unknown>;
    } catch {
      return jsonError(400, "invalid_voice_upload", "Некорректная сессия голосового сообщения.");
    }

    const sessionId = stringField(input.sessionId);
    const conversationId = stringField(input.conversationId);
    const senderUserId = stringField(input.senderUserId);
    const mimeType = stringField(input.mimeType);
    const bitrateBps = Number(input.bitrateBps);
    if (!sessionId || !conversationId || !senderUserId || !mimeType || !Number.isSafeInteger(bitrateBps) || bitrateBps <= 0) {
      return jsonError(400, "invalid_voice_upload", "Некорректная сессия голосового сообщения.");
    }

    const existing = await this.meta();
    if (existing) {
      if (
        existing.sessionId !== sessionId ||
        existing.conversationId !== conversationId ||
        existing.senderUserId !== senderUserId ||
        existing.mimeType !== mimeType ||
        existing.bitrateBps !== bitrateBps
      ) {
        return jsonError(409, "voice_upload_conflict", "Сессия голосового сообщения уже существует с другими параметрами.");
      }
      if (existing.publishedAt == null) await this.state.storage.setAlarm(existing.updatedAt + ABANDONED_UPLOAD_MS);
      return Response.json(publicSession(existing));
    }

    const now = Date.now();
    const meta: VoiceObjectMeta = {
      sessionId,
      conversationId,
      senderUserId,
      mimeType,
      bitrateBps,
      state: "uploading",
      receivedParts: [],
      sizeBytes: 0,
      chunkCount: 0,
      createdAt: now,
      updatedAt: now,
      publishedAt: null,
      tailPartNumber: null,
      tailSizeBytes: null
    };
    await this.state.storage.put(META_KEY, meta);
    await this.state.storage.setAlarm(now + ABANDONED_UPLOAD_MS);
    return Response.json(publicSession(meta), { status: 201 });
  }

  private async inspectUpload(request: Request): Promise<Response> {
    const meta = await this.meta();
    if (!meta) return jsonError(404, "voice_upload_not_found", "Сессия голосового сообщения не найдена.");
    const context = requestContext(request);
    if (!sameContext(meta, context.userId, context.conversationId)) {
      return jsonError(404, "voice_upload_not_found", "Сессия голосового сообщения не найдена.");
    }
    return Response.json(publicSession(meta));
  }

  private async writeInternalChunk(request: Request, url: URL): Promise<Response> {
    const meta = await this.meta();
    if (!meta) return jsonError(404, "voice_upload_not_found", "Сессия голосового сообщения не найдена.");
    const context = requestContext(request);
    if (!sameContext(meta, context.userId, context.conversationId)) {
      return jsonError(404, "voice_upload_not_found", "Сессия голосового сообщения не найдена.");
    }
    const partNumber = Number(url.searchParams.get("partNumber"));
    const bytes = new Uint8Array(await request.arrayBuffer());
    try {
      return Response.json(await this.storeChunk(meta, partNumber, bytes));
    } catch (error) {
      return errorResponse(error);
    }
  }

  private async completeUpload(request: Request): Promise<Response> {
    const meta = await this.meta();
    if (!meta) return jsonError(404, "voice_upload_not_found", "Сессия голосового сообщения не найдена.");
    const context = requestContext(request);
    if (!sameContext(meta, context.userId, context.conversationId)) {
      return jsonError(404, "voice_upload_not_found", "Сессия голосового сообщения не найдена.");
    }

    let input: Record<string, unknown>;
    try {
      input = await request.json() as Record<string, unknown>;
    } catch {
      return jsonError(400, "invalid_voice_parts", "Некорректное завершение голосового сообщения.");
    }
    const expectedChunkCount = Number(input.expectedChunkCount);
    const expectedSizeBytes = Number(input.expectedSizeBytes);
    if (!Number.isSafeInteger(expectedChunkCount) || expectedChunkCount < 1 || expectedChunkCount > MAX_PART_NUMBER ||
        !Number.isSafeInteger(expectedSizeBytes) || expectedSizeBytes < 1) {
      return jsonError(400, "invalid_voice_parts", "Некорректное завершение голосового сообщения.");
    }

    if (meta.state === "ready") {
      if (meta.chunkCount !== expectedChunkCount || meta.sizeBytes !== expectedSizeBytes) {
        return jsonError(409, "voice_upload_metadata_mismatch", "Завершённое голосовое имеет другие размеры.");
      }
      if (meta.publishedAt == null) await this.state.storage.setAlarm(meta.updatedAt + ABANDONED_UPLOAD_MS);
      return Response.json(storedObject(meta));
    }

    if (meta.receivedParts.length !== expectedChunkCount || meta.sizeBytes !== expectedSizeBytes) {
      return jsonError(409, "voice_upload_incomplete", "Не все части голосового сообщения подтверждены сервером.");
    }
    for (let index = 0; index < expectedChunkCount; index += 1) {
      if (meta.receivedParts[index] !== index + 1) {
        return jsonError(409, "voice_upload_incomplete", "Части голосового сообщения идут с пропусками.");
      }
    }
    if (meta.tailPartNumber != null && meta.tailPartNumber !== expectedChunkCount) {
      return jsonError(409, "voice_upload_incomplete", "Короткая часть голосового сообщения оказалась не последней.");
    }
    const derivedSize = meta.tailPartNumber == null
      ? expectedChunkCount * VOICE_CHUNK_SIZE_BYTES
      : (expectedChunkCount - 1) * VOICE_CHUNK_SIZE_BYTES + Number(meta.tailSizeBytes ?? 0);
    if (derivedSize !== expectedSizeBytes) {
      return jsonError(409, "voice_upload_metadata_mismatch", "Размер голосового сообщения не совпадает с сохранёнными частями.");
    }

    const now = Date.now();
    const ready: VoiceObjectMeta = {
      ...meta,
      state: "ready",
      chunkCount: expectedChunkCount,
      updatedAt: now,
      publishedAt: null
    };
    await this.state.storage.put(META_KEY, ready);
    await this.state.storage.setAlarm(now + ABANDONED_UPLOAD_MS);
    return Response.json(storedObject(ready));
  }

  private async markPublished(): Promise<Response> {
    const meta = await this.meta();
    if (!meta) return jsonError(404, "voice_media_not_found", "Аудиоданные голосового сообщения не найдены.");
    if (meta.state !== "ready") {
      return jsonError(409, "voice_media_not_ready", "Голосовое сообщение ещё не готово к публикации.");
    }
    if (meta.publishedAt != null) return new Response(null, { status: 204 });

    const published: VoiceObjectMeta = {
      ...meta,
      publishedAt: Date.now()
    };
    await this.state.storage.put(META_KEY, published);
    await this.state.storage.deleteAlarm();
    return new Response(null, { status: 204 });
  }

  private async abortUpload(request: Request): Promise<Response> {
    const meta = await this.meta();
    if (!meta) return new Response(null, { status: 204 });
    const context = requestContext(request);
    if (!sameContext(meta, context.userId, context.conversationId)) {
      return jsonError(404, "voice_upload_not_found", "Сессия голосового сообщения не найдена.");
    }
    if (meta.state === "ready" && meta.publishedAt != null) return new Response(null, { status: 204 });
    await this.state.storage.deleteAll();
    return new Response(null, { status: 204 });
  }

  private async readMedia(requestHeaders: Headers): Promise<Response> {
    const meta = await this.meta();
    if (!meta || meta.state !== "ready" || meta.sizeBytes <= 0) {
      return jsonError(404, "voice_media_not_found", "Аудиоданные голосового сообщения не найдены.");
    }

    const range = resolveRange(requestHeaders.get("range"), meta.sizeBytes);
    const headers = new Headers();
    headers.set("content-type", meta.mimeType);
    headers.set("accept-ranges", "bytes");
    headers.set("cache-control", "private, max-age=604800, immutable");
    headers.set("x-content-type-options", "nosniff");
    headers.set("etag", `\"do-${meta.sessionId}-${meta.sizeBytes}\"`);

    if (range === "invalid") {
      headers.set("content-range", `bytes */${meta.sizeBytes}`);
      headers.set("content-length", "0");
      return new Response(null, { status: 416, headers });
    }

    const start = range?.start ?? 0;
    const end = range?.end ?? meta.sizeBytes - 1;
    if (range) headers.set("content-range", `bytes ${start}-${end}/${meta.sizeBytes}`);
    headers.set("content-length", String(end - start + 1));
    return new Response(this.chunkStream(start, end), { status: range ? 206 : 200, headers });
  }

  private async storeChunk(
    meta: VoiceObjectMeta,
    partNumber: number,
    bytes: Uint8Array
  ): Promise<{ duplicate: boolean; sizeBytes: number }> {
    if (meta.state !== "uploading") {
      throw new ApiError(409, "voice_upload_completed", "Голосовое сообщение уже завершено.");
    }
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > MAX_PART_NUMBER) {
      throw new ApiError(400, "invalid_voice_part", "Некорректный номер части голосового сообщения.");
    }
    if (!bytes.byteLength || bytes.byteLength > VOICE_CHUNK_SIZE_BYTES) {
      throw new ApiError(413, "voice_part_too_large", "Часть голосового сообщения имеет недопустимый размер.");
    }

    const key = chunkKey(partNumber);
    const existing = await this.state.storage.get<Uint8Array>(key);
    if (existing) {
      if (!sameBytes(existing, bytes)) {
        throw new ApiError(409, "voice_part_conflict", "Эта часть голосового уже сохранена с другими данными.");
      }
      return { duplicate: true, sizeBytes: bytes.byteLength };
    }

    if (meta.tailPartNumber != null && partNumber > meta.tailPartNumber) {
      throw new ApiError(409, "voice_part_after_tail", "После последней короткой части нельзя добавлять новые части.");
    }

    let tailPartNumber = meta.tailPartNumber;
    let tailSizeBytes = meta.tailSizeBytes;
    if (bytes.byteLength < VOICE_CHUNK_SIZE_BYTES) {
      if (tailPartNumber != null && tailPartNumber !== partNumber) {
        throw new ApiError(409, "voice_tail_conflict", "У голосового уже есть другая последняя часть.");
      }
      if (meta.receivedParts.some((received) => received > partNumber)) {
        throw new ApiError(409, "voice_tail_not_last", "Короткая часть должна быть последней частью голосового.");
      }
      tailPartNumber = partNumber;
      tailSizeBytes = bytes.byteLength;
    }

    const receivedParts = [...meta.receivedParts, partNumber].sort((left, right) => left - right);
    const next: VoiceObjectMeta = {
      ...meta,
      receivedParts,
      sizeBytes: meta.sizeBytes + bytes.byteLength,
      updatedAt: Date.now(),
      tailPartNumber,
      tailSizeBytes
    };
    await this.state.storage.put({ [key]: bytes, [META_KEY]: next });
    await this.state.storage.setAlarm(next.updatedAt + ABANDONED_UPLOAD_MS);
    return { duplicate: false, sizeBytes: bytes.byteLength };
  }

  private async requireContext(userId: string, conversationId: string, sessionId: string): Promise<VoiceObjectMeta> {
    const meta = await this.meta();
    if (!meta || meta.sessionId !== sessionId || !sameContext(meta, userId, conversationId)) {
      throw new ApiError(404, "voice_upload_not_found", "Сессия голосового сообщения не найдена.");
    }
    return meta;
  }

  private meta(): Promise<VoiceObjectMeta | undefined> {
    return this.state.storage.get<VoiceObjectMeta>(META_KEY);
  }

  private chunkStream(start: number, end: number): ReadableStream<Uint8Array> {
    const firstPart = Math.floor(start / VOICE_CHUNK_SIZE_BYTES) + 1;
    const lastPart = Math.floor(end / VOICE_CHUNK_SIZE_BYTES) + 1;
    let partNumber = firstPart;

    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        if (partNumber > lastPart) {
          controller.close();
          return;
        }
        const bytes = await this.state.storage.get<Uint8Array>(chunkKey(partNumber));
        if (!bytes) {
          controller.error(new Error(`Missing voice chunk ${partNumber}`));
          return;
        }
        const partStart = (partNumber - 1) * VOICE_CHUNK_SIZE_BYTES;
        const sliceStart = partNumber === firstPart ? Math.max(0, start - partStart) : 0;
        const sliceEnd = partNumber === lastPart ? Math.min(bytes.byteLength, end - partStart + 1) : bytes.byteLength;
        partNumber += 1;
        if (sliceEnd > sliceStart) controller.enqueue(bytes.slice(sliceStart, sliceEnd));
        if (partNumber > lastPart) controller.close();
      }
    });
  }
}

function publicSession(meta: VoiceObjectMeta): VoiceUploadSession {
  return {
    sessionId: meta.sessionId,
    conversationId: meta.conversationId,
    senderUserId: meta.senderUserId,
    mimeType: meta.mimeType,
    bitrateBps: meta.bitrateBps,
    state: meta.state,
    receivedParts: meta.receivedParts,
    sizeBytes: meta.sizeBytes,
    chunkCount: meta.chunkCount
  };
}

function storedObject(meta: VoiceObjectMeta): VoiceStoredObject {
  return {
    key: meta.sessionId,
    size: meta.sizeBytes,
    mimeType: meta.mimeType,
    bitrateBps: meta.bitrateBps,
    chunkCount: meta.chunkCount
  };
}

function requestContext(request: Request): { userId: string; conversationId: string } {
  return {
    userId: request.headers.get("x-bulbam-user-id") ?? "",
    conversationId: request.headers.get("x-bulbam-conversation-id") ?? ""
  };
}

function sameContext(meta: VoiceObjectMeta, userId: string, conversationId: string): boolean {
  return Boolean(userId && conversationId && meta.senderUserId === userId && meta.conversationId === conversationId);
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function chunkKey(partNumber: number): string {
  return `${CHUNK_PREFIX}${String(partNumber).padStart(6, "0")}`;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function resolveRange(value: string | null, size: number): { start: number; end: number } | null | "invalid" {
  if (!value) return null;
  if (!value.startsWith("bytes=") || value.includes(",")) return "invalid";
  const match = value.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return "invalid";
  const left = match[1];
  const right = match[2];
  if (!left && !right) return "invalid";

  if (!left) {
    const suffix = Number(right);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return "invalid";
    const length = Math.min(size, suffix);
    return { start: size - length, end: size - 1 };
  }

  const start = Number(left);
  if (!Number.isSafeInteger(start) || start < 0 || start >= size) return "invalid";
  if (!right) return { start, end: size - 1 };
  const requestedEnd = Number(right);
  if (!Number.isSafeInteger(requestedEnd) || requestedEnd < start) return "invalid";
  return { start, end: Math.min(size - 1, requestedEnd) };
}

function safeSend(socket: WebSocket, data: string): void {
  try {
    socket.send(data);
  } catch {
    // Client reconnects and the persisted attachment/chunks remain the source of truth.
  }
}

function jsonError(status: number, code: string, message: string): Response {
  return Response.json({ code, message }, { status });
}

function errorResponse(error: unknown): Response {
  if (error instanceof ApiError) return jsonError(error.status, error.code, error.message);
  return jsonError(500, "voice_storage_failed", error instanceof Error ? error.message : "Ошибка хранения голосового сообщения.");
}
