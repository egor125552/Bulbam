import { readFileSync } from "node:fs";
import vm from "node:vm";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, test } from "vitest";
import {
  CallRoom,
  RING_PUSH_INTERVAL_MS,
  RING_PUSH_MAX_PULSES
} from "../worker/src/modules/calls/infrastructure/call-room.ts";
import { callPushTopic } from "../worker/src/modules/notifications/application/push-notification-service.ts";

function createServiceWorkerHarness({ visibleClients = [] } = {}) {
  const listeners = {};
  const activeNotifications = [];
  const closedNotifications = [];
  const shownHistory = [];
  const openedUrls = [];

  const self = {
    addEventListener(type, fn) {
      listeners[type] = fn;
    },
    skipWaiting() {},
    clients: {
      matchAll: async () => visibleClients,
      claim: async () => {},
      openWindow: async (url) => { openedUrls.push(url); }
    },
    registration: {
      async getNotifications() {
        return [...activeNotifications];
      },
      async showNotification(title, options = {}) {
        // Simulate OS-level tag replacement alongside explicit notification.close()
        const record = {
          title,
          ...options,
          close() {
            const index = activeNotifications.indexOf(record);
            if (index !== -1) activeNotifications.splice(index, 1);
            closedNotifications.push(record);
          }
        };
        if (options.tag) {
          for (let i = activeNotifications.length - 1; i >= 0; i -= 1) {
            if (activeNotifications[i].tag === options.tag) {
              activeNotifications.splice(i, 1);
            }
          }
        }
        activeNotifications.push(record);
        shownHistory.push(record);
      }
    },
    location: { origin: "https://bulbam.example" }
  };

  const ctx = { self, indexedDB: new IDBFactory(), Promise, URL, console, Date, Number, Set };
  vm.runInNewContext(readFileSync(new URL("../web/sw.js", import.meta.url), "utf8"), ctx);

  async function dispatch(type, props) {
    let settled = Promise.resolve();
    const event = {
      ...props,
      waitUntil(promise) {
        settled = Promise.resolve(promise);
      }
    };
    listeners[type](event);
    await settled;
  }

  return { dispatch, activeNotifications, closedNotifications, shownHistory, openedUrls };
}

function createFakeStorage() {
  const data = new Map();
  let alarmAt = null;
  return {
    get alarmAt() { return alarmAt; },
    async get(key) { return data.get(key); },
    async put(keyOrEntries, value) {
      if (typeof keyOrEntries === "string") {
        data.set(keyOrEntries, value);
        return;
      }
      for (const [key, entry] of Object.entries(keyOrEntries)) {
        data.set(key, entry);
      }
    },
    async delete(key) { return data.delete(key); },
    async deleteAll() { data.clear(); alarmAt = null; },
    async setAlarm(time) { alarmAt = typeof time === "number" ? time : time.getTime(); },
    async deleteAlarm() { alarmAt = null; }
  };
}

