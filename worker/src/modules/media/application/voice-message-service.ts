import { ApiError, notFound } from "../../../core/errors";
import type { DurableObjectNamespace } from "../../../platform/cloudflare";
import type { MessagingService } from "../../messaging/application/messaging-service";
import type { MessagingActor } from "../../messaging/domain/models";
import { validateConversationId } from "../../messaging/domain/validation";
import type { MessagingRepository } from "../../messaging/ports/messaging-repository";
import type { RealtimePublisher } from "../../messaging/ports/realtime-publisher";
import {
  validateUploadSessionId,
  validateVoiceComplete,
  validateVoiceProgress,
  validateVoiceShareSetting,
  validateVoiceStart
} from "../domain/validation";
import type { VoiceMediaReferences } from "../ports/voice-media-references";
import { VOICE_CHUNK_SIZE_BYTES, type VoiceStorage } from "../ports/voice-storage";

export class VoiceMessageService {
  constructor(
    private readonly repository: MessagingRepository,
    private readonly messaging: MessagingService,
    private readonly storage: VoiceStorage,
    private readonly realtime: RealtimePublisher,
    private readonly uploadRooms?: DurableObjectNamespace,
    private readonly mediaReferences?: VoiceMediaReferences
  ) {}

  initialize(): Promise<void> {
    return this.storage.initialize();
  }

  async startUpload(actor: MessagingActor, rawConversationId: string, body: Record<string, unknown>) {
    if (!this.uploadRooms) {
      throw new ApiError(503, "voice_upload_transport_missing", "WebSocket-канал голосовых сообщений не подключён.");
    }
    const conversationId = validateConversationId(rawConversationId);
    await this.requireConversation(conversationId, actor.userId);
    const input = validateVoiceStart(body);
    const sessionId = crypto.randomUUID();
    const session = await this.storage.create(
      sessionId,
      conversationId,
      actor.userId,
      input.mimeType,
      input.bitrateBps
    );
    return uploadView(session);
  }

  async getUploadStatus(actor: MessagingActor, rawConversationId: string, rawSessionId: string) {
    const conversationId = validateConversationId(rawConversationId);
    await this.requireConversation(conversationId, actor.userId);
    const sessionId = validateUploadSessionId(rawSessionId);
    const session = await this.storage.inspect(sessionId, conversationId, actor.userId);
    if (!session) notFound("voice_upload_not_found", "Сессия голосового сообщения не найдена.");
    return uploadView(session);
  }

  async openUploadSocket(
    actor: MessagingActor,
    rawConversationId: string,
    rawSessionId: string,
    request: Request
  ): Promise<Response> {
    if (!this.uploadRooms) {
      throw new ApiError(503, "voice_upload_transport_missing", "WebSocket-канал голосовых сообщений не подключён.");
    }
    const conversationId = validateConversationId(rawConversationId);
    await this.requireConversation(conversationId, actor.userId);
    const sessionId = validateUploadSessionId(rawSessionId);
    const session = await this.storage.inspect(sessionId, conversationId, actor.userId);
    if (!session) notFound("voice_upload_not_found", "Сессия голосового сообщения не найдена.");
    if (session.state !== "uploading") {
      throw new ApiError(409, "voice_upload_completed", "Голосовое сообщение уже завершено.");
    }

    const headers = new Headers(request.headers);
    headers.set("x-bulbam-user-id", actor.userId);
    headers.set("x-bulbam-conversation-id", conversationId);
    headers.set("x-bulbam-voice-session-id", sessionId);
    const trustedRequest = new Request(request, { headers });
    return this.uploadRooms.getByName(sessionId).fetch(trustedRequest);
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
    const stored = await this.storage.complete(
      sessionId,
      conversationId,
      actor.userId,
      input.chunkCount,
      input.sizeBytes
    );

    try {
      const result = await this.messaging.sendVoiceMessage(actor, conversationId, {
        messageId: sessionId,
        clientMessageId: input.clientMessageId,
        voice: {
          objectKey: stored.key,
          durationMs: input.durationMs,
          mimeType: stored.mimeType,
          bitrateBps: stored.bitrateBps,
          sizeBytes: stored.size
        }
      });
      await this.storage.markPublished(stored.key);
      return { ...result, sizeBytes: stored.size, chunkCount: stored.chunkCount };
    } catch (error) {
      if (error instanceof ApiError && error.code === "client_message_id_conflict") {
        await this.storage.delete(stored.key).catch(() => undefined);
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
    if (!object) notFound("voice_media_not_found", "Аудиоданные голосового сообщения не найдены.");
    return new Response(object.body, { status: object.status, headers: object.headers });
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

  async cleanupUsers(userIds: string[]): Promise<void> {
    if (this.mediaReferences) {
      const objectKeys = await this.mediaReferences.listObjectKeysForUsers(userIds);
      for (const objectKey of objectKeys) await this.storage.delete(objectKey);
    }
    await this.messaging.cleanupUsers(userIds);
  }

  private async requireConversation(conversationId: string, userId: string): Promise<void> {
    const conversation = await this.repository.findConversationForUser(conversationId, userId);
    if (!conversation) notFound("chat_not_found", "Диалог не найден.");
  }
}

function uploadView(session: {
  sessionId: string;
  state: "uploading" | "ready";
  receivedParts: number[];
  mimeType: string;
  bitrateBps: number;
  sizeBytes: number;
  chunkCount: number;
}) {
  return {
    sessionId: session.sessionId,
    messageId: session.sessionId,
    transport: "websocket" as const,
    chunkSizeBytes: VOICE_CHUNK_SIZE_BYTES,
    receivedParts: session.receivedParts,
    mimeType: session.mimeType,
    bitrateBps: session.bitrateBps,
    state: session.state,
    sizeBytes: session.sizeBytes,
    chunkCount: session.chunkCount
  };
}
