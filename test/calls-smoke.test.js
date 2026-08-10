import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { createTestHarness } from "wrangler";

const PASSWORD = "Bulbam-Calls-Smoke-2026!";
const server = createTestHarness({
  workers: [{ configPath: "./wrangler.test.jsonc" }]
});

beforeAll(async () => { await server.listen(); });
afterEach(async () => { await server.reset(); });
afterAll(async () => { await server.close(); });

async function json(response) {
  const text = await response.text();
  try { return JSON.parse(text); }
  catch { throw new Error(`Expected JSON, got HTTP ${response.status}: ${text}`); }
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
  await env.DB.prepare(`
    INSERT INTO invites (
      invite_id, code_hash, created_by_user_id, role_grant,
      created_at, expires_at, used_at, used_by_user_id
    ) VALUES (?, ?, NULL, 'member', ?, NULL, NULL, NULL)
  `).bind(inviteId, hash, Date.now()).run();
}
async function register({ username, displayName, inviteCode }) {
  const response = await server.fetch("/api/v1/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, displayName, password: PASSWORD, inviteCode, deviceName: "Calls smoke" })
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

describe("one-to-one audio call signaling", () => {
  test("keeps live call state and WebRTC signaling in the conversation Durable Object", async () => {
    const inviteA = "BULBAM-CALL-SMOKE-ALPHA-2026";
    const inviteB = "BULBAM-CALL-SMOKE-BETA-2026";
    await seedInvite(inviteA, "call-smoke-alpha-invite");
    await seedInvite(inviteB, "call-smoke-beta-invite");

    const alpha = await register({ username: "call_alpha", displayName: "Егор Звонок", inviteCode: inviteA });
    const beta = await register({ username: "call_beta", displayName: "Настя Звонок", inviteCode: inviteB });

    const open = await api("/api/v1/chats/direct", alpha.cookie, {
      method: "POST",
      body: JSON.stringify({ userId: beta.account.userId })
    });
    await expectStatus(open, 200);
    const chat = (await json(open)).chat;
    const root = `/api/v1/chats/${chat.conversationId}/calls`;

    const ice = await api("/api/v1/calls/ice", alpha.cookie);
    await expectStatus(ice, 200);
    expect((await json(ice)).iceServers.some((server) => {
      const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
      return urls.includes("stun:stun.cloudflare.com:3478");
    })).toBe(true);

    const started = await api(root, alpha.cookie, { method: "POST" });
    await expectStatus(started, 201);
    const call = (await json(started)).call;
    const callRoot = `${root}/${call.callId}`;
    expect(call.status).toBe("ringing");
    expect(call.direction).toBe("outgoing");
    expect(call.peer.userId).toBe(beta.account.userId);

    const betaView = await api(callRoot, beta.cookie);
    await expectStatus(betaView, 200);
    expect((await json(betaView)).call).toMatchObject({
      status: "ringing",
      direction: "incoming",
      peer: expect.objectContaining({ userId: alpha.account.userId })
    });

    const callerCannotAnswer = await api(`${callRoot}/answer`, alpha.cookie, { method: "POST" });
    await expectStatus(callerCannotAnswer, 403);

    const busy = await api(root, beta.cookie, { method: "POST" });
    await expectStatus(busy, 409);

    const answered = await api(`${callRoot}/answer`, beta.cookie, { method: "POST" });
    await expectStatus(answered, 200);
    expect((await json(answered)).call.status).toBe("accepted");

    const calleeCannotOffer = await api(`${callRoot}/signals`, beta.cookie, {
      method: "POST",
      body: JSON.stringify({ kind: "offer", payload: { type: "offer", sdp: "v=0\r\nmock-offer" } })
    });
    await expectStatus(calleeCannotOffer, 403);

    const offerResponse = await api(`${callRoot}/signals`, alpha.cookie, {
      method: "POST",
      body: JSON.stringify({ kind: "offer", payload: { type: "offer", sdp: "v=0\r\nmock-offer" } })
    });
    await expectStatus(offerResponse, 201);
    const offer = (await json(offerResponse)).signal;
    expect(offer.kind).toBe("offer");
    expect(offer.sequence).toEqual(expect.any(Number));

    const signalsForBeta = await api(`${callRoot}/signals?after=0`, beta.cookie);
    await expectStatus(signalsForBeta, 200);
    expect((await json(signalsForBeta)).signals).toEqual([
      expect.objectContaining({ sequence: offer.sequence, senderUserId: alpha.account.userId, kind: "offer" })
    ]);

    const answerSignal = await api(`${callRoot}/signals`, beta.cookie, {
      method: "POST",
      body: JSON.stringify({ kind: "answer", payload: { type: "answer", sdp: "v=0\r\nmock-answer" } })
    });
    await expectStatus(answerSignal, 201);

    const iceSignal = await api(`${callRoot}/signals`, alpha.cookie, {
      method: "POST",
      body: JSON.stringify({
        kind: "ice",
        payload: {
          candidate: "candidate:1 1 UDP 2122260223 192.0.2.1 50000 typ host",
          sdpMid: "0",
          sdpMLineIndex: 0
        }
      })
    });
    await expectStatus(iceSignal, 201);

    const signalsForAlpha = await api(`${callRoot}/signals?after=${offer.sequence}`, alpha.cookie);
    await expectStatus(signalsForAlpha, 200);
    const alphaSignals = (await json(signalsForAlpha)).signals;
    expect(alphaSignals).toEqual(expect.arrayContaining([
      expect.objectContaining({ senderUserId: beta.account.userId, kind: "answer" })
    ]));
    expect(alphaSignals.some((signal) => signal.senderUserId === alpha.account.userId)).toBe(false);

    const ended = await api(`${callRoot}/end`, beta.cookie, { method: "POST" });
    await expectStatus(ended, 200);
    expect((await json(ended)).call).toMatchObject({ status: "ended", endedByUserId: beta.account.userId });

    const signalAfterEnd = await api(`${callRoot}/signals`, alpha.cookie, {
      method: "POST",
      body: JSON.stringify({ kind: "ice", payload: { candidate: "candidate:2 1 UDP 1 192.0.2.2 50001 typ host" } })
    });
    await expectStatus(signalAfterEnd, 409);

    const nextCall = await api(root, alpha.cookie, { method: "POST" });
    await expectStatus(nextCall, 201);
    expect((await json(nextCall)).call.status).toBe("ringing");
  });
});