describe("incoming call push notifications do not accumulate", () => {
  test("Service Worker clears previous call notifications and keeps only one active alert across repeated and concurrent pulses", async () => {
    const sw = createServiceWorkerHarness();
    const callId = "11111111-2222-4333-8444-555555555555";
    const chatId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

    // An unrelated chat message notification must remain untouched.
    await sw.dispatch("push", {
      data: {
        json: () => ({
          kind: "message",
          title: "Ольга",
          body: "Привет!",
          tag: `chat-${chatId}`,
          data: { url: `/?chat=${chatId}`, conversationId: chatId }
        })
      }
    });

    // Simulate 5 repeating incoming call pulses, including legacy per-pulse tags and concurrent delivery.
    const pulses = [1, 2, 3, 4, 5].map((sequence) =>
      sw.dispatch("push", {
        data: {
          json: () => ({
            kind: "call",
            title: "Входящий звонок — Егор",
            body: "Нажмите, чтобы открыть Бульбам и ответить.",
            tag: `call-${callId}-${sequence}`,
            sequence,
            data: { url: `/?chat=${chatId}&call=${callId}`, callId, conversationId: chatId }
          })
        }
      })
    );
    await Promise.all(pulses);

    const callAlerts = sw.activeNotifications.filter((n) => n.data?.kind === "call");
    const chatAlerts = sw.activeNotifications.filter((n) => n.tag === `chat-${chatId}`);
    expect(callAlerts).toHaveLength(1);
    expect(chatAlerts).toHaveLength(1);
    expect(callAlerts[0].tag).toBe(`call-${callId}`);
    expect(callAlerts[0].renotify).toBe(true);
    expect(callAlerts[0].requireInteraction).toBe(true);
    expect(sw.closedNotifications.length).toBeGreaterThanOrEqual(4);
  });

  test("call-ended replaces active ringing banner with one localized missed call and blocks late ring pulses", async () => {
    const sw = createServiceWorkerHarness();
    const callId = "22222222-3333-4444-8555-666666666666";
    const chatId = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";

    await sw.dispatch("message", { data: { type: "bulbam.locale", locale: "be" } });
    await sw.dispatch("push", {
      data: {
        json: () => ({
          kind: "call",
          title: "Входящий звонок — Егор",
          body: "Нажмите, чтобы открыть Бульбам и ответить.",
          tag: `call-${callId}`,
          data: { url: `/?chat=${chatId}&call=${callId}`, callId, conversationId: chatId }
        })
      }
    });
    expect(sw.activeNotifications).toHaveLength(1);

    await sw.dispatch("push", {
      data: {
        json: () => ({
          kind: "call-ended",
          title: "Пропущенный звонок — Егор",
          body: "Звонок завершён.",
          tag: `call-${callId}`,
          data: { url: `/?chat=${chatId}`, callId, conversationId: chatId, reason: "missed" }
        })
      }
    });

    expect(sw.activeNotifications).toHaveLength(1);
    expect(sw.activeNotifications[0].title).toBe("Прапушчаны званок — Егор");
    expect(sw.activeNotifications[0].body).toBe("Званок завершаны.");
    expect(sw.activeNotifications[0].renotify).toBe(false);

    // Late out-of-order ring pulse must NOT resurrect an active ringing banner,
    // while still calling showNotification silently for iOS userVisibleOnly safety.
    await sw.dispatch("push", {
      data: {
        json: () => ({
          kind: "call",
          title: "Входящий звонок — Егор",
          body: "Нажмите, чтобы открыть Бульбам и ответить.",
          tag: `call-${callId}`,
          data: { url: `/?chat=${chatId}&call=${callId}`, callId, conversationId: chatId }
        })
      }
    });

    expect(sw.activeNotifications).toHaveLength(1);
    expect(sw.activeNotifications[0].data.kind).toBe("call-ended");
    expect(sw.activeNotifications[0].silent).toBe(true);
    expect(sw.activeNotifications[0].renotify).toBe(false);
  });

  test("bulbam.call-clear message and visible window clear leftover call notifications", async () => {
    const callId = "33333333-4444-4555-8666-777777777777";
    const sw = createServiceWorkerHarness();
    await sw.dispatch("push", {
      data: {
        json: () => ({
          kind: "call",
          title: "Входящий звонок — Анна",
          body: "Нажмите, чтобы открыть Бульбам и ответить.",
          tag: `call-${callId}`,
          data: { url: "/", callId }
        })
      }
    });
    expect(sw.activeNotifications).toHaveLength(1);

    await sw.dispatch("message", { data: { type: "bulbam.call-clear", callId } });
    expect(sw.activeNotifications).toHaveLength(0);
  });

  test("callPushTopic produces RFC 8030 valid topic <= 32 URL-safe chars", () => {
    const topic = callPushTopic("11111111-2222-4333-8444-555555555555");
    expect(topic.length).toBeLessThanOrEqual(32);
    expect(topic).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(topic).toBe(callPushTopic("11111111-2222-4333-8444-555555555555"));
  });

  test("CallRoom alarm repeats ring pushes every 2s, caps at window, and stops cleanly on answer or missed cancel", async () => {
    const storage = createFakeStorage();
    const sentIncoming = [];
    const sentEnded = [];
    const notifications = {
      isConfigured: () => true,
      async notifyIncomingCall(input) { sentIncoming.push(input); },
      async notifyCallEnded(input) { sentEnded.push(input); }
    };
    const room = new CallRoom({ storage, acceptWebSocket() {}, getWebSockets: () => [] }, {}, notifications);

    const callId = "44444444-5555-4666-8777-888888888888";
    const conversationId = "99999999-aaaa-4bbb-8ccc-dddddddddddd";
    const startRes = await room.fetch(new Request("https://call-room.internal/start", {
      method: "POST",
      body: JSON.stringify({
        call: {
          callId,
          conversationId,
          callerUserId: "user-a",
          calleeUserId: "user-b",
          caller: { userId: "user-a", username: "alpha", displayName: "Альфа" },
          callee: { userId: "user-b", username: "beta", displayName: "Бета" },
          createdAt: Date.now()
        }
      })
    }));
    expect(startRes.status).toBe(200);
    expect(storage.alarmAt).not.toBeNull();
    expect(storage.alarmAt).toBeGreaterThanOrEqual(Date.now() + RING_PUSH_INTERVAL_MS - 50);

    // Fire 2 repeating alarms while ringing.
    await room.alarm();
    await room.alarm();
    expect(sentIncoming).toHaveLength(2);
    expect(sentIncoming[0].sequence).toBe(2);
    expect(sentIncoming[1].sequence).toBe(3);

    // Caller cancels while still ringing -> stops alarm and sends ONE missed call replacement push.
    const endRes = await room.fetch(new Request("https://call-room.internal/transition", {
      method: "POST",
      body: JSON.stringify({ callId, actorUserId: "user-a", action: "end" })
    }));
    expect(endRes.status).toBe(200);
    expect(storage.alarmAt).toBeNull();
    expect(sentEnded).toHaveLength(1);
    expect(sentEnded[0]).toMatchObject({ callId, recipientUserId: "user-b", reason: "missed" });

    // A stray alarm firing after end must send nothing.
    await room.alarm();
    expect(sentIncoming).toHaveLength(2);

    // Start a second call and verify max pulse cap stops alarm automatically.
    const callId2 = "55555555-6666-4777-8888-999999999999";
    await room.fetch(new Request("https://call-room.internal/start", {
      method: "POST",
      body: JSON.stringify({
        call: {
          callId: callId2,
          conversationId,
          callerUserId: "user-a",
          calleeUserId: "user-b",
          caller: { userId: "user-a", username: "alpha", displayName: "Альфа" },
          callee: { userId: "user-b", username: "beta", displayName: "Бета" },
          createdAt: Date.now()
        }
      })
    }));
    for (let i = 0; i < RING_PUSH_MAX_PULSES + 5; i += 1) {
      if (storage.alarmAt === null) break;
      await room.alarm();
    }
    expect(storage.alarmAt).toBeNull();
    // Initial pulse was #1 (sent by CallService), alarm sends pulses #2..RING_PUSH_MAX_PULSES.
    const call2Pulses = sentIncoming.filter((item) => item.callId === callId2);
    expect(call2Pulses.length).toBeLessThanOrEqual(RING_PUSH_MAX_PULSES - 1);
  });
});
