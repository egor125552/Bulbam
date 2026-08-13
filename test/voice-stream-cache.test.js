import { describe, expect, test, vi } from "vitest";
import { VoiceMessageService } from "../worker/src/modules/media/application/voice-message-service.ts";

const CONVERSATION_ID = "11111111-1111-4111-8111-111111111111";
const MESSAGE_ID = "22222222-2222-4222-8222-222222222222";
const ACTOR = { userId: "listener-a" };

describe("voice stream cache isolation", () => {
  test("keeps private Range caching but separates responses by session cookie", async () => {
    const repository = {
      findMessageForUser: vi.fn(async () => ({
        messageId: MESSAGE_ID,
        conversationId: CONVERSATION_ID,
        senderUserId: "sender-a",
        clientMessageId: "voice_stream_12345678",
        kind: "voice",
        text: "Голосовое сообщение",
        voice: {
          objectKey: "voice-object-key",
          durationMs: 2_000,
          mimeType: "audio/webm;codecs=opus",
          bitrateBps: 64_000,
          sizeBytes: 10,
          progress: null
        },
        createdAt: 1,
        deliveredAt: null
      }))
    };
    const storage = {
      initialize: vi.fn(async () => undefined),
      read: vi.fn(async () => ({
        status: 206,
        body: new Uint8Array([1, 2, 3, 4]),
        headers: new Headers({
          "cache-control": "private, max-age=604800, immutable",
          "content-range": "bytes 0-3/10",
          "content-type": "audio/webm;codecs=opus",
          "accept-ranges": "bytes",
          vary: "Accept-Encoding"
        })
      }))
    };
    const service = new VoiceMessageService(repository, {}, storage, {});
    const requestHeaders = new Headers({ range: "bytes=0-3" });

    const response = await service.streamVoice(ACTOR, CONVERSATION_ID, MESSAGE_ID, requestHeaders);

    expect(response.status).toBe(206);
    expect(response.headers.get("cache-control")).toBe("private, max-age=604800, immutable");
    expect(response.headers.get("vary")).toBe("Accept-Encoding, Cookie");
    expect(response.headers.get("content-range")).toBe("bytes 0-3/10");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(storage.read).toHaveBeenCalledWith("voice-object-key", requestHeaders);
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2, 3, 4]);
  });
});
