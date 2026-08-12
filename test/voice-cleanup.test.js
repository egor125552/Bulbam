import { describe, expect, test, vi } from "vitest";
import { VoiceMessageService } from "../worker/src/modules/media/application/voice-message-service.ts";

describe("voice media cleanup", () => {
  test("deletes referenced voice objects before deleting conversation data", async () => {
    const order = [];
    const messaging = {
      cleanupUsers: vi.fn(async (userIds) => {
        expect(userIds).toEqual(["user-a", "user-b"]);
        order.push("messages");
      })
    };
    const storage = {
      initialize: async () => undefined,
      delete: vi.fn(async (key) => order.push(`delete:${key}`))
    };
    const references = {
      listObjectKeysForUsers: vi.fn(async (userIds) => {
        expect(userIds).toEqual(["user-a", "user-b"]);
        order.push("references");
        return ["voice-1", "voice-2"];
      })
    };

    const service = new VoiceMessageService(
      {},
      messaging,
      storage,
      {},
      undefined,
      references
    );

    await service.cleanupUsers(["user-a", "user-b"]);

    expect(order).toEqual(["references", "delete:voice-1", "delete:voice-2", "messages"]);
    expect(messaging.cleanupUsers).toHaveBeenCalledOnce();
  });

  test("keeps D1 conversation data when durable media deletion fails", async () => {
    const messaging = { cleanupUsers: vi.fn(async () => undefined) };
    const storage = {
      initialize: async () => undefined,
      delete: vi.fn(async () => {
        throw new Error("temporary durable object failure");
      })
    };
    const references = {
      listObjectKeysForUsers: vi.fn(async () => ["voice-failure"])
    };

    const service = new VoiceMessageService(
      {},
      messaging,
      storage,
      {},
      undefined,
      references
    );

    await expect(service.cleanupUsers(["user-a"])).rejects.toThrow("temporary durable object failure");
    expect(messaging.cleanupUsers).not.toHaveBeenCalled();
  });
});
