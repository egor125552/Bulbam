import { webcrypto } from "node:crypto";
import { beforeAll, afterAll, describe, expect, test } from "vitest";
import { generateConversationSecret, importConversationSecret } from "../web/js/secure-messages.js";
import {
  encryptedVoiceMime, parseEncryptedVoiceMime, generateVoiceNonce,
  encryptVoicePart, decryptVoicePart, decryptVoiceFile,
  VOICE_PLAIN_CHUNK_BYTES, VOICE_CIPHER_CHUNK_BYTES
} from "../web/js/secure-voice.js";

let oldCrypto;
beforeAll(() => { oldCrypto = globalThis.crypto; Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto }); });
afterAll(() => { if (oldCrypto) Object.defineProperty(globalThis, "crypto", { configurable: true, value: oldCrypto }); });

const context = { conversationId:"a1111111-1111-4111-8111-111111111111", senderUserId:"b2222222-2222-4222-8222-222222222222", clientMessageId:"audio_secure_1234" };
const encoder = new TextEncoder();

describe("chunked protected voice", () => {
  test("validates an encrypted voice MIME envelope without accepting spoofed audio", () => {
    const nonce = generateVoiceNonce();
    const mime = encryptedVoiceMime("audio/webm;codecs=opus", nonce);
    expect(parseEncryptedVoiceMime(mime)).toEqual({ mimeType: "audio/webm;codecs=opus", nonce });
    expect(parseEncryptedVoiceMime("audio/webm;codecs=opus")).toBeNull();
    expect(() => encryptedVoiceMime("application/x-unknown", nonce)).toThrow();
    expect(() => parseEncryptedVoiceMime(mime.replace("v=1","v=2"))).toThrow();
  });
  test("encrypts, authenticates and resumes binary voice parts with stable offsets", async () => {
    const key = await importConversationSecret(generateConversationSecret());
    const nonce = generateVoiceNonce();
    const metadata = encryptedVoiceMime("audio/webm", nonce);
    const plain = new Uint8Array(VOICE_PLAIN_CHUNK_BYTES + 543);
    webcrypto.getRandomValues(plain.subarray(0, 65536));
    plain[plain.length - 1] = 123;
    const first = await encryptVoicePart(plain.subarray(0, VOICE_PLAIN_CHUNK_BYTES), key, metadata, context, 1);
    const second = await encryptVoicePart(plain.subarray(VOICE_PLAIN_CHUNK_BYTES), key, metadata, context, 2, plain.byteLength);
    expect(first.byteLength).toBe(VOICE_CIPHER_CHUNK_BYTES);
    expect(second.byteLength).toBe(543 + 16);
    expect(first.subarray(0,32)).not.toEqual(plain.subarray(0,32));
    const wire = new Blob([first, second]);
    const decoded = await decryptVoiceFile(wire, key, metadata, context);
    expect(new Uint8Array(await decoded.arrayBuffer())).toEqual(plain);
    const repeated = await encryptVoicePart(plain.subarray(0, VOICE_PLAIN_CHUNK_BYTES), key, metadata, context, 1);
    expect(repeated).toEqual(first); // resumable duplicate uploads produce identical ciphertext
    expect(new Uint8Array(await decryptVoicePart(first, key, metadata, context, 1))).toEqual(plain.subarray(0, VOICE_PLAIN_CHUNK_BYTES));
  });
  test("rejects a different key, conversation, part number, ciphertext modification or reordering", async () => {
    const key = await importConversationSecret(generateConversationSecret());
    const other = await importConversationSecret(generateConversationSecret());
    const mime = encryptedVoiceMime("audio/mp4", generateVoiceNonce());
    const encrypted = await encryptVoicePart(encoder.encode("secret sound"), key, mime, context, 1, 12);
    await expect(decryptVoicePart(encrypted, other, mime, context, 1)).rejects.toThrow();
    await expect(decryptVoicePart(encrypted, key, mime, {...context, conversationId:"other"}, 1)).rejects.toThrow();
    await expect(decryptVoicePart(encrypted, key, mime, context, 2)).rejects.toThrow();
    const broken = encrypted.slice();
    broken[3] ^= 1;
    await expect(decryptVoicePart(broken, key, mime, context, 1)).rejects.toThrow();
  });
  test("never accepts empty voice data, invalid nonce or a trailing forged part", async () => {
    const key = await importConversationSecret(generateConversationSecret());
    const mime = encryptedVoiceMime("audio/webm", generateVoiceNonce());
    await expect(decryptVoiceFile(new Blob([]), key, mime, context)).rejects.toThrow();
    await expect(decryptVoicePart(new Uint8Array(0), key, mime, context, 1)).rejects.toThrow();
    expect(() => encryptedVoiceMime("audio/webm", "short")).toThrow();
  });
});
