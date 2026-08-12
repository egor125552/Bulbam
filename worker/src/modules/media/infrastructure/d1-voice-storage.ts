import { ApiError } from "../../../core/errors";
import type { D1Database } from "../../../platform/cloudflare";
import {
  VOICE_CHUNK_SIZE_BYTES,
  type VoiceReadResult,
  type VoiceStorage,
  type VoiceStoredObject,
  type VoiceUploadSession
} from "../ports/voice-storage";
import { ensureVoiceMediaSchema } from "./schema";

const MAX_PART_NUMBER = 100_000;

type SessionRow = {
  session_id: string;
  conversation_id: string;
  sender_user_id: string;
  mime_type: string;
  bitrate_bps: number;
  state: "uploading" | "ready";
  chunk_count: number;
  size_bytes: number;
};

type ChunkRow = {
  data: unknown;
  size_bytes: number;
};

export class D1VoiceStorage implements VoiceStorage {
  constructor(private readonly db: D1Database) {}

  initialize(): Promise<void> {
    return ensureVoiceMediaSchema(this.db);
  }

  async create(
    sessionId: string,
    conversationId: string,
    senderUserId: string,
    mimeType: string,
    bitrateBps: number
  ): Promise<VoiceUploadSession> {
    await this.initialize();
    const result = await this.db
      .prepare(`
        INSERT OR IGNORE INTO voice_media_objects (
          session_id, conversation_id, sender_user_id, mime_type, bitrate_bps,
          state, chunk_count, size_bytes, created_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, 'uploading', 0, 0, ?, NULL)
      `)
      .bind(sessionId, conversationId, senderUserId, mimeType, bitrateBps, Date.now())
      .run();

    const session = await this.inspect(sessionId, conversationId, senderUserId);
    if (!session) throw new Error("Voice upload session was not created");
    if ((result.meta?.changes ?? 0) === 0 && (session.mimeType !== mimeType || session.bitrateBps !== bitrateBps)) {
      throw new ApiError(409, "voice_upload_conflict", "Сессия голосового сообщения уже существует с другими параметрами.");
    }
    return session;
  }

  async inspect(sessionId: string, conversationId: string, senderUserId: string): Promise<VoiceUploadSession | null> {
    await this.initialize();
    const row = await this.sessionRow(sessionId, conversationId, senderUserId);
    if (!row) return null;
    const parts = await this.db
      .prepare("SELECT part_number FROM voice_media_chunks WHERE session_id = ? ORDER BY part_number")
      .bind(sessionId)
      .all<{ part_number: number }>();
    return {
      sessionId: row.session_id,
      conversationId: row.conversation_id,
      senderUserId: row.sender_user_id,
      mimeType: row.mime_type,
      bitrateBps: Number(row.bitrate_bps),
      state: row.state,
      receivedParts: (parts.results ?? []).map((part) => Number(part.part_number)),
      sizeBytes: Number(row.size_bytes),
      chunkCount: Number(row.chunk_count)
    };
  }

  async writeChunk(
    sessionId: string,
    conversationId: string,
    senderUserId: string,
    partNumber: number,
    bytes: Uint8Array
  ): Promise<{ duplicate: boolean; sizeBytes: number }> {
    await this.initialize();
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > MAX_PART_NUMBER) {
      throw new ApiError(400, "invalid_voice_part", "Некорректный номер части голосового сообщения.");
    }
    if (!bytes.byteLength || bytes.byteLength > VOICE_CHUNK_SIZE_BYTES) {
      throw new ApiError(413, "voice_part_too_large", "Часть голосового сообщения имеет недопустимый размер.");
    }

    const session = await this.sessionRow(sessionId, conversationId, senderUserId);
    if (!session) throw new ApiError(404, "voice_upload_not_found", "Сессия голосового сообщения не найдена.");
    if (session.state !== "uploading") {
      throw new ApiError(409, "voice_upload_completed", "Голосовое сообщение уже завершено.");
    }

