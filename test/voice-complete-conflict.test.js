import { describe, expect, test, vi } from "vitest";
import { ApiError } from "../worker/src/core/errors.ts";
import { VoiceMessageService } from "../worker/src/modules/media/application/voice-message-service.ts";

const CONVERSATION_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const ACTOR = { userId: "user-a" };
const STORED = {
  key: SESSION_ID,
  size: 32,
  mimeType: "audio/webm;codecs=opus",
  bitrateBps: 64_000,
  chunkCount: 1
};
const COMPLETE_BODY = {
  clientMessageId: "voice_conflict_12345678",
  durationMs: 2_000,
  chunkCount: 1,
  sizeBytes: 32
};

function serviceWith(findMessageForUser) {
  const repository = {
    findConversationForUser: vi.fn(async () => ({
      conversationId: CONVERSATION_ID,
      participantAId: "user-a",
      participantBId: "user-b",
      createdAt: 1,
      lastMessageAt: null
    })),
    findMessageForUser: vi.fn(findMessageForUser)
  };
  const messaging = {
    sendVoiceMessage: vi.fn(async () => {
      throw new ApiError(409, "client_message_id_conflict", "conflict");
    })
  };
  const storage = {
    initialize: vi.fn(async () => undefined),
    complete: vi.fn(async () => STORED),
    markPublished: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined)
  };
  const realtime = {};
  return {
    service: new VoiceMessageService(repository, messaging, storage, realtime),
    repository,
    storage
  };
}

describe("voice complete conflict cleanup", () => {
  test("deletes media only when D1 positively confirms no message references it", async () => {
    const { service, storage } = serviceWith(async () => null);

    await expect(service.completeUpload(ACTOR, CONVERSATION_ID, SESSION_ID, COMPLETE_BODY))
      .rejects.toMatchObject({ code: "client_message_id_conflict" });

    expect(storage.delete).toHaveBeenCalledWith(SESSION_ID);
  });

  test("preserves media already referenced by the published D1 message", async () => {
    const { service, storage } = serviceWith(async () => ({
      messageId: SESSION_ID,
      conversationId: CONVERSATION_ID,
      senderUserId: "user-a",
      clientMessageId: "voice_original_12345678",
      kind: "voice",
      text: "Голосовое сообщение",
      voice: {
        objectKey: SESSION_ID,
        durationMs: 2_000,
        mimeType: STORED.mimeType,
        bitrateBps: STORED.bitrateBps,
        sizeBytes: STORED.size,
        progress: null
      },
      createdAt: 1,
      deliveredAt: null
    }));

    await expect(service.completeUpload(ACTOR, CONVERSATION_ID, SESSION_ID, COMPLETE_BODY))
      .rejects.toMatchObject({ code: "client_message_id_conflict" });

    expect(storage.delete).not.toHaveBeenCalled();
  });

  test("preserves media when D1 lookup itself fails", async () => {
    const { service, storage } = serviceWith(async () => {
      throw new Error("temporary D1 failure");
    });

    await expect(service.completeUpload(ACTOR, CONVERSATION_ID, SESSION_ID, COMPLETE_BODY))
      .rejects.toMatchObject({ code: "client_message_id_conflict" });

    expect(storage.delete).not.toHaveBeenCalled();
  });
});
