import { ApiError, badRequest, notFound } from "../../../core/errors";
import type { MessagingService } from "../../messaging/application/messaging-service";
import type { MessagingActor } from "../../messaging/domain/models";
import { validateConversationId } from "../../messaging/domain/validation";
import type { MessagingRepository } from "../../messaging/ports/messaging-repository";
import {
  classifyFileMedia,
  FILE_CHUNK_SIZE_BYTES,
  formatContentDisposition,
  validateFileComplete,
  validateFilePartNumber,
  validateFileStart
} from "../domain/file-validation";
import { validateUploadSessionId } from "../domain/validation";
import type { VoiceStorage } from "../ports/voice-storage";

export class FileMessageService {
  constructor(
    private readonly repository: MessagingRepository,
    private readonly messaging: MessagingService,
    private readonly storage: VoiceStorage
  ) {}

  async startUpload(
    actor: MessagingActor,
    rawConversationId: string,
    body: Record<string, unknown>
  ) {
    const conversationId = validateConversationId(rawConversationId);
    await this.requireConversation(conversationId, actor.userId);
    const input = validateFileStart(body);
    const sessionId = crypto.randomUUID();
    const session = await this.storage.create(
      sessionId,
      conversationId,
      actor.userId,
      input.mimeType,
      0,
      {
        kind: "file",
        chunkSizeBytes: FILE_CHUNK_SIZE_BYTES,
        fileName: input.fileName,
        mediaKind: input.mediaKind
      }
    );
    return fileUploadView(session, input.partCount, input.sizeBytes);
  }

  async getUploadStatus(
    actor: MessagingActor,
    rawConversationId: string,
    rawSessionId: string
  ) {
    const conversationId = validateConversationId(rawConversationId);
    await this.requireConversation(conversationId, actor.userId);
    const sessionId = validateUploadSessionId(rawSessionId);
    const session = await this.storage.inspect(sessionId, conversationId, actor.userId);
    if (!session || session.kind !== "file") {
      notFound("file_upload_not_found", "Сессия загрузки файла не найдена.");
    }
    return fileUploadView(session);
  }

  async uploadPart(
    actor: MessagingActor,
    rawConversationId: string,
    rawSessionId: string,
    rawPartNumber: string,
    bytes: Uint8Array
  ) {
    const conversationId = validateConversationId(rawConversationId);
    await this.requireConversation(conversationId, actor.userId);
    const sessionId = validateUploadSessionId(rawSessionId);
    const partNumber = validateFilePartNumber(rawPartNumber);
    if (!bytes.byteLength) {
      badRequest("empty_file_part", "Пустая часть файла.");
    }
    if (bytes.byteLength > FILE_CHUNK_SIZE_BYTES) {
      throw new ApiError(413, "file_part_too_large", "Часть файла превышает допустимый размер.");
    }
    const result = await this.storage.writeChunk(
      sessionId,
      conversationId,
      actor.userId,
      partNumber,
      bytes
    );
    return {
      sessionId,
      partNumber,
      sizeBytes: result.sizeBytes,
      duplicate: result.duplicate
    };
  }

  async completeUpload(
    actor: MessagingActor,
    rawConversationId: string,
    rawSessionId: string,
    body: Record<string, unknown>
  ) {
    const conversationId = validateConversationId(rawConversationId);
    await this.requireConversation(conversationId, actor.userId);
    const sessionId = validateUploadSessionId(rawSessionId);
    const input = validateFileComplete(body);

    const session = await this.storage.inspect(sessionId, conversationId, actor.userId);
    if (!session || session.kind !== "file") {
      notFound("file_upload_not_found", "Сессия загрузки файла не найдена.");
    }

    const stored = await this.storage.complete(
      sessionId,
      conversationId,
      actor.userId,
      input.chunkCount,
      input.sizeBytes
    );

    const fileName = stored.fileName ?? session.fileName ?? "file";
    const classified = classifyFileMedia(stored.mimeType, fileName);

    try {
      const result = await this.messaging.sendFileMessage(actor, conversationId, {
        messageId: sessionId,
        clientMessageId: input.clientMessageId,
        text: input.caption,
        file: {
          objectKey: stored.key,
          fileName,
          mimeType: classified.mimeType,
          mediaKind: classified.mediaKind,
          sizeBytes: stored.size
        }
      });
      await this.storage.markPublished(stored.key);
      return { ...result, sizeBytes: stored.size, chunkCount: stored.chunkCount };
    } catch (error) {
      if (error instanceof ApiError && error.code === "client_message_id_conflict") {
        try {
          const existing = await this.repository.findMessageForUser(
            conversationId,
            sessionId,
            actor.userId
          );
          const alreadyReferenced = Boolean(
            existing?.kind === "file" && existing.file?.objectKey === stored.key
          );
          if (!alreadyReferenced) {
            await this.storage.delete(stored.key).catch(() => undefined);
          }
        } catch (lookupError) {
          console.warn("[Bulbam] file conflict cleanup deferred", lookupError);
        }
      }
      throw error;
    }
  }

