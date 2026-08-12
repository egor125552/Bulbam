const CONNECT_TIMEOUT_MS = 10_000;
const ACK_TIMEOUT_MS = 15_000;

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
    await this.connect();
    if (this.receivedParts.has(partNumber)) {
      return { partNumber, duplicate: true, sizeBytes: blob.size };
    }
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket голосового сообщения не подключён");
    }

    const payload = new Uint8Array(await blob.arrayBuffer());
    if (!payload.byteLength) throw new Error("часть голосового сообщения пустая");
    if (this.chunkSizeBytes && payload.byteLength > this.chunkSizeBytes) {
      throw new Error("часть голосового сообщения больше разрешённого размера");
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
          const error = new Error(message.message || "Ошибка WebSocket-загрузки голосового");
          const partNumber = Number(message.partNumber);
          if (Number.isInteger(partNumber) && this.waiters.has(partNumber)) this.rejectWaiter(partNumber, error);
          else this.rejectAll(error);
        }
      });

      socket.addEventListener("close", () => {
        clearTimeout(timeout);
        if (this.socket === socket) this.socket = null;
        this.rejectAll(new Error("WebSocket голосового сообщения отключился"));
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
