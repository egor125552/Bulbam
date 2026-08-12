import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { createTestHarness } from "wrangler";

const PASSWORD = "Bulbam-Voice-Public-Socket-2026!";
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
  const setCookie = response.headers.get("set-cookie") ?? "";
  const match = setCookie.match(/(?:^|,\s*)bulbam_session=([^;]+)/);
  if (!match) throw new Error(`No bulbam_session cookie: ${setCookie}`);
  return `bulbam_session=${match[1]}`;
}

async function seedInvite(code, inviteId) {
  const ready = await server.fetch("/api/ready");
  await expectStatus(ready, 200);
  const env = await server.getWorker("bulbam-api-test").getEnv();
  const hash = createHash("sha256").update(code).digest("hex");
  await env.DB.prepare(`
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
    body: JSON.stringify({ username, displayName, password: PASSWORD, inviteCode, deviceName: "Voice public socket smoke" })
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

function nextJsonMessage(socket, type) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), 5_000);
    const listener = (event) => {
      if (typeof event.data !== "string") return;
      let payload;
      try { payload = JSON.parse(event.data); }
      catch { return; }
      if (payload.type !== type) return;
      clearTimeout(timeout);
      socket.removeEventListener("message", listener);
      resolve(payload);
    };
    socket.addEventListener("message", listener);
  });
}

function voiceFrame(partNumber, bytes) {
  const frame = new Uint8Array(bytes.byteLength + 4);
  new DataView(frame.buffer).setUint32(0, partNumber, false);
  frame.set(bytes, 4);
  return frame.buffer;
}

describe("voice upload public websocket route", () => {
  test("authenticates the browser route and forwards binary chunks to VoiceUploadRoom", async () => {
    const inviteA = "BULBAM-VOICE-PUBLIC-ALPHA-2026";
    const inviteB = "BULBAM-VOICE-PUBLIC-BETA-2026";
    await seedInvite(inviteA, "voice-public-alpha-invite");
    await seedInvite(inviteB, "voice-public-beta-invite");

    const alpha = await register("voice_public_alpha", "Егор Public Voice", inviteA);
    const beta = await register("voice_public_beta", "Маша Public Voice", inviteB);

    const chatResponse = await api("/api/v1/chats/direct", alpha.cookie, {
      method: "POST",
      body: JSON.stringify({ userId: beta.account.userId })
    });
    await expectStatus(chatResponse, 200);
    const chat = (await json(chatResponse)).chat;

    const start = await api(`/api/v1/chats/${chat.conversationId}/voice/uploads`, alpha.cookie, {
      method: "POST",
      body: JSON.stringify({ mimeType: "audio/webm;codecs=opus", bitrateBps: 64_000 })
    });
    await expectStatus(start, 201);
    const upload = (await json(start)).upload;

    const unauthorized = await server.fetch(
      `/api/v1/chats/${chat.conversationId}/voice/uploads/${upload.sessionId}/socket`,
      { headers: { Upgrade: "websocket" } }
    );
    expect(unauthorized.status).not.toBe(101);

    const response = await server.fetch(
      `/api/v1/chats/${chat.conversationId}/voice/uploads/${upload.sessionId}/socket`,
      { headers: { Upgrade: "websocket", cookie: alpha.cookie } }
    );
    await expectStatus(response, 101);
    const socket = response.webSocket;
    if (!socket) throw new Error("Expected public voice upload WebSocket");
    const readyPromise = nextJsonMessage(socket, "voice.upload.ready");
    socket.accept();
    const ready = await readyPromise;
    expect(ready.sessionId).toBe(upload.sessionId);
    expect(ready.receivedParts).toEqual([]);

    const bytes = new Uint8Array([26, 69, 223, 163, 66, 134, 129, 1]);
    const ackPromise = nextJsonMessage(socket, "voice.upload.ack");
    socket.send(voiceFrame(1, bytes));
    const ack = await ackPromise;
    expect(ack.partNumber).toBe(1);
    expect(ack.sizeBytes).toBe(bytes.byteLength);
    socket.close(1000, "public route tested");

    const complete = await api(
      `/api/v1/chats/${chat.conversationId}/voice/uploads/${upload.sessionId}/complete`,
      alpha.cookie,
      {
        method: "POST",
        body: JSON.stringify({
          clientMessageId: `voice_public_${crypto.randomUUID().replaceAll("-", "")}`,
          durationMs: 1_000,
          chunkCount: 1,
          sizeBytes: bytes.byteLength
        })
      }
    );
    await expectStatus(complete, 201);
    expect((await json(complete)).message.kind).toBe("voice");
  });
});
