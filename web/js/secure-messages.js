// Experimental, opt-in text protection with Web Crypto AES-256-GCM.
// It is not Signal, a ratcheting protocol, or authenticated multi-device E2EE.
// The random shared secret MUST be exchanged outside Bulbam over a trusted channel.
export const SECURE_PREFIX = "bmsec1:";
const DATABASE = "bulbam-protected-text-v1";
const STORE = "chat-keys";
const ENCRYPTION_CONTEXT = "bulbam.experimental-text.v1";
const MAX_WIRE_LENGTH = 4000;

function encodeBase64Url(bytes) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(raw, expectedBytes = null) {
  if (typeof raw !== "string" || !/^[A-Za-z0-9_-]+$/.test(raw)) {
    throw new Error("Некорректный формат секретного ключа или сообщения.");
  }
  const base64 = raw.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - base64.length % 4) % 4);
  let bytes;
  try {
    bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  } catch {
    throw new Error("Повреждённые данные.");
  }
  if (expectedBytes !== null && bytes.length !== expectedBytes) {
    throw new Error("Некорректная длина секретного ключа или сообщения.");
  }
  if (encodeBase64Url(bytes) !== raw) throw new Error("Некорректная запись данных.");
  return bytes;
}

function getCrypto() {
  if (!globalThis.crypto?.subtle || !globalThis.crypto?.getRandomValues) {
    throw new Error("Защищённый режим недоступен в этом браузере.");
  }
  return globalThis.crypto;
}

function authenticatedContext(context) {
  if (!context || ["conversationId", "senderUserId", "clientMessageId"].some((field) =>
    typeof context[field] !== "string" || context[field].length < 1 || context[field].length > 120
  )) {
    throw new Error("Не хватает данных для защищённого сообщения.");
  }
  return new TextEncoder().encode(JSON.stringify([
    ENCRYPTION_CONTEXT, context.conversationId, context.senderUserId, context.clientMessageId
  ]));
}

export function generateConversationSecret() {
  const secret = new Uint8Array(32);
  getCrypto().getRandomValues(secret);
  return encodeBase64Url(secret);
}

export async function importConversationSecret(secret) {
  const bytes = decodeBase64Url(String(secret || "").trim(), 32);
  return getCrypto().subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export function isEncryptedText(value) {
  return typeof value === "string" && value.startsWith(SECURE_PREFIX);
}

export async function encryptText(plaintext, key, context) {
  if (typeof plaintext !== "string" || !plaintext.trim()) {
    throw new Error("Нельзя зашифровать пустое сообщение.");
  }
  const crypto = getCrypto();
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const encrypted = await crypto.subtle.encrypt({
    name: "AES-GCM", iv, additionalData: authenticatedContext(context), tagLength: 128
  }, key, new TextEncoder().encode(plaintext));
  const wire = SECURE_PREFIX + encodeBase64Url(iv) + "." + encodeBase64Url(new Uint8Array(encrypted));
  if (wire.length > MAX_WIRE_LENGTH) {
    throw new Error("Для защищённого сообщения текст слишком длинный. Отправьте его частями.");
  }
  return wire;
}

export async function decryptText(wire, key, context) {
  if (!isEncryptedText(wire) || wire.length > MAX_WIRE_LENGTH) {
    throw new Error("Это не защищённое сообщение Бульбама.");
  }
  const parts = wire.slice(SECURE_PREFIX.length).split(".");
  if (parts.length !== 2) throw new Error("Повреждённое защищённое сообщение.");
  const iv = decodeBase64Url(parts[0], 12);
  const cipher = decodeBase64Url(parts[1]);
  if (cipher.length < 17) throw new Error("Повреждённое защищённое сообщение.");
  const decrypted = await getCrypto().subtle.decrypt({
    name: "AES-GCM", iv, additionalData: authenticatedContext(context), tagLength: 128
  }, key, cipher);
  return new TextDecoder("utf-8", { fatal: true }).decode(decrypted);
}

function keyId(accountId, conversationId) {
  if (typeof accountId !== "string" || !accountId || typeof conversationId !== "string" || !conversationId) {
    throw new Error("Для ключа нужен аккаунт и конкретная переписка.");
  }
  return JSON.stringify([accountId, conversationId]);
}

async function openDatabase() {
  if (!globalThis.indexedDB) throw new Error("Браузер не разрешает хранить секретные ключи.");
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Не удалось открыть ключи."));
    request.onblocked = () => reject(new Error("Хранилище ключей занято другой вкладкой."));
  });
}

export async function loadConversationKey(accountId, conversationId) {
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const request = tx.objectStore(STORE).get(keyId(accountId, conversationId));
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error ?? new Error("Ключ недоступен."));
    });
  } finally {
    db.close();
  }
}

export async function saveConversationKey(accountId, conversationId, secret) {
  const key = await importConversationSecret(secret);
  const db = await openDatabase();
  try {
    // Do not silently overwrite the only key able to read previous messages.
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      const id = keyId(accountId, conversationId);
      const request = store.add(key, id);
      request.onerror = () => reject(new Error("Ключ уже существует или недоступен. Заменять его без восстановления истории нельзя."));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("Не удалось сохранить ключ."));
      tx.onabort = () => reject(tx.error ?? new Error("Не удалось сохранить ключ."));
    });
    return key;
  } finally {
    db.close();
  }
}
