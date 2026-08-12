const CONNECT_TIMEOUT_MS = 10_000;
const ACK_TIMEOUT_MS = 15_000;
const MAX_SEND_ATTEMPTS = 3;
const NON_RETRYABLE_CODES = new Set([
  "voice_storage_full",
  "voice_part_conflict",
  "voice_part_after_tail",
  "voice_tail_conflict",
  "voice_tail_not_last",
  "invalid_voice_part",
  "voice_part_too_large",
  "voice_upload_completed",
  "voice_upload_not_found"
]);

export class VoiceUploadSocket {
  constructor(conversationId, sessionId) {
    this.conversationId = conversationId;
    this.sessionId = sessionId;
    this.socket = null;
    this.connecting = null;
    this.receivedParts = new Set();
    this.chunkSizeBytes = null;
    this.waiters = new Map();
  }

  async connect() {
    if (this.socket?.readyState === WebSocket.OPEN) return this;
    if (this.connecting) return this.connecting;
    this.connecting = this.open().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  async sendPart(partNumber, blob) {
    const payload = new Uint8Array(await blob.arrayBuffer());
    if (!payload.byteLength) throw new Error("часть голосового сообщения пустая");

    let lastError = null;
    for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt += 1) {
      try {
        await this.connect();
        if (this.receivedParts.has(partNumber)) {
          return { partNumber, duplicate: true, sizeBytes: payload.byteLength };
        }
        if (this.chunkSizeBytes && payload.byteLength > this.chunkSizeBytes) {
          throw codedError("voice_part_too_large", "часть голосового сообщения больше разрешённого размера");
        }
        return await this.sendPayload(partNumber, payload);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (NON_RETRYABLE_CODES.has(lastError.code) || attempt >= MAX_SEND_ATTEMPTS) throw lastError;
        this.dropConnection();
      }
    }
    throw lastError ?? new Error("Не удалось отправить часть голосового сообщения");
  }

  async sendPayload(partNumber, payload) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket голосового сообщения не подключён");
    }

    const frame = new Uint8Array(payload.byteLength + 4);
    new DataView(frame.buffer).setUint32(0, partNumber, false);
    frame.set(payload, 4);

    const ack = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(partNumber);
        reject(new Error(`сервер не подтвердил часть ${partNumber}`));
      }, ACK_TIMEOUT_MS);
      this.waiters.set(partNumber, { resolve, reject, timer });
    });

    try {
      this.socket.send(frame.buffer);
    } catch (error) {
      this.rejectWaiter(partNumber, error);
      throw error;
    }
    return ack;
  }

  close() {
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, "voice upload complete");
    this.rejectAll(new Error("WebSocket голосового сообщения закрыт"));
  }

  dropConnection() {
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState < WebSocket.CLOSING) {
      try { socket.close(); } catch {}
    }
    this.rejectAll(new Error("WebSocket голосового сообщения переподключается"));
  }

  async open() {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const path = `/api/v1/chats/${encodeURIComponent(this.conversationId)}/voice/uploads/${encodeURIComponent(this.sessionId)}/socket`;
    const socket = new WebSocket(`${protocol}//${location.host}${path}`);
    socket.binaryType = "arraybuffer";
    this.socket = socket;

    return new Promise((resolve, reject) => {
      let ready = false;
      const timeout = setTimeout(() => {
        if (ready) return;
        if (this.socket === socket) this.socket = null;
        reject(new Error("сервер не открыл WebSocket голосового сообщения"));
        try { socket.close(); } catch {}
      }, CONNECT_TIMEOUT_MS);

      socket.addEventListener("message", (event) => {
        if (typeof event.data !== "string") return;
        let message;
        try { message = JSON.parse(event.data); }
        catch { return; }

        if (message.type === "voice.upload.ready") {
          ready = true;
          clearTimeout(timeout);
          this.chunkSizeBytes = Number(message.chunkSizeBytes) || null;
          this.receivedParts = new Set(
            Array.isArray(message.receivedParts)
              ? message.receivedParts.filter((part) => Number.isInteger(part) && part > 0)
              : []
          );
          resolve(this);
          return;
        }

        if (message.type === "voice.upload.ack") {
          const partNumber = Number(message.partNumber);
          this.receivedParts.add(partNumber);
          const waiter = this.waiters.get(partNumber);
          if (!waiter) return;
          clearTimeout(waiter.timer);
          this.waiters.delete(partNumber);
          waiter.resolve({
            partNumber,
            duplicate: Boolean(message.duplicate),
            sizeBytes: Number(message.sizeBytes) || 0
          });
          return;
        }

        if (message.type === "voice.upload.error") {
          const code = typeof message.code === "string" ? message.code : "voice_upload_failed";
          const rawMessage = typeof message.message === "string" ? message.message : "Ошибка WebSocket-загрузки голосового";
          const text = rawMessage.includes("SQLITE_FULL")
            ? "Бесплатное серверное хранилище голосовых заполнено. Запись сохранена на устройстве и не потеряна."
            : rawMessage;
          const error = codedError(rawMessage.includes("SQLITE_FULL") ? "voice_storage_full" : code, text);
          const partNumber = Number(message.partNumber);
          if (Number.isInteger(partNumber) && this.waiters.has(partNumber)) this.rejectWaiter(partNumber, error);
          else this.rejectAll(error);
        }
      });

      socket.addEventListener("close", () => {
        clearTimeout(timeout);
        const wasCurrent = this.socket === socket;
        if (wasCurrent) {
          this.socket = null;
          this.rejectAll(new Error("WebSocket голосового сообщения отключился"));
        }
        if (!ready) reject(new Error("WebSocket голосового сообщения не открылся"));
      });
      socket.addEventListener("error", () => {
        if (!ready) reject(new Error("Ошибка подключения WebSocket голосового сообщения"));
      });
    });
  }

  rejectWaiter(partNumber, error) {
    const waiter = this.waiters.get(partNumber);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    this.waiters.delete(partNumber);
    waiter.reject(error instanceof Error ? error : new Error(String(error)));
  }

  rejectAll(error) {
    for (const [partNumber] of this.waiters) this.rejectWaiter(partNumber, error);
  }
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