    const existing = await this.db
      .prepare("SELECT size_bytes FROM voice_media_chunks WHERE session_id = ? AND part_number = ? LIMIT 1")
      .bind(sessionId, partNumber)
      .first<{ size_bytes: number }>();
    if (existing) {
      if (Number(existing.size_bytes) !== bytes.byteLength) {
        throw new ApiError(409, "voice_part_conflict", "Эта часть голосового уже сохранена с другим размером.");
      }
      return { duplicate: true, sizeBytes: bytes.byteLength };
    }

    const result = await this.db
      .prepare(`
        INSERT OR IGNORE INTO voice_media_chunks (
          session_id, part_number, size_bytes, data, created_at
        ) VALUES (?, ?, ?, ?, ?)
      `)
      .bind(sessionId, partNumber, bytes.byteLength, bytes, Date.now())
      .run();

    if ((result.meta?.changes ?? 0) === 0) {
      const raced = await this.db
        .prepare("SELECT size_bytes FROM voice_media_chunks WHERE session_id = ? AND part_number = ? LIMIT 1")
        .bind(sessionId, partNumber)
        .first<{ size_bytes: number }>();
      if (!raced || Number(raced.size_bytes) !== bytes.byteLength) {
        throw new ApiError(409, "voice_part_conflict", "Не удалось безопасно подтвердить сохранение части голосового.");
      }
      return { duplicate: true, sizeBytes: bytes.byteLength };
    }

