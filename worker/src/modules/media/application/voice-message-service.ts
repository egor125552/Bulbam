import { ApiError, notFound } from "../../../core/errors";
import type { MessagingService } from "../../messaging/application/messaging-service";
import type { MessagingActor } from "../../messaging/domain/models";
import { validateConversationId } from "../../messaging/domain/validation";
import type { MessagingRepository } from "../../messaging/ports/messaging-repository";
import type { RealtimePublisher } from "../../messaging/ports/realtime-publisher";
import {
  validatePartNumber,
  validateUploadId,
  validateUploadSessionId,
  validateVoiceComplete,
  validateVoiceProgress,
  validateVoiceShareSetting,
  validateVoiceStart
} from "../domain/validation";
import type { VoiceStorage } from "../ports/voice-storage";

export const VOICE_PART_SIZE_BYTES = 5 * 1024 * 1024;
const MAX_PART_REQUEST_BYTES = VOICE_PART_SIZE_BYTES;

export class VoiceMessageService {
  constructor(
    private readonly repository: MessagingRepository,
    private readonly messaging: MessagingService,
    private readonly storage: VoiceStorage,
    private readonly realtime: RealtimePublisher
  ) {}

  async startUpload(actor: MessagingActor, rawConversationId: string, body: Record<string, unknown>) {
    const conversationId = validateConversationId(rawConversationId);
    await this.requireConversation(conversationId, actor.userId);
    const input = validateVoiceStart(body);
    const sessionId = crypto.randomUUID();
    const objectKey = objectKeyFor(actor.userId, conversationId, sessionId);
    const upload = await this.storage.create(objectKey, input.mimeType, input.bitrateBps);
    return {
      sessionId,
      messageId: sessionId,
      uploadId: upload.uploadId,
      partSizeBytes: VOICE_PART_SIZE_BYTES,
      mimeType: input.mimeType,
      bitrateBps: input.bitrateBps
    };
  }

  async uploadPart(
    actor: MessagingActor,
    rawConversationId: string,
    rawSessionId: string,
    rawPartNumber: string,
    rawUploadId: unknown,
    request: Request
  ) {
    const conversationId = validateConversationId(rawConversationId);
    await this.requireConversation(conversationId, actor.userId);
    const sessionId = validateUploadSessionId(rawSessionId);
    const partNumber = validatePartNumber(rawPartNumber);
    const uploadId = validateUploadId(rawUploadId);
    if (!request.body) throw new ApiError(400, "empty_voice_part", "Часть голосового сообщения пустая.");

    const contentLength = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(contentLength) && contentLength > MAX_PART_REQUEST_BYTES) {
      throw new ApiError(413, "voice_part_too_large", "Часть голосового сообщения слишком большая.");
    }

    const objectKey = objectKeyFor(actor.userId, conversationId, sessionId);
    return this.storage.uploadPart(objectKey, uploadId, partNumber, request.body);
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
    const input = validateVoiceComplete(body);
    const objectKey = objectKeyFor(actor.userId, conversationId, sessionId);
    const stored = await this.storage.complete(objectKey, input.uploadId, input.parts);
    const storedMimeType = stored.customMetadata.bulbamVoiceMimeType;
    const storedBitrateBps = Number(stored.customMetadata.bulbamVoiceBitrateBps);
    if (storedMimeType !== input.mimeType || storedBitrateBps !== input.bitrateBps) {
      await this.storage.delete(objectKey).catch(() => undefined);
      throw new ApiError(409, "voice_upload_metadata_mismatch", "Параметры завершённой записи не совпадают с началом загрузки.");
    }

    try {
      const result = await this.messaging.sendVoiceMessage(actor, conversationId, {
        messageId: sessionId,
        clientMessageId: input.clientMessageId,
        voice: {
          objectKey,
          durationMs: input.durationMs,
          mimeType: storedMimeType,
          bitrateBps: storedBitrateBps,
          sizeBytes: stored.size
        }
      });
      return { ...result, sizeBytes: stored.size };
    } catch (error) {
      if (error instanceof ApiError && error.code === "client_message_id_conflict") {
        await this.storage.delete(objectKey).catch(() => undefined);
      }
      throw error;
    }
  }

  async abortUpload(
    actor: MessagingActor,
    rawConversationId: string,
    rawSessionId: string,
    rawUploadId: unknown
  ): Promise<void> {
    const conversationId = validateConversationId(rawConversationId);
    await this.requireConversation(conversationId, actor.userId);
    const sessionId = validateUploadSessionId(rawSessionId);
    const uploadId = validateUploadId(rawUploadId);
    await this.storage.abort(objectKeyFor(actor.userId, conversationId, sessionId), uploadId);
  }

  async streamVoice(
    actor: MessagingActor,
    rawConversationId: string,
    rawMessageId: string,
    requestHeaders: Headers
  ): Promise<Response> {
    const conversationId = validateConversationId(rawConversationId);
    const messageId = validateUploadSessionId(rawMessageId);
    const message = await this.repository.findMessageForUser(conversationId, messageId, actor.userId);
    if (!message || message.kind !== "voice" || !message.voice) {
      notFound("voice_message_not_found", "Голосовое сообщение не найдено.");
    }

    const object = await this.storage.read(message.voice.objectKey, requestHeaders);
    if (!object) notFound("voice_media_not_found", "Аудиофайл голосового сообщения не найден.");
    const partial = requestHeaders.has("range") && object.headers.has("content-range");
    object.headers.delete("x-bulbam-range-status");
    return new Response(object.body, { status: partial ? 206 : 200, headers: object.headers });
  }

  async updateListening(
    actor: MessagingActor,
    rawConversationId: string,
    rawMessageId: string,
    body: Record<string, unknown>
  ) {
    const conversationId = validateConversationId(rawConversationId);
    const messageId = validateUploadSessionId(rawMessageId);
    const input = validateVoiceProgress(body);
    const now = Date.now();
    const update = await this.repository.updateVoiceListening(
      conversationId,
      messageId,
      actor.userId,
      input.heardRanges,
      input.resumeMs,
      input.completed,
      now
    );
    if (!update) notFound("voice_message_not_found", "Голосовое сообщение не найдено или принадлежит вам.");

    const share = await this.repository.getVoiceListeningShare(actor.userId);
    if (share) {
      await this.realtime.publishToUsers([update.message.senderUserId], {
        type: "voice.progress",
        conversationId,
        messageId,
        progress: update.progress,
        active: input.active,
        staleAt: input.active ? now + 8000 : now
      });
    }

    return { progress: update.progress, shared: share };
  }

  async getSettings(actor: MessagingActor) {
    return { shareListening: await this.repository.getVoiceListeningShare(actor.userId) };
  }

  async setSettings(actor: MessagingActor, body: Record<string, unknown>) {
    const shareListening = validateVoiceShareSetting(body);
    await this.repository.setVoiceListeningShare(actor.userId, shareListening, Date.now());
    return { shareListening };
  }

  private async requireConversation(conversationId: string, userId: string): Promise<void> {
    const conversation = await this.repository.findConversationForUser(conversationId, userId);
    if (!conversation) notFound("chat_not_found", "Диалог не найден.");
  }
}

function objectKeyFor(userId: string, conversationId: string, sessionId: string): string {
  return `voice/${userId}/${conversationId}/${sessionId}`;
}
