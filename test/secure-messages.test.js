import { webcrypto } from "node:crypto";
import { beforeAll, afterAll, describe, expect, test } from "vitest";
import "fake-indexeddb/auto";
import {
  SECURE_PREFIX, generateConversationSecret, importConversationSecret,
  encryptText, decryptText, isEncryptedText, saveConversationKey, loadConversationKey, forgetConversationKey
} from "../web/js/secure-messages.js";

let previousCrypto;
beforeAll(() => {
  previousCrypto = globalThis.crypto;
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });
});
afterAll(() => {
  if (previousCrypto) Object.defineProperty(globalThis, "crypto", { configurable: true, value: previousCrypto });
});

const context = {
  conversationId: "22222222-2222-4222-8222-222222222222",
  senderUserId: "11111111-1111-4111-8111-111111111111",
  clientMessageId: "cm_test_12345678"
};

describe("experimental shared-key message encryption", () => {
  test("roundtrip produces opaque ciphertext and authenticates context", async () => {
    const secret = generateConversationSecret();
    const key = await importConversationSecret(secret);
    const wire = await encryptText("Привет, шифрование 🔐", key, context);
    expect(wire.startsWith(SECURE_PREFIX)).toBe(true);
    expect(wire).not.toContain("Привет");
    expect(wire).not.toContain("шифрование");
    expect(await decryptText(wire, key, context)).toBe("Привет, шифрование 🔐");
    await expect(decryptText(wire, key, { ...context, senderUserId: "attacker" })).rejects.toThrow();
    await expect(decryptText(wire, key, { ...context, conversationId: "other-chat" })).rejects.toThrow();
    await expect(decryptText(wire, key, { ...context, clientMessageId: "wrong-id" })).rejects.toThrow();
  });

  test("different keys cannot read the message and edits cannot pass authentication", async () => {
    const first = await importConversationSecret(generateConversationSecret());
    const second = await importConversationSecret(generateConversationSecret());
    const wire = await encryptText("Очень личное сообщение", first, context);
    await expect(decryptText(wire, second, context)).rejects.toThrow();
    const mutated = wire.slice(0, -1) + (wire.at(-1) === "A" ? "B" : "A");
    await expect(decryptText(mutated, first, context)).rejects.toThrow();
  });

  test("requires a high entropy secret, limits payload size and strictly parses", async () => {
    await expect(importConversationSecret("weak-password")).rejects.toThrow();
    const key = await importConversationSecret(generateConversationSecret());
    await expect(encryptText("a".repeat(6000), key, context)).rejects.toThrow();
    expect(isEncryptedText("ordinary message")).toBe(false);
    expect(isEncryptedText(SECURE_PREFIX + "something")).toBe(true);
    await expect(decryptText(SECURE_PREFIX + "bad", key, context)).rejects.toThrow();
  });

  test("saves only a non-exportable device key without silently replacing it", async () => {
    const a = generateConversationSecret();
    const b = generateConversationSecret();
    await saveConversationKey("account-a", "chat-a", a);
    const key = await loadConversationKey("account-a", "chat-a");
    expect(key.extractable).toBe(false);
    await expect(webcrypto.subtle.exportKey("raw", key)).rejects.toThrow();
    const wire = await encryptText("текст", key, context);
    expect(await decryptText(wire, key, context)).toBe("текст");
    await expect(saveConversationKey("account-a", "chat-a", b)).rejects.toThrow();
    expect(await loadConversationKey("account-b", "chat-a")).toBeNull();
    await forgetConversationKey('account-a','chat-a');
    expect(await loadConversationKey('account-a','chat-a')).toBeNull();
    await saveConversationKey('account-a','chat-a',a);
    const restored=await loadConversationKey('account-a','chat-a');
    expect(await decryptText(wire,restored,context)).toBe('текст');
  });
});