    return { duplicate: false, sizeBytes: bytes.byteLength };
  }

  async complete(
    sessionId: string,
    conversationId: string,
    senderUserId: string,
    expectedChunkCount: number,
    expectedSizeBytes: number
  ): Promise<VoiceStoredObject> {
    await this.initialize();
    const session = await this.sessionRow(sessionId, conversationId, senderUserId);
    if (!session) throw new ApiError(404, "voice_upload_not_found", "Сессия голосового сообщения не найдена.");

    if (session.state === "ready") {
      if (Number(session.chunk_count) !== expectedChunkCount || Number(session.size_bytes) !== expectedSizeBytes) {
        throw new ApiError(409, "voice_upload_metadata_mismatch", "Завершённое голосовое имеет другие размеры.");
      }
      return storedObject(session);
    }

    const summary = await this.db
      .prepare(`
        SELECT
          COUNT(*) AS chunk_count,
          COALESCE(SUM(size_bytes), 0) AS total_size,
          COALESCE(MIN(part_number), 0) AS min_part,
          COALESCE(MAX(part_number), 0) AS max_part,
          COALESCE(SUM(CASE
            WHEN part_number < ? AND size_bytes <> ? THEN 1
            ELSE 0
          END), 0) AS malformed_full_parts
        FROM voice_media_chunks
        WHERE session_id = ?
      `)
      .bind(expectedChunkCount, VOICE_CHUNK_SIZE_BYTES, sessionId)
      .first<{
        chunk_count: number;
        total_size: number;
        min_part: number;
        max_part: number;
        malformed_full_parts: number;
      }>();

    const chunkCount = Number(summary?.chunk_count ?? 0);
    const sizeBytes = Number(summary?.total_size ?? 0);
    const minPart = Number(summary?.min_part ?? 0);
    const maxPart = Number(summary?.max_part ?? 0);
    const malformed = Number(summary?.malformed_full_parts ?? 0);
    if (
      chunkCount !== expectedChunkCount ||
      sizeBytes !== expectedSizeBytes ||
      minPart !== 1 ||
      maxPart !== expectedChunkCount ||
      malformed !== 0
    ) {
      throw new ApiError(409, "voice_upload_incomplete", "Не все части голосового сообщения подтверждены сервером.");
    }

    await this.db
      .prepare(`
        UPDATE voice_media_objects
        SET state = 'ready', chunk_count = ?, size_bytes = ?, completed_at = ?
        WHERE session_id = ? AND conversation_id = ? AND sender_user_id = ? AND state = 'uploading'
      `)
      .bind(chunkCount, sizeBytes, Date.now(), sessionId, conversationId, senderUserId)
      .run();

    return {
      key: sessionId,
      size: sizeBytes,
      mimeType: session.mime_type,
      bitrateBps: Number(session.bitrate_bps),
      chunkCount
    };
  }

  async abort(sessionId: string, conversationId: string, senderUserId: string): Promise<void> {
    await this.initialize();
    const session = await this.sessionRow(sessionId, conversationId, senderUserId);
    if (!session || session.state === "ready") return;
    await this.db.prepare("DELETE FROM voice_media_chunks WHERE session_id = ?").bind(sessionId).run();
    await this.db
      .prepare("DELETE FROM voice_media_objects WHERE session_id = ? AND conversation_id = ? AND sender_user_id = ? AND state = 'uploading'")
      .bind(sessionId, conversationId, senderUserId)
      .run();
  }

  async delete(objectKey: string): Promise<void> {
    await this.initialize();
    await this.db.prepare("DELETE FROM voice_media_chunks WHERE session_id = ?").bind(objectKey).run();
    await this.db.prepare("DELETE FROM voice_media_objects WHERE session_id = ?").bind(objectKey).run();
  }

  async read(objectKey: string, requestHeaders: Headers): Promise<VoiceReadResult | null> {
    await this.initialize();
    const object = await this.db
      .prepare(`
        SELECT session_id, conversation_id, sender_user_id, mime_type, bitrate_bps, state, chunk_count, size_bytes
        FROM voice_media_objects
        WHERE session_id = ? AND state = 'ready'
        LIMIT 1
      `)
      .bind(objectKey)
      .first<SessionRow>();
    if (!object || Number(object.size_bytes) <= 0) return null;

    const size = Number(object.size_bytes);
    const range = resolveRange(requestHeaders.get("range"), size);
    const headers = new Headers();
    headers.set("content-type", object.mime_type);
    headers.set("accept-ranges", "bytes");
    headers.set("cache-control", "private, max-age=604800, immutable");
    headers.set("x-content-type-options", "nosniff");
    headers.set("etag", `\"d1-${object.session_id}-${size}\"`);

    if (range === "invalid") {
      headers.set("content-range", `bytes */${size}`);
      headers.set("content-length", "0");
      return { status: 416, headers, body: emptyStream() };
    }

    const start = range?.start ?? 0;
    const end = range?.end ?? size - 1;
    const status = range ? 206 : 200;
    if (range) headers.set("content-range", `bytes ${start}-${end}/${size}`);
    headers.set("content-length", String(end - start + 1));

    return {
      status,
      headers,
      body: this.chunkStream(objectKey, start, end)
    };
  }

  private async sessionRow(sessionId: string, conversationId: string, senderUserId: string): Promise<SessionRow | null> {
    return this.db
      .prepare(`
        SELECT session_id, conversation_id, sender_user_id, mime_type, bitrate_bps, state, chunk_count, size_bytes
        FROM voice_media_objects
        WHERE session_id = ? AND conversation_id = ? AND sender_user_id = ?
        LIMIT 1
      `)
      .bind(sessionId, conversationId, senderUserId)
      .first<SessionRow>();
  }

  private chunkStream(sessionId: string, start: number, end: number): ReadableStream<Uint8Array> {
    const firstPart = Math.floor(start / VOICE_CHUNK_SIZE_BYTES) + 1;
    const lastPart = Math.floor(end / VOICE_CHUNK_SIZE_BYTES) + 1;
    let partNumber = firstPart;

    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        if (partNumber > lastPart) {
          controller.close();
          return;
        }
        const row = await this.db
          .prepare("SELECT data, size_bytes FROM voice_media_chunks WHERE session_id = ? AND part_number = ? LIMIT 1")
          .bind(sessionId, partNumber)
          .first<ChunkRow>();
        if (!row) {
          controller.error(new Error(`Missing voice chunk ${partNumber}`));
          return;
        }
        const bytes = blobBytes(row.data);
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

function storedObject(row: SessionRow): VoiceStoredObject {
  return {
    key: row.session_id,
    size: Number(row.size_bytes),
    mimeType: row.mime_type,
    bitrateBps: Number(row.bitrate_bps),
    chunkCount: Number(row.chunk_count)
  };
}

function blobBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) return Uint8Array.from(value.map((entry) => Number(entry) & 0xff));
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new Error("Invalid D1 voice BLOB");
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

function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({ start: (controller) => controller.close() });
}
