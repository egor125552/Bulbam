import { ApiError } from "../../../core/errors";
import type { DurableObjectState, Env } from "../../../platform/cloudflare";
import { FILE_CHUNK_SIZE_BYTES } from "../domain/file-validation";
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
const PUBLICATION_RECHECK_MS = 60 * 60 * 1000;

export class VoiceUploadRoom {
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env
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

    if (meta.state === "ready") {
      try {
        if (await this.isReferencedByPublishedMessage(meta.sessionId)) {
          await this.persistPublished(meta);
          return;
        }
      } catch (error) {
        console.error("[Bulbam] voice publication reconciliation failed", error);
        await this.state.storage.setAlarm(Date.now() + PUBLICATION_RECHECK_MS);
        return;
      }
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
      return jsonError(400, "invalid_voice_upload", "Некорректная сессия загрузки.");
    }

    const sessionId = stringField(input.sessionId);
    const conversationId = stringField(input.conversationId);
    const senderUserId = stringField(input.senderUserId);
    const mimeType = stringField(input.mimeType);
    const kind = input.kind === "file" ? "file" : "voice";
    const bitrateBps = Number(input.bitrateBps);
    const requestedChunkSize = input.chunkSizeBytes === undefined
      ? (kind === "file" ? FILE_CHUNK_SIZE_BYTES : VOICE_CHUNK_SIZE_BYTES)
      : Number(input.chunkSizeBytes);
    const fileName = kind === "file" ? stringField(input.fileName) : undefined;
    const rawMediaKind = stringField(input.mediaKind);
    const mediaKind = kind === "file" && (rawMediaKind === "image" || rawMediaKind === "video" || rawMediaKind === "audio" || rawMediaKind === "file")
      ? rawMediaKind
      : undefined;

    const validBitrate = kind === "file"
      ? Number.isSafeInteger(bitrateBps) && bitrateBps >= 0
      : Number.isSafeInteger(bitrateBps) && bitrateBps > 0;
    const validChunkSize =
      Number.isSafeInteger(requestedChunkSize) &&
      requestedChunkSize >= 1024 &&
      requestedChunkSize <= FILE_CHUNK_SIZE_BYTES;

    if (!sessionId || !conversationId || !senderUserId || !mimeType || !validBitrate || !validChunkSize) {
      return jsonError(400, "invalid_voice_upload", "Некорректная сессия загрузки.");
    }

