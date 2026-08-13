import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { VoiceUploadSocket } from "../web/js/voice-upload-socket.js";

const originalWebSocket = globalThis.WebSocket;
const originalLocation = globalThis.location;

beforeEach(() => {
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { protocol: "https:", host: "bulbam.test" }
  });
});

afterEach(() => {
  vi.useRealTimers();
  if (originalWebSocket === undefined) delete globalThis.WebSocket;
  else globalThis.WebSocket = originalWebSocket;
  if (originalLocation === undefined) delete globalThis.location;
  else Object.defineProperty(globalThis, "location", { configurable: true, value: originalLocation });
});

describe("VoiceUploadSocket", () => {
  test("reconnects after a lost ACK and accepts the server persisted-part list", async () => {
    let created = 0;
    class ReconnectWebSocket extends FakeWebSocket {
      constructor(url) {
        super(url);
        created += 1;
        const connectionNumber = created;
        queueMicrotask(() => {
          this.readyState = ReconnectWebSocket.OPEN;
          this.emit("message", {
            data: JSON.stringify({
              type: "voice.upload.ready",
              sessionId: "session-1",
              chunkSizeBytes: 256 * 1024,
              receivedParts: connectionNumber === 1 ? [] : [1]
            })
          });
        });
      }

      send(value) {
        super.send(value);
        if (created === 1) {
          queueMicrotask(() => {
            this.readyState = ReconnectWebSocket.CLOSED;
            this.emit("close", {});
          });
        }
      }
    }
    globalThis.WebSocket = ReconnectWebSocket;

    const upload = new VoiceUploadSocket("conversation-1", "session-1");
    const result = await upload.sendPart(1, new Blob([new Uint8Array([1, 2, 3, 4])]));

    expect(result).toEqual({ partNumber: 1, duplicate: true, sizeBytes: 4 });
    expect(created).toBe(2);
    expect(ReconnectWebSocket.instances[0].sent).toHaveLength(1);
    expect(ReconnectWebSocket.instances[1].sent).toHaveLength(0);
    upload.close();
  });

  test("treats SQLITE_FULL as non-retryable and preserves a useful user-facing error", async () => {
    let created = 0;
    class FullWebSocket extends FakeWebSocket {
      constructor(url) {
        super(url);
        created += 1;
        queueMicrotask(() => {
          this.readyState = FullWebSocket.OPEN;
          this.emit("message", {
            data: JSON.stringify({
              type: "voice.upload.ready",
              sessionId: "session-full",
              chunkSizeBytes: 256 * 1024,
              receivedParts: []
            })
          });
        });
      }

      send(value) {
        super.send(value);
        const partNumber = new DataView(value).getUint32(0, false);
        queueMicrotask(() => {
          this.emit("message", {
            data: JSON.stringify({
              type: "voice.upload.error",
              code: "voice_upload_failed",
              partNumber,
              message: "database or disk is full: SQLITE_FULL"
            })
          });
        });
      }
    }
    globalThis.WebSocket = FullWebSocket;

    const upload = new VoiceUploadSocket("conversation-full", "session-full");
    await expect(upload.sendPart(1, new Blob([new Uint8Array([9, 8, 7])]))).rejects.toMatchObject({
      code: "voice_storage_full",
      message: "Бесплатное серверное хранилище голосовых заполнено. Запись сохранена на устройстве и не потеряна."
    });
    expect(created).toBe(1);
    upload.close();
  });
});

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.binaryType = "blob";
    this.sent = [];
    this.listeners = new Map();
    this.constructor.instances ??= [];
    this.constructor.instances.push(this);
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  send(value) {
    if (this.readyState !== this.constructor.OPEN) throw new Error("socket not open");
    this.sent.push(value);
  }

  close() {
    if (this.readyState >= this.constructor.CLOSING) return;
    this.readyState = this.constructor.CLOSING;
    queueMicrotask(() => {
      this.readyState = this.constructor.CLOSED;
      this.emit("close", {});
    });
  }

  emit(type, event) {
    for (const listener of this.listeners.get(type) ?? []) listener.call(this, event);
  }
}
