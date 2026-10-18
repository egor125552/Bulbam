// Voice encryption v1. This uses Web Crypto AES-256-GCM, not a novel cipher.
// Each recorded file has a fresh 96-bit random nonce; the last 32 bits are
// XORed with an independent part number, preventing nonce reuse within a file.
// Every part is authenticated and a dedicated final tag detects truncation.
export const VOICE_CIPHER_CHUNK_BYTES = 256 * 1024;
export const VOICE_PLAIN_CHUNK_BYTES = VOICE_CIPHER_CHUNK_BYTES - 16;
export const MAX_PROTECTED_VOICE_BYTES = 32 * 1024 * 1024;
const PREFIX = "application/vnd.bulbam.encrypted-voice;v=1;codec=";
const CODECS = {
  "mp4": "audio/mp4",
  "webm-opus": "audio/webm;codecs=opus",
  "webm": "audio/webm",
  "ogg-opus": "audio/ogg;codecs=opus",
  "ogg": "audio/ogg"
};

const cryptoApi = () => {
  if (!globalThis.crypto?.subtle || !globalThis.crypto?.getRandomValues) {
    throw new Error("Защищённое голосовое недоступно в этом браузере.");
  }
  return globalThis.crypto;
};
function base64Url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"");
}
function readNonce(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{16}$/.test(value)) {
    throw new Error("Повреждённый ключевой параметр голосового.");
  }
  let bytes;
  try {
    bytes = Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
  } catch {
    throw new Error("Повреждённый ключевой параметр голосового.");
  }
  if (bytes.length !== 12 || base64Url(bytes) !== value) {
    throw new Error("Некорректный ключевой параметр голосового.");
  }
  return bytes;
}
export function generateVoiceNonce() {
  const nonce = new Uint8Array(12);
  cryptoApi().getRandomValues(nonce);
  return base64Url(nonce);
}

export function encryptedVoiceMime(mimeType, nonce) {
  const codec = Object.keys(CODECS).find((key) => CODECS[key] === mimeType);
  if (!codec) throw new Error("Неподдерживаемый тип защищённого аудио.");
  readNonce(nonce);
  return `${PREFIX}${codec};nonce=${nonce}`;
}

export function parseEncryptedVoiceMime(mimeType) {
  if (typeof mimeType !== "string" || !mimeType.startsWith("application/vnd.bulbam.encrypted-voice")) return null;
  const match = mimeType.match(/^application\/vnd\.bulbam\.encrypted-voice;v=1;codec=(mp4|webm-opus|webm|ogg-opus|ogg);nonce=([A-Za-z0-9_-]{16})$/);
  if (!match) throw new Error("Неизвестный формат защищённого голосового.");
  readNonce(match[2]);
  return { mimeType: CODECS[match[1]], nonce: match[2] };
}

function partIv(mime, partNumber) {
  const parsed = parseEncryptedVoiceMime(mime);
  if (!parsed) throw new Error("Это не защищённое голосовое.");
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber >= 0xffffffff) {
    throw new Error("Некорректный номер части голосового.");
  }
  const iv = readNonce(parsed.nonce);
  const dv = new DataView(iv.buffer);
  dv.setUint32(8, dv.getUint32(8) ^ partNumber);
  return iv;
}

function metadata(mime, context, partNumber, finalBytes = null) {
  if (!context || ["conversationId","senderUserId","clientMessageId"].some(
    (field) => typeof context[field] !== "string" || !context[field] || context[field].length > 120
  )) throw new Error("Недостаточно данных о защищённом голосовом.");
  return new TextEncoder().encode(JSON.stringify([
    "bulbam.voice.gcm.v1", mime, context.conversationId, context.senderUserId,
    context.clientMessageId, partNumber, finalBytes === null ? "part" : "final", finalBytes
  ]));
}
function bytesView(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  throw new Error("Некорректные байты защищённого голосового.");
}

export async function encryptVoicePart(plaintext, key, mime, context, partNumber) {
  const bytes = bytesView(plaintext);
  if (!bytes.length || bytes.length > VOICE_PLAIN_CHUNK_BYTES) {
    throw new Error("Некорректный размер части голосового.");
  }
  const cipher = await cryptoApi().subtle.encrypt({
    name: "AES-GCM", iv: partIv(mime, partNumber),
    additionalData: metadata(mime, context, partNumber), tagLength: 128
  }, key, bytes);
  return new Uint8Array(cipher);
}

export async function decryptVoicePart(ciphertext, key, mime, context, partNumber) {
  const bytes = bytesView(ciphertext);
  if (bytes.length <= 16 || bytes.length > VOICE_CIPHER_CHUNK_BYTES) {
    throw new Error("Повреждённый размер зашифрованной части.");
  }
  return cryptoApi().subtle.decrypt({
    name: "AES-GCM", iv: partIv(mime, partNumber),
    additionalData: metadata(mime, context, partNumber), tagLength: 128
  }, key, bytes);
}

export async function encryptVoiceEnd(key, mime, context, partNumber, totalPlainBytes) {
  if (!Number.isSafeInteger(totalPlainBytes) || totalPlainBytes < 1) throw new Error("Пустое голосовое.");
  const tag = await cryptoApi().subtle.encrypt({
    name: "AES-GCM", iv: partIv(mime, partNumber),
    additionalData: metadata(mime, context, partNumber, totalPlainBytes), tagLength: 128
  }, key, new Uint8Array());
  return new Uint8Array(tag);
}

export async function decryptVoiceFile(blob, key, mime, context) {
  const parsed = parseEncryptedVoiceMime(mime);
  if (!parsed) throw new Error("Файл голосового не зашифрован.");
  if (!blob || blob.size <= 32 || blob.size > MAX_PROTECTED_VOICE_BYTES + 32 * 1024) {
    throw new Error("Недопустимый размер защищённого голосового.");
  }
  const dataSize = blob.size - 16;
  const dataParts = Math.ceil(dataSize / VOICE_CIPHER_CHUNK_BYTES);
  if (!dataParts) throw new Error("Пустое защищённое голосовое.");
  const decoded = [];
  let plainBytes = 0;
  for (let index = 0; index < dataParts; index++) {
    const part = new Uint8Array(await blob.slice(index * VOICE_CIPHER_CHUNK_BYTES,
      Math.min(dataSize, (index + 1) * VOICE_CIPHER_CHUNK_BYTES)).arrayBuffer());
    const bytes = await decryptVoicePart(part, key, mime, context, index + 1);
    decoded.push(bytes);
    plainBytes += bytes.byteLength;
  }
  const finalTag = new Uint8Array(await blob.slice(dataSize).arrayBuffer());
  await cryptoApi().subtle.decrypt({
    name: "AES-GCM", iv: partIv(mime, dataParts + 1),
    additionalData: metadata(mime, context, dataParts + 1, plainBytes), tagLength: 128
  }, key, finalTag);
  return new Blob(decoded, { type: parsed.mimeType });
}
