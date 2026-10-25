import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { chatPreview } from "../web/js/chat-presentation.js";

const load = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

describe("secure messages never silently downgrade", () => {
  test("outgoing protected text is sent as ciphertext and authenticated with conversation context", async () => {
    const client = await load("web/js/messenger.js");
    expect(client).toContain("await encryptText(text, secure.sendKey");
    expect(client).toContain("text: pending.wireText ?? pending.text");
    expect(client).toContain("await encryptText(pending.text");
    expect(client).toContain("isEncryptedText(message.text)");
    expect(client).toContain("Невозможно проверить ключ переписки");
  });

  test("protected previews and notification bodies never expose the envelope", async () => {
    expect(chatPreview({ kind: "text", senderUserId: "other", text: "bmsec1:abc.def" }, "me")).toBe("Сообщение");
    const server = await load("worker/src/modules/notifications/application/push-notification-service.ts");
    expect(server).toContain('text.startsWith("bmsec1:")');
    expect(server).toContain('return "Новое сообщение"');
  });

  test("does not allow voice to be sent in the protected text mode", async () => {
    const voice = await load("web/js/voice-recorder.js");
    expect(voice).toContain('import { getSecureChatState } from "./secure-chat-ui.js"');
    expect(voice).toContain("draft.conversationId");
    expect(voice).toContain("Голосовое не отправлено");
  });
});
