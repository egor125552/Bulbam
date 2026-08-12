import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { createTestHarness } from "wrangler";

const PASSWORD = "Bulbam-Voice-Smoke-2026!";
const CHUNK_SIZE = 256 * 1024;
const server = createTestHarness({
  workers: [{ configPath: "./wrangler.test.jsonc" }]
});

beforeAll(async () => {
  await server.listen();
});

afterEach(async () => {
  await server.reset();
});

afterAll(async () => {
  await server.close();
});

async function json(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Expected JSON, got HTTP ${response.status}: ${text}`);
  }
}

async function expectStatus(response, expected) {
  if (response.status !== expected) {
    throw new Error(`Expected HTTP ${expected}, got ${response.status}: ${await response.clone().text()}`);
  }
}

function sessionCookie(response) {
  const setCookie = response.headers.get("set-cookie") ?? "";
  const match = setCookie.match(/(?:^|,\s*)bulbam_session=([^;]+)/);
  if (!match) throw new Error(`No bulbam_session cookie: ${setCookie}`);
  return `bulbam_session=${match[1]}`;
}

async function testEnv() {
  const worker = server.getWorker("bulbam-api-test");
  return worker.getEnv();
}

async function seedInvite(code, inviteId) {
  const ready = await server.fetch("/api/ready");
  await expectStatus(ready, 200);
  const env = await testEnv();
  const hash = createHash("sha256").update(code).digest("hex");
  await env.DB
    .prepare(`
      INSERT INTO invites (
        invite_id, code_hash, created_by_user_id, role_grant,
        created_at, expires_at, used_at, used_by_user_id
      ) VALUES (?, ?, NULL, 'member', ?, NULL, NULL, NULL)
    `)
    .bind(inviteId, hash, Date.now())
    .run();
}

async function register({ username, displayName, inviteCode }) {
  const response = await server.fetch("/api/v1/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, displayName, password: PASSWORD, inviteCode, deviceName: "Voice smoke" })
  });
  await expectStatus(response, 201);
  const payload = await json(response.clone());
  return { account: payload.account, cookie: sessionCookie(response) };
}

async function api(path, cookie, options = {}) {
  return server.fetch(path, {
    ...options,
    headers: {
      accept: "application/json",
      ...(options.body ? { "content-type": "application/json" } : {}),
      cookie,
      ...(options.headers ?? {})
    }
  });
}

async function openChat(alpha, beta) {
  const response = await api("/api/v1/chats/direct", alpha.cookie, {
    method: "POST",
    body: JSON.stringify({ userId: beta.account.userId })
  });
  await expectStatus(response, 200);
  return (await json(response)).chat;
}

function nextJsonMessage(socket, type) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.removeEventListener("message", onMessage);
      reject(new Error(`Timed out waiting for ${type}`));
    }, 5_000);
    const onMessage = (event) => {
      if (typeof event.data !== "string") return;
      let payload;
      try { payload = JSON.parse(event.data); }
      catch { return; }
      if (payload.type !== type) return;
      clearTimeout(timeout);
      socket.removeEventListener("message", onMessage);
      resolve(payload);
    };
    socket.addEventListener("message", onMessage);
  });
}

async function openVoiceUploadSocket(sender, chat, upload) {
  const env = await testEnv();
  const response = await env.VOICE_UPLOAD.getByName(upload.sessionId).fetch(
    "https://voice-upload.internal/socket",
    {
      headers: {
        Upgrade: "websocket",
        "x-bulbam-user-id": sender.account.userId,
        "x-bulbam-conversation-id": chat.conversationId,
        "x-bulbam-voice-session-id": upload.sessionId
      }
    }
  );
  await expectStatus(response, 101);
  const socket = response.webSocket;
  if (!socket) throw new Error("Expected voice upload WebSocket");
  const ready = nextJsonMessage(socket, "voice.upload.ready");
  socket.accept();
  return { socket, ready: await ready };
}

function frame(partNumber, bytes) {
  const value = new Uint8Array(bytes.byteLength + 4);
  new DataView(value.buffer).setUint32(0, partNumber, false);
  value.set(bytes, 4);
  return value.buffer;
}

async function sendVoicePart(socket, partNumber, bytes) {
  const ack = nextJsonMessage(socket, "voice.upload.ack");
  socket.send(frame(partNumber, bytes));
  const payload = await ack;
  expect(payload.partNumber).toBe(partNumber);
  expect(payload.sizeBytes).toBe(bytes.byteLength);
  return payload;
}

async function expectVoicePartError(socket, partNumber, bytes, code) {
  const error = nextJsonMessage(socket, "voice.upload.error");
  socket.send(frame(partNumber, bytes));
  const payload = await error;
  expect(payload.partNumber).toBe(partNumber);
  expect(payload.code).toBe(code);
  return payload;
}

async function startVoice(sender, chat) {
  const response = await api(`/api/v1/chats/${chat.conversationId}/voice/uploads`, sender.cookie, {
    method: "POST",
    body: JSON.stringify({ mimeType: "audio/webm;codecs=opus", bitrateBps: 64_000 })
  });
  await expectStatus(response, 201);
  const upload = (await json(response)).upload;
  expect(upload.transport).toBe("websocket");
  expect(upload.chunkSizeBytes).toBe(CHUNK_SIZE);
  expect(upload.state).toBe("uploading");
  return upload;
}

async function uploadVoice(sender, chat, bytes, durationMs = 42_000) {
  const upload = await startVoice(sender, chat);
  const firstBytes = bytes.slice(0, CHUNK_SIZE);
  const secondBytes = bytes.slice(CHUNK_SIZE);

  const firstConnection = await openVoiceUploadSocket(sender, chat, upload);
  expect(firstConnection.ready.receivedParts).toEqual([]);
  await sendVoicePart(firstConnection.socket, 1, firstBytes);

  const statusAfterFirst = await api(
    `/api/v1/chats/${chat.conversationId}/voice/uploads/${upload.sessionId}`,
    sender.cookie
  );
  await expectStatus(statusAfterFirst, 200);
  expect((await json(statusAfterFirst)).upload).toMatchObject({
    state: "uploading",
    receivedParts: [1],
    sizeBytes: CHUNK_SIZE
  });
  firstConnection.socket.close(1000, "test reconnect");

  const secondConnection = await openVoiceUploadSocket(sender, chat, upload);
  expect(secondConnection.ready.receivedParts).toEqual([1]);
  await sendVoicePart(secondConnection.socket, 2, secondBytes);
  secondConnection.socket.close(1000, "upload complete");

  const completeBody = {
    clientMessageId: `voice_smoke_${crypto.randomUUID().replaceAll("-", "")}`,
    durationMs,
    chunkCount: 2,
    sizeBytes: bytes.byteLength
  };
  const complete = await api(
    `/api/v1/chats/${chat.conversationId}/voice/uploads/${upload.sessionId}/complete`,
    sender.cookie,
    { method: "POST", body: JSON.stringify(completeBody) }
  );
  await expectStatus(complete, 201);
  return { upload, completeBody, payload: await json(complete) };
}

describe("voice messages foundation", () => {
  test("persists resumable WebSocket chunks in Durable Objects, streams ranges, and respects listening privacy", async () => {
    const inviteA = "BULBAM-VOICE-SMOKE-ALPHA-2026";
    const inviteB = "BULBAM-VOICE-SMOKE-BETA-2026";
    await seedInvite(inviteA, "voice-smoke-alpha-invite");
    await seedInvite(inviteB, "voice-smoke-beta-invite");

    const alpha = await register({ username: "voice_alpha", displayName: "Егор Голос", inviteCode: inviteA });
    const beta = await register({ username: "voice_beta", displayName: "Маша Голос", inviteCode: inviteB });
    const chat = await openChat(alpha, beta);

    const bytes = new Uint8Array(CHUNK_SIZE + 32);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251;

    const foreignUpload = await startVoice(alpha, chat);
    const betaCannotOwnSocket = await api(
      `/api/v1/chats/${chat.conversationId}/voice/uploads/${foreignUpload.sessionId}/socket`,
      beta.cookie
    );
    await expectStatus(betaCannotOwnSocket, 404);
    await api(`/api/v1/chats/${chat.conversationId}/voice/uploads/${foreignUpload.sessionId}`, alpha.cookie, { method: "DELETE" });
    const deletedStatus = await api(`/api/v1/chats/${chat.conversationId}/voice/uploads/${foreignUpload.sessionId}`, alpha.cookie);
    await expectStatus(deletedStatus, 404);

    const conflictUpload = await startVoice(alpha, chat);
    const conflictConnection = await openVoiceUploadSocket(alpha, chat, conflictUpload);
    const original = new Uint8Array(CHUNK_SIZE);
    original.fill(7);
    await sendVoicePart(conflictConnection.socket, 1, original);
    const changed = original.slice();
    changed[changed.length - 1] = 8;
    await expectVoicePartError(conflictConnection.socket, 1, changed, "voice_part_conflict");
    conflictConnection.socket.close(1000, "conflict test complete");
    await api(`/api/v1/chats/${chat.conversationId}/voice/uploads/${conflictUpload.sessionId}`, alpha.cookie, { method: "DELETE" });

    const tailUpload = await startVoice(alpha, chat);
    const tailConnection = await openVoiceUploadSocket(alpha, chat, tailUpload);
    await sendVoicePart(tailConnection.socket, 1, new Uint8Array([1, 2, 3, 4]));
    await expectVoicePartError(tailConnection.socket, 2, new Uint8Array(CHUNK_SIZE), "voice_part_after_tail");
    tailConnection.socket.close(1000, "tail test complete");
    await api(`/api/v1/chats/${chat.conversationId}/voice/uploads/${tailUpload.sessionId}`, alpha.cookie, { method: "DELETE" });

    const uploaded = await uploadVoice(alpha, chat, bytes);
    expect(uploaded.payload.message).toMatchObject({
      conversationId: chat.conversationId,
      senderUserId: alpha.account.userId,
      kind: "voice",
      text: "Голосовое сообщение",
      voice: {
        durationMs: 42_000,
        mimeType: "audio/webm;codecs=opus",
        bitrateBps: 64_000,
        sizeBytes: bytes.byteLength
      }
    });

    const statusReady = await api(
      `/api/v1/chats/${chat.conversationId}/voice/uploads/${uploaded.upload.sessionId}`,
      alpha.cookie
    );
    await expectStatus(statusReady, 200);
    expect((await json(statusReady)).upload).toMatchObject({
      state: "ready",
      receivedParts: [1, 2],
      chunkCount: 2,
      sizeBytes: bytes.byteLength
    });

    const env = await testEnv();
    const oldMediaTables = await env.DB
      .prepare("SELECT name FROM sqlite_master WHERE name IN ('voice_media_objects', 'voice_media_chunks') ORDER BY name")
      .all();
    expect(oldMediaTables.results).toEqual([]);

    const completeAgain = await api(
      `/api/v1/chats/${chat.conversationId}/voice/uploads/${uploaded.upload.sessionId}/complete`,
      alpha.cookie,
      { method: "POST", body: JSON.stringify(uploaded.completeBody) }
    );
    await expectStatus(completeAgain, 200);
    expect((await json(completeAgain)).duplicate).toBe(true);

    const audio = await api(
      `/api/v1/chats/${chat.conversationId}/messages/${uploaded.payload.message.messageId}/voice/audio`,
      beta.cookie,
      { headers: { accept: "audio/webm" } }
    );
    await expectStatus(audio, 200);
    expect(new Uint8Array(await audio.arrayBuffer())).toEqual(bytes);
    expect(audio.headers.get("accept-ranges")).toBe("bytes");

    const rangeStart = CHUNK_SIZE - 4;
    const rangeEnd = CHUNK_SIZE + 7;
    const ranged = await api(
      `/api/v1/chats/${chat.conversationId}/messages/${uploaded.payload.message.messageId}/voice/audio`,
      beta.cookie,
      { headers: { accept: "audio/webm", range: `bytes=${rangeStart}-${rangeEnd}` } }
    );
    await expectStatus(ranged, 206);
    expect(new Uint8Array(await ranged.arrayBuffer())).toEqual(bytes.slice(rangeStart, rangeEnd + 1));
    expect(ranged.headers.get("content-range")).toBe(`bytes ${rangeStart}-${rangeEnd}/${bytes.byteLength}`);

    const invalidRange = await api(
      `/api/v1/chats/${chat.conversationId}/messages/${uploaded.payload.message.messageId}/voice/audio`,
      beta.cookie,
      { headers: { range: `bytes=${bytes.byteLength + 1}-` } }
    );
    await expectStatus(invalidRange, 416);

    const firstProgress = await api(
      `/api/v1/chats/${chat.conversationId}/messages/${uploaded.payload.message.messageId}/voice/progress`,
      beta.cookie,
      {
        method: "POST",
        body: JSON.stringify({
          heardRanges: [[0, 10_000], [20_000, 25_000]],
          resumeMs: 25_000,
          completed: false,
          active: true
        })
      }
    );
    await expectStatus(firstProgress, 200);
    const firstProgressPayload = await json(firstProgress);
    expect(firstProgressPayload.progress.listenedMs).toBe(15_000);
    expect(firstProgressPayload.progress.resumeMs).toBe(25_000);
    expect(firstProgressPayload.progress.heardRanges).toEqual([[0, 10_000], [20_000, 25_000]]);

    const alphaHistory = await api(`/api/v1/chats/${chat.conversationId}/messages`, alpha.cookie);
    await expectStatus(alphaHistory, 200);
    const senderVoice = (await json(alphaHistory)).messages[0].voice;
    expect(senderVoice.progress.listenedMs).toBe(15_000);
    expect(senderVoice.progress.heardRanges).toBeUndefined();

    const privacy = await api("/api/v1/voice/settings", beta.cookie, {
      method: "PUT",
      body: JSON.stringify({ shareListening: false })
    });
    await expectStatus(privacy, 200);
    expect((await json(privacy)).shareListening).toBe(false);

    const secondProgress = await api(
      `/api/v1/chats/${chat.conversationId}/messages/${uploaded.payload.message.messageId}/voice/progress`,
      beta.cookie,
      {
        method: "POST",
        body: JSON.stringify({
          heardRanges: [[25_000, 30_000]],
          resumeMs: 30_000,
          completed: false,
          active: false
        })
      }
    );
    await expectStatus(secondProgress, 200);
    expect((await json(secondProgress)).progress.listenedMs).toBe(20_000);

    const hiddenHistory = await api(`/api/v1/chats/${chat.conversationId}/messages`, alpha.cookie);
    await expectStatus(hiddenHistory, 200);
    expect((await json(hiddenHistory)).messages[0].voice.progress).toBeNull();

    const betaHistory = await api(`/api/v1/chats/${chat.conversationId}/messages`, beta.cookie);
    await expectStatus(betaHistory, 200);
    const ownProgress = (await json(betaHistory)).messages[0].voice.progress;
    expect(ownProgress.listenedMs).toBe(20_000);
    expect(ownProgress.heardRanges).toEqual([[0, 10_000], [20_000, 30_000]]);

    const fakeSelfListen = await api(
      `/api/v1/chats/${chat.conversationId}/messages/${uploaded.payload.message.messageId}/voice/progress`,
      alpha.cookie,
      {
        method: "POST",
        body: JSON.stringify({ heardRanges: [[0, 42_000]], resumeMs: 42_000, completed: true, active: false })
      }
    );
    await expectStatus(fakeSelfListen, 404);
  });
});