  async abortUpload(
    actor: MessagingActor,
    rawConversationId: string,
    rawSessionId: string
  ): Promise<void> {
    const conversationId = validateConversationId(rawConversationId);
    await this.requireConversation(conversationId, actor.userId);
    const sessionId = validateUploadSessionId(rawSessionId);
    await this.storage.abort(sessionId, conversationId, actor.userId);
  }

  async serveFile(
    actor: MessagingActor,
    rawConversationId: string,
    rawMessageId: string,
    requestHeaders: Headers,
    options: { download: boolean; headOnly?: boolean }
  ): Promise<Response> {
    const conversationId = validateConversationId(rawConversationId);
    const messageId = validateUploadSessionId(rawMessageId);
    const message = await this.repository.findMessageForUser(conversationId, messageId, actor.userId);
    if (!message || message.kind !== "file" || !message.file) {
      notFound("file_message_not_found", "Файл не найден.");
    }

    const object = await this.storage.read(message.file.objectKey, requestHeaders);
    if (!object) notFound("file_media_not_found", "Содержимое файла не найдено.");

    const classified = classifyFileMedia(message.file.mimeType, message.file.fileName);
    const forceAttachment = options.download || !classified.safeInline;
    const headers = new Headers(object.headers);
    headers.set("content-type", forceAttachment ? classified.mimeType : classified.mimeType);
    headers.set("x-content-type-options", "nosniff");
    headers.set("vary", appendVary(headers.get("vary"), "Cookie"));
    headers.set(
      "content-disposition",
      formatContentDisposition(forceAttachment ? "attachment" : "inline", message.file.fileName)
    );
    if (forceAttachment) {
      headers.set("content-security-policy", "default-src 'none'; sandbox");
    } else {
      headers.set("content-security-policy", "default-src 'none'; media-src 'self'; img-src 'self'");
    }

    if (options.headOnly) {
      await object.body.cancel().catch(() => undefined);
      return new Response(null, { status: object.status, headers });
    }
    return new Response(object.body, { status: object.status, headers });
  }

  private async requireConversation(conversationId: string, userId: string): Promise<void> {
    const conversation = typeof this.repository.findAnyConversationForUser === "function"
      ? await this.repository.findAnyConversationForUser(conversationId, userId)
      : await this.repository.findConversationForUser(conversationId, userId);
    if (!conversation) notFound("chat_not_found", "Диалог не найден.");
  }
}

function fileUploadView(
  session: {
    sessionId: string;
    state: "uploading" | "ready";
    receivedParts: number[];
    mimeType: string;
    chunkSizeBytes?: number;
    fileName?: string;
    mediaKind?: "image" | "video" | "audio" | "file";
    sizeBytes: number;
    chunkCount: number;
  },
  partCount?: number,
  expectedSizeBytes?: number
) {
  return {
    sessionId: session.sessionId,
    messageId: session.sessionId,
    transport: "http" as const,
    chunkSizeBytes: session.chunkSizeBytes ?? FILE_CHUNK_SIZE_BYTES,
    receivedParts: session.receivedParts,
    fileName: session.fileName ?? "file",
    mimeType: session.mimeType,
    mediaKind: session.mediaKind ?? "file",
    state: session.state,
    sizeBytes: session.sizeBytes,
    chunkCount: session.chunkCount,
    ...(partCount !== undefined ? { partCount } : {}),
    ...(expectedSizeBytes !== undefined ? { expectedSizeBytes } : {})
  };
}

function appendVary(current: string | null, value: string): string {
  const fields = (current ?? "")
    .split(",")
    .map((field) => field.trim())
    .filter(Boolean);
  if (!fields.some((field) => field.toLowerCase() === value.toLowerCase())) fields.push(value);
  return fields.join(", ");
}
