import { createHash } from "node:crypto";
import { generateConversationSecret, importConversationSecret, encryptText, decryptText } from "../web/js/secure-messages.js";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { createTestHarness } from "wrangler";

const PASSWORD = "Bulbam-Messaging-Smoke-2026!";
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
    body: JSON.stringify({ username, displayName, password: PASSWORD, inviteCode, deviceName: "Messaging smoke" })
  });
  await expectStatus(response, 201);
  const payload = await json(response.clone());
  return { account: payload.account, cookie: sessionCookie(response) };
}

async function api(path, cookie, options = {}) {
  return server.fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      cookie,
      ...(options.headers ?? {})
    }
  });
}

describe("persistent direct messaging", () => {
  test("searches by display name, keeps ten idempotent messages, and records honest delivery", async () => {
    const inviteA = "BULBAM-MSG-SMOKE-ALPHA-2026";
    const inviteB = "BULBAM-MSG-SMOKE-BETA-2026";
    await seedInvite(inviteA, "msg-smoke-alpha-invite");
    await seedInvite(inviteB, "msg-smoke-beta-invite");

    const alpha = await register({ username: "alpha_test", displayName: "Егор Тестовый", inviteCode: inviteA });
    const beta = await register({ username: "beta_test", displayName: "Маша Тестовая", inviteCode: inviteB });

    const search = await api("/api/v1/users/search?q=%D0%BC%D0%B0%D1%88%D0%B0", alpha.cookie);
    await expectStatus(search, 200);
    const searchPayload = await json(search);
    expect(searchPayload.users).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userId: beta.account.userId, username: "beta_test", displayName: "Маша Тестовая" })
      ])
    );

    const open = await api("/api/v1/chats/direct", alpha.cookie, {
      method: "POST",
      body: JSON.stringify({ userId: beta.account.userId })
    });
    await expectStatus(open, 200);
    const chat = (await json(open)).chat;
    expect(chat.peer.userId).toBe(beta.account.userId);

    const sent = [];
    for (let index = 0; index < 10; index += 1) {
      const sender = index % 2 === 0 ? alpha : beta;
      const clientMessageId = `smoke_message_${index}`;
      const response = await api(`/api/v1/chats/${chat.conversationId}/messages`, sender.cookie, {
        method: "POST",
        body: JSON.stringify({ clientMessageId, text: `Сообщение ${index + 1}` })
      });
      await expectStatus(response, 201);
      const payload = await json(response);
      expect(payload.status).toBe("sent");
      expect(payload.message.deliveredAt).toBeNull();
      sent.push(payload.message);
    }

    const retry = await api(`/api/v1/chats/${chat.conversationId}/messages`, alpha.cookie, {
      method: "POST",
      body: JSON.stringify({ clientMessageId: "smoke_message_0", text: "Сообщение 1" })
    });
    await expectStatus(retry, 200);
    expect((await json(retry)).duplicate).toBe(true);

    const delivered = await api(`/api/v1/chats/${chat.conversationId}/receipts/delivered`, beta.cookie, {
      method: "POST",
      body: JSON.stringify({ messageIds: [sent[0].messageId] })
    });
    await expectStatus(delivered, 200);
    const deliveredPayload = await json(delivered);
    expect(deliveredPayload.receipts).toHaveLength(1);
    expect(deliveredPayload.receipts[0].messageId).toBe(sent[0].messageId);
    expect(deliveredPayload.receipts[0].deliveredAt).toEqual(expect.any(Number));

    const deliveredAgain = await api(`/api/v1/chats/${chat.conversationId}/receipts/delivered`, beta.cookie, {
      method: "POST",
      body: JSON.stringify({ messageIds: [sent[0].messageId] })
    });
    await expectStatus(deliveredAgain, 200);
    expect((await json(deliveredAgain)).receipts[0].deliveredAt).toBe(deliveredPayload.receipts[0].deliveredAt);

    const fakeOwnDelivery = await api(`/api/v1/chats/${chat.conversationId}/receipts/delivered`, alpha.cookie, {
      method: "POST",
      body: JSON.stringify({ messageIds: [sent[0].messageId] })
    });
    await expectStatus(fakeOwnDelivery, 400);

    for (const account of [alpha, beta]) {
      const history = await api(`/api/v1/chats/${chat.conversationId}/messages`, account.cookie);
      await expectStatus(history, 200);
      const payload = await json(history);
      expect(payload.messages).toHaveLength(10);
      expect(payload.messages.map((message) => message.text)).toEqual(
        Array.from({ length: 10 }, (_, index) => `Сообщение ${index + 1}`)
      );
      expect(payload.messages[0].deliveredAt).toBe(deliveredPayload.receipts[0].deliveredAt);
      expect(payload.messages[1].deliveredAt).toBeNull();

      const chats = await api("/api/v1/chats", account.cookie);
      await expectStatus(chats, 200);
      const chatsPayload = await json(chats);
      expect(chatsPayload.chats).toHaveLength(1);
      expect(chatsPayload.chats[0].conversationId).toBe(chat.conversationId);
      expect(chatsPayload.chats[0].lastMessage.text).toBe("Сообщение 10");
    }

    expect(sent).toHaveLength(10);
  });
});

describe("encrypted text crosses the actual server without revealing plaintext", () => {
  test("stores only authenticated ciphertext in D1 and returns it to both participants", async () => {
    await seedInvite("BULBAM-SECURE-ALPHA-2026", "secure-alpha-invite");
    await seedInvite("BULBAM-SECURE-BETA-2026", "secure-beta-invite");
    const alice = await register({
      username: "secure_alice", displayName: "Алиса", inviteCode: "BULBAM-SECURE-ALPHA-2026"
    });
    const bob = await register({
      username: "secure_bob", displayName: "Борис", inviteCode: "BULBAM-SECURE-BETA-2026"
    });
    const opened = await api("/api/v1/chats/direct", alice.cookie, {
      method: "POST", body: JSON.stringify({ userId: bob.account.userId })
    });
    await expectStatus(opened, 200);
    const conversationId = (await json(opened)).chat.conversationId;
    const context = {
      conversationId, senderUserId: alice.account.userId, clientMessageId: "secure_message_00001"
    };
    const key = await importConversationSecret(generateConversationSecret());
    const plaintext = "Личное сообщение, которого не должно быть в базе данных.";
    const wire = await encryptText(plaintext, key, context);
    expect(wire).not.toContain(plaintext);
    const sent = await api(`/api/v1/chats/${conversationId}/messages`, alice.cookie, {
      method: "POST",
      body: JSON.stringify({ clientMessageId: context.clientMessageId, text: wire })
    });
    await expectStatus(sent, 201);

    const receiverHistory = await api(`/api/v1/chats/${conversationId}/messages`, bob.cookie);
    await expectStatus(receiverHistory, 200);
    const [message] = (await json(receiverHistory)).messages;
    expect(message.text).toBe(wire);
    expect(message.text).not.toContain(plaintext);
    expect(await decryptText(message.text, key, {
      conversationId: message.conversationId,
      senderUserId: message.senderUserId,
      clientMessageId: message.clientMessageId
    })).toBe(plaintext);

    const worker = server.getWorker("bulbam-api-test");
    const env = await worker.getEnv();
    const row = await env.DB.prepare("SELECT body FROM messages WHERE client_message_id = ?")
      .bind(context.clientMessageId).first();
    expect(row?.body).toBe(wire);
    expect(row?.body).not.toContain(plaintext);

    const chats = await api("/api/v1/chats", bob.cookie);
    expect((await json(chats)).chats[0].lastMessage.text).toBe(wire);
  });
});
