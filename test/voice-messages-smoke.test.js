import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { createTestHarness } from "wrangler";

const PASSWORD = "Bulbam-Voice-Smoke-2026!";
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

async function seedInvite(code, inviteId) {
  const ready = await server.fetch("/api/ready");
  await expectStatus(ready, 200);
  const worker = server.getWorker("bulbam-api-test");
  const env = await worker.getEnv();
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

async function uploadVoice(sender, chat, bytes, durationMs = 42_000) {
  const start = await api(`/api/v1/chats/${chat.conversationId}/voice/uploads`, sender.cookie, {
    method: "POST",
    body: JSON.stringify({ mimeType: "audio/webm;codecs=opus", bitrateBps: 64_000 })
  });
  await expectStatus(start, 201);
  const upload = (await json(start)).upload;

  const partResponse = await server.fetch(
    `/api/v1/chats/${chat.conversationId}/voice/uploads/${upload.sessionId}/parts/1?uploadId=${encodeURIComponent(upload.uploadId)}`,
    {
      method: "PUT",
      headers: {
        cookie: sender.cookie,
        accept: "application/json",
        "content-type": "application/octet-stream"
      },
      body: bytes
    }
  );
  await expectStatus(partResponse, 200);
  const part = (await json(partResponse)).part;

  const completeBody = {
    uploadId: upload.uploadId,
    clientMessageId: `voice_smoke_${crypto.randomUUID().replaceAll("-", "")}`,
    durationMs,
    mimeType: "audio/webm;codecs=opus",
    bitrateBps: 64_000,
    parts: [part]
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
  test("stores Opus in R2, streams it, resumes listening, and respects privacy", async () => {
    const inviteA = "BULBAM-VOICE-SMOKE-ALPHA-2026";
    const inviteB = "BULBAM-VOICE-SMOKE-BETA-2026";
    await seedInvite(inviteA, "voice-smoke-alpha-invite");
    await seedInvite(inviteB, "voice-smoke-beta-invite");

    const alpha = await register({ username: "voice_alpha", displayName: "Егор Голос", inviteCode: inviteA });
    const beta = await register({ username: "voice_beta", displayName: "Маша Голос", inviteCode: inviteB });
    const chat = await openChat(alpha, beta);
    const bytes = new Uint8Array([26, 69, 223, 163, 66, 134, 129, 1, 255, 127, 3, 9]);

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

    const ranged = await api(
      `/api/v1/chats/${chat.conversationId}/messages/${uploaded.payload.message.messageId}/voice/audio`,
      beta.cookie,
      { headers: { accept: "audio/webm", range: "bytes=2-5" } }
    );
    await expectStatus(ranged, 206);
    expect(new Uint8Array(await ranged.arrayBuffer())).toEqual(bytes.slice(2, 6));

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