    return this.enqueueWrite(async () => {
      const existing = await this.meta();
      if (existing) {
        if (
          existing.sessionId !== sessionId ||
          existing.conversationId !== conversationId ||
          existing.senderUserId !== senderUserId ||
          existing.mimeType !== mimeType ||
          existing.bitrateBps !== bitrateBps ||
          chunkSizeOf(existing) !== requestedChunkSize
        ) {
          return jsonError(409, "voice_upload_conflict", "Сессия загрузки уже существует с другими параметрами.");
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
        kind,
        chunkSizeBytes: requestedChunkSize,
        ...(fileName ? { fileName } : {}),
        ...(mediaKind ? { mediaKind } : {}),
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
    });
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
    // Read network payload BEFORE acquiring the storage write lock so parallel
    // HTTP chunk uploads stream concurrently over the wire and commit atomically.
    const context = requestContext(request);
    const partNumber = Number(url.searchParams.get("partNumber"));
    const bytes = new Uint8Array(await request.arrayBuffer());
    return this.enqueueWrite(async () => {
      const meta = await this.meta();
      if (!meta) return jsonError(404, "voice_upload_not_found", "Сессия загрузки не найдена.");
      if (!sameContext(meta, context.userId, context.conversationId)) {
        return jsonError(404, "voice_upload_not_found", "Сессия загрузки не найдена.");
      }
      try {
        return Response.json(await this.storeChunk(meta, partNumber, bytes));
      } catch (error) {
        return errorResponse(error);
      }
    });
  }

  private async completeUpload(request: Request): Promise<Response> {
    const context = requestContext(request);
    let input: Record<string, unknown>;
    try {
      input = await request.json() as Record<string, unknown>;
    } catch {
      return jsonError(400, "invalid_voice_parts", "Некорректное завершение загрузки.");
    }
    const expectedChunkCount = Number(input.expectedChunkCount);
    const expectedSizeBytes = Number(input.expectedSizeBytes);
    if (!Number.isSafeInteger(expectedChunkCount) || expectedChunkCount < 1 || expectedChunkCount > MAX_PART_NUMBER ||
        !Number.isSafeInteger(expectedSizeBytes) || expectedSizeBytes < 1) {
      return jsonError(400, "invalid_voice_parts", "Некорректное завершение загрузки.");
    }

    return this.enqueueWrite(async () => {
      const meta = await this.meta();
      if (!meta) return jsonError(404, "voice_upload_not_found", "Сессия загрузки не найдена.");
      if (!sameContext(meta, context.userId, context.conversationId)) {
        return jsonError(404, "voice_upload_not_found", "Сессия загрузки не найдена.");
      }

      if (meta.state === "ready") {
        if (meta.chunkCount !== expectedChunkCount || meta.sizeBytes !== expectedSizeBytes) {
          return jsonError(409, "voice_upload_metadata_mismatch", "Завершённая загрузка имеет другие размеры.");
        }
        if (meta.publishedAt == null) await this.state.storage.setAlarm(meta.updatedAt + ABANDONED_UPLOAD_MS);
        return Response.json(storedObject(meta));
      }

      if (meta.receivedParts.length !== expectedChunkCount || meta.sizeBytes !== expectedSizeBytes) {
        return jsonError(409, "voice_upload_incomplete", "Не все части файла подтверждены сервером.");
      }
      for (let index = 0; index < expectedChunkCount; index += 1) {
        if (meta.receivedParts[index] !== index + 1) {
          return jsonError(409, "voice_upload_incomplete", "Части файла идут с пропусками.");
        }
      }
      if (meta.tailPartNumber != null && meta.tailPartNumber !== expectedChunkCount) {
        return jsonError(409, "voice_upload_incomplete", "Короткая часть файла оказалась не последней.");
      }
      const partSize = chunkSizeOf(meta);
      const derivedSize = meta.tailPartNumber == null
        ? expectedChunkCount * partSize
        : (expectedChunkCount - 1) * partSize + Number(meta.tailSizeBytes ?? 0);
      if (derivedSize !== expectedSizeBytes) {
        return jsonError(409, "voice_upload_metadata_mismatch", "Размер файла не совпадает с сохранёнными частями.");
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
    });
  }

  private async markPublished(): Promise<Response> {
    const meta = await this.meta();
    if (!meta) return jsonError(404, "voice_media_not_found", "Аудиоданные голосового сообщения не найдены.");
    if (meta.state !== "ready") {
      return jsonError(409, "voice_media_not_ready", "Голосовое сообщение ещё не готово к публикации.");
    }
    if (meta.publishedAt != null) return new Response(null, { status: 204 });

    await this.persistPublished(meta);
    return new Response(null, { status: 204 });
  }

  private async abortUpload(request: Request): Promise<Response> {
    const meta = await this.meta();
    if (!meta) return new Response(null, { status: 204 });
    const context = requestContext(request);
    if (!sameContext(meta, context.userId, context.conversationId)) {
      return jsonError(404, "voice_upload_not_found", "Сессия голосового сообщения не найдена.");
    }

    // Once bytes reached the ready state, deleting them immediately is unsafe: the
    // D1 message may already exist while the final published acknowledgement was lost.
    // The alarm reconciles ready media with D1 and removes true orphans after 7 days.
    if (meta.state === "ready") return new Response(null, { status: 204 });

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
    return new Response(this.chunkStream(start, end, chunkSizeOf(meta)), { status: range ? 206 : 200, headers });
  }

  private async storeChunk(
    meta: VoiceObjectMeta,
    partNumber: number,
    bytes: Uint8Array
  ): Promise<{ duplicate: boolean; sizeBytes: number }> {
    const partSize = chunkSizeOf(meta);
    if (meta.state !== "uploading") {
      throw new ApiError(409, "voice_upload_completed", "Загрузка уже завершена.");
    }
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > MAX_PART_NUMBER) {
      throw new ApiError(400, "invalid_voice_part", "Некорректный номер части файла.");
    }
    if (!bytes.byteLength || bytes.byteLength > partSize) {
      throw new ApiError(413, "voice_part_too_large", "Часть файла имеет недопустимый размер.");
    }

    const key = chunkKey(partNumber);
    const existing = await this.state.storage.get<Uint8Array>(key);
    if (existing) {
      if (!sameBytes(existing, bytes)) {
        throw new ApiError(409, "voice_part_conflict", "Эта часть уже сохранена с другими данными.");
      }
      return { duplicate: true, sizeBytes: bytes.byteLength };
    }

    if (meta.tailPartNumber != null && partNumber > meta.tailPartNumber) {
      throw new ApiError(409, "voice_part_after_tail", "После последней короткой части нельзя добавлять новые части.");
    }

    let tailPartNumber = meta.tailPartNumber;
    let tailSizeBytes = meta.tailSizeBytes;
    if (bytes.byteLength < partSize) {
      if (tailPartNumber != null && tailPartNumber !== partNumber) {
        throw new ApiError(409, "voice_tail_conflict", "У загрузки уже есть другая последняя часть.");
      }
      if (meta.receivedParts.some((received) => received > partNumber)) {
        throw new ApiError(409, "voice_tail_not_last", "Короткая часть должна быть последней частью загрузки.");
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

  private async persistPublished(meta: VoiceObjectMeta): Promise<void> {
    const published: VoiceObjectMeta = {
      ...meta,
      publishedAt: meta.publishedAt ?? Date.now()
    };
    await this.state.storage.put(META_KEY, published);
    await this.state.storage.deleteAlarm();
  }

  private async isReferencedByPublishedMessage(objectKey: string): Promise<boolean> {
    const db = this.env.DB;
    if (!db) throw new Error("D1 binding is unavailable while reconciling media publication");

    const tables = await db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('voice_message_attachments', 'file_message_attachments')"
      )
      .all<{ name: string }>();
    const existing = new Set((tables.results ?? []).map((row) => String(row.name ?? "")));

    for (const table of ["voice_message_attachments", "file_message_attachments"] as const) {
      if (!existing.has(table)) continue;
      const reference = await db
        .prepare(`SELECT object_key FROM ${table} WHERE object_key = ? LIMIT 1`)
        .bind(objectKey)
        .first<{ object_key: string }>();
      if (reference?.object_key) return true;
    }
    return false;
  }

  private enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
    const run = this.writeChain.then(task, task);
    this.writeChain = run.then(() => undefined, () => undefined);
    return run;
  }

  private async requireContext(userId: string, conversationId: string, sessionId: string): Promise<VoiceObjectMeta> {
    const meta = await this.meta();
    if (!meta || meta.sessionId !== sessionId || !sameContext(meta, userId, conversationId)) {
      throw new ApiError(404, "voice_upload_not_found", "Сессия загрузки не найдена.");
    }
    return meta;
  }

  private meta(): Promise<VoiceObjectMeta | undefined> {
    return this.state.storage.get<VoiceObjectMeta>(META_KEY);
  }

  private chunkStream(start: number, end: number, partSize: number): ReadableStream<Uint8Array> {
    const firstPart = Math.floor(start / partSize) + 1;
    const lastPart = Math.floor(end / partSize) + 1;
    let partNumber = firstPart;

    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        if (partNumber > lastPart) {
          controller.close();
          return;
        }
        const bytes = await this.state.storage.get<Uint8Array>(chunkKey(partNumber));
        if (!bytes) {
          controller.error(new Error(`Missing media chunk ${partNumber}`));
          return;
        }
        const partStart = (partNumber - 1) * partSize;
        const sliceStart = partNumber === firstPart ? Math.max(0, start - partStart) : 0;
        const sliceEnd = partNumber === lastPart ? Math.min(bytes.byteLength, end - partStart + 1) : bytes.byteLength;
        partNumber += 1;
        if (sliceEnd > sliceStart) controller.enqueue(bytes.slice(sliceStart, sliceEnd));
        if (partNumber > lastPart) controller.close();
      }
    });
  }
}

function chunkSizeOf(meta: VoiceObjectMeta): number {
  return meta.chunkSizeBytes ?? VOICE_CHUNK_SIZE_BYTES;
}

function publicSession(meta: VoiceObjectMeta): VoiceUploadSession {
  return {
    sessionId: meta.sessionId,
    conversationId: meta.conversationId,
    senderUserId: meta.senderUserId,
    mimeType: meta.mimeType,
    bitrateBps: meta.bitrateBps,
    kind: meta.kind ?? "voice",
    chunkSizeBytes: chunkSizeOf(meta),
    ...(meta.fileName ? { fileName: meta.fileName } : {}),
    ...(meta.mediaKind ? { mediaKind: meta.mediaKind } : {}),
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
    chunkCount: meta.chunkCount,
    kind: meta.kind ?? "voice",
    chunkSizeBytes: chunkSizeOf(meta),
    ...(meta.fileName ? { fileName: meta.fileName } : {}),
    ...(meta.mediaKind ? { mediaKind: meta.mediaKind } : {})
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
