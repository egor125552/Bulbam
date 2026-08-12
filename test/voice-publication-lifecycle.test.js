import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { createTestHarness } from "wrangler";

const PASSWORD = "Bulbam-Voice-Lifecycle-2026!";
const server = createTestHarness({
  workers: [{ configPath: "./wrangler.test.jsonc" }]
});

beforeAll(async () => { await server.listen(); });
afterEach(async () => { await server.reset(); });
afterAll(async () => { await server.close(); });

async function expectStatus(response, expected) {
  if (response.status !== expected) {
    throw new Error(`Expected HTTP ${expected}, got ${response.status}: ${await response.clone().text()}`);
  }
}

async function json(response) {
  return response.json();
}

function sessionCookie(response) {
  const match = (response.headers.get("set-cookie") ?? "").match(/(?:^|,\s*)bulbam_session=([^;]+)/);
  if (!match) throw new Error("No bulbam_session cookie");
  return `bulbam_session=${match[1]}`;
}

async function env() {
  return server.getWorker("bulbam-api-test").getEnv();
}

async function seedInvite(code, inviteId) {
  await expectStatus(await server.fetch("/api/ready"), 200);
  const testEnv = await env();
  const hash = createHash("sha256").update(code).digest("hex");
  await testEnv.DB.prepare(`
    INSERT INTO invites (
      invite_id, code_hash, created_by_user_id, role_grant,
      created_at, expires_at, used_at, used_by_user_id
    ) VALUES (?, ?, NULL, 'member', ?, NULL, NULL, NULL)
  `).bind(inviteId, hash, Date.now()).run();
}

async function register(username, displayName, inviteCode) {
  const response = await server.fetch("/api/v1/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, displayName, password: PASSWORD, inviteCode, deviceName: "Voice lifecycle smoke" })
  });
  await expectStatus(response, 201);
  return { account: (await json(response.clone())).account, cookie: sessionCookie(response) };
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

async function startVoice(sender, chat) {
  const response = await api(`/api/v1/chats/${chat.conversationId}/voice/uploads`, sender.cookie, {
    method: "POST",
    body: JSON.stringify({ mimeType: "audio/webm;codecs=opus", bitrateBps: 64_000 })
  });
  await expectStatus(response, 201);
  return (await json(response)).upload;
}

async function storeAndPrepare(upload, sender, chat, bytes) {
  const testEnv = await env();
  const stub = testEnv.VOICE_UPLOAD.getByName(upload.sessionId);
  const headers = {
    "x-bulbam-user-id": sender.account.userId,
    "x-bulbam-conversation-id": chat.conversationId
  };

  const chunk = await stub.fetch(
    `https://voice.internal/internal/chunk?partNumber=1`,
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/octet-stream" },
      body: bytes
    }
  );
  await expectStatus(chunk, 200);

  const complete = await stub.fetch("https://voice.internal/internal/complete", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ expectedChunkCount: 1, expectedSizeBytes: bytes.byteLength })
  });
  await expectStatus(complete, 200);
}

describe("voice media publication lifecycle", () => {
  test("keeps ready media safe across delete races and preserves published media", async () => {
    const inviteA = "BULBAM-VOICE-LIFECYCLE-A-2026";
    const inviteB = "BULBAM-VOICE-LIFECYCLE-B-2026";
    await seedInvite(inviteA, "voice-lifecycle-a-invite");
    await seedInvite(inviteB, "voice-lifecycle-b-invite");
    const alpha = await register("voice_lifecycle_alpha", "Егор Lifecycle", inviteA);
    const beta = await register("voice_lifecycle_beta", "Маша Lifecycle", inviteB);

    const chatResponse = await api("/api/v1/chats/direct", alpha.cookie, {
      method: "POST",
      body: JSON.stringify({ userId: beta.account.userId })
    });
    await expectStatus(chatResponse, 200);
    const chat = (await json(chatResponse)).chat;
    const bytes = new Uint8Array([26, 69, 223, 163, 66, 134, 129, 1, 4, 8, 15, 16, 23, 42]);

    const prepared = await startVoice(alpha, chat);
    await storeAndPrepare(prepared, alpha, chat, bytes);
    const preparedStatus = await api(
      `/api/v1/chats/${chat.conversationId}/voice/uploads/${prepared.sessionId}`,
      alpha.cookie
    );
    await expectStatus(preparedStatus, 200);
    expect((await json(preparedStatus)).upload.state).toBe("ready");

    // A ready upload may already have a D1 message while the final published ACK was
    // lost, so user-side draft deletion must not erase its server bytes immediately.
    await expectStatus(await api(
      `/api/v1/chats/${chat.conversationId}/voice/uploads/${prepared.sessionId}`,
      alpha.cookie,
      { method: "DELETE" }
    ), 204);
    const stillPrepared = await api(
      `/api/v1/chats/${chat.conversationId}/voice/uploads/${prepared.sessionId}`,
      alpha.cookie
    );
    await expectStatus(stillPrepared, 200);
    expect((await json(stillPrepared)).upload.state).toBe("ready");

    const published = await startVoice(alpha, chat);
    await storeAndPrepare(published, alpha, chat, bytes);
    const publishResponse = await api(
      `/api/v1/chats/${chat.conversationId}/voice/uploads/${published.sessionId}/complete`,
      alpha.cookie,
      {
        method: "POST",
        body: JSON.stringify({
          clientMessageId: `voice_lifecycle_${crypto.randomUUID().replaceAll("-", "")}`,
          durationMs: 2_000,
          chunkCount: 1,
          sizeBytes: bytes.byteLength
        })
      }
    );
    await expectStatus(publishResponse, 201);
    const message = (await json(publishResponse)).message;
    expect(message.messageId).toBe(published.sessionId);

    await expectStatus(await api(
      `/api/v1/chats/${chat.conversationId}/voice/uploads/${published.sessionId}`,
      alpha.cookie,
      { method: "DELETE" }
    ), 204);
    const stillReady = await api(
      `/api/v1/chats/${chat.conversationId}/voice/uploads/${published.sessionId}`,
      alpha.cookie
    );
    await expectStatus(stillReady, 200);
    expect((await json(stillReady)).upload.state).toBe("ready");

    const audio = await api(
      `/api/v1/chats/${chat.conversationId}/messages/${message.messageId}/voice/audio`,
      beta.cookie,
      { headers: { accept: "audio/webm" } }
    );
    await expectStatus(audio, 200);
    expect(new Uint8Array(await audio.arrayBuffer())).toEqual(bytes);
  });
});
