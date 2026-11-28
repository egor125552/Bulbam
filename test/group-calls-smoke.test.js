import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { createTestHarness } from "wrangler";

const PASSWORD = "Bulbam-Group-Calls-2026!";
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
async function testEnv() {
  return server.getWorker("bulbam-api-test").getEnv();
}
async function seedInvite(code, inviteId) {
  await expectStatus(await server.fetch("/api/ready"), 200);
  const env = await testEnv();
  const hash = createHash("sha256").update(code).digest("hex");
  await env.DB.prepare(`
    INSERT INTO invites (
      invite_id, code_hash, created_by_user_id, role_grant,
      created_at, expires_at, used_at, used_by_user_id
    ) VALUES (?, ?, NULL, 'member', ?, NULL, NULL, NULL)
  `).bind(inviteId, hash, Date.now()).run();
}
async function activeCallFor(userId) {
  const env = await testEnv();
  const response = await env.REALTIME.getByName(userId).fetch("https://realtime.internal/active-call");
  await expectStatus(response, 200);
  return (await json(response)).active ?? null;
}
async function register({ username, displayName, inviteCode }) {
  const response = await server.fetch("/api/v1/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, displayName, password: PASSWORD, inviteCode, deviceName: "Group Calls Test" })
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

describe("group audio calls lifecycle and security", () => {
  test("supports 3-user join, targeted mesh signaling, mute sync, leave, rejoin and host endForAll", async () => {
    await seedInvite("BULBAM-GC-ALPHA-2026", "gc-invite-alpha");
    await seedInvite("BULBAM-GC-BETA-2026", "gc-invite-beta");
    await seedInvite("BULBAM-GC-GAMMA-2026", "gc-invite-gamma");
    await seedInvite("BULBAM-GC-OUTSIDER-2026", "gc-invite-outsider");

    const alpha = await register({ username: "gc_alpha", displayName: "Егор", inviteCode: "BULBAM-GC-ALPHA-2026" });
    const beta = await register({ username: "gc_beta", displayName: "Настя", inviteCode: "BULBAM-GC-BETA-2026" });
    const gamma = await register({ username: "gc_gamma", displayName: "Дима", inviteCode: "BULBAM-GC-GAMMA-2026" });
    const outsider = await register({ username: "gc_outsider", displayName: "Чужой", inviteCode: "BULBAM-GC-OUTSIDER-2026" });

    // Create a 3-member group chat
    const groupRes = await api("/api/v1/chats/groups", alpha.cookie, {
      method: "POST",
      body: JSON.stringify({
        title: "Зимний прототип",
        historyMode: "all",
        userIds: [beta.account.userId, gamma.account.userId]
      })
    });
    await expectStatus(groupRes, 201);
    const group = (await json(groupRes)).chat;
    const root = `/api/v1/chats/${group.conversationId}/calls`;

    // No active call initially
    const beforeActive = await api(`${root}/active`, beta.cookie);
    await expectStatus(beforeActive, 200);
    expect((await json(beforeActive)).call).toBeNull();

    // Outsider cannot query active group call
    await expectStatus(await api(`${root}/active`, outsider.cookie), 404);

    // Alpha starts group call
    const startedRes = await api(root, alpha.cookie, { method: "POST" });
    await expectStatus(startedRes, 201);
    const started = (await json(startedRes)).call;
    expect(started.kind).toBe("group");
    expect(started.status).toBe("accepted");
    expect(started.groupTitle).toBe("Зимний прототип");
    expect(started.participants).toHaveLength(1);
    expect(started.participants[0].userId).toBe(alpha.account.userId);
    expect(await activeCallFor(alpha.account.userId)).toMatchObject({
      callId: started.callId,
      kind: "group",
      status: "accepted"
    });

    const callRoot = `${root}/${started.callId}`;

    // Beta discovers active group call via conversation active endpoint
    const activeRes = await api(`${root}/active`, beta.cookie);
    await expectStatus(activeRes, 200);
    const activeCall = (await json(activeRes)).call;
    expect(activeCall.callId).toBe(started.callId);
    expect(activeCall.participants).toHaveLength(1);

    // Beta cannot send signals before joining
    const unjoinedSignal = await api(`${callRoot}/signals`, beta.cookie, {
      method: "POST",
      body: JSON.stringify({
        kind: "offer",
        targetUserId: alpha.account.userId,
        payload: { type: "offer", sdp: "v=0\r\nunjoined" }
      })
    });
    await expectStatus(unjoinedSignal, 403);

    // Beta joins via /join
    const betaJoinedRes = await api(`${callRoot}/join`, beta.cookie, { method: "POST" });
    await expectStatus(betaJoinedRes, 200);
    const betaJoined = (await json(betaJoinedRes)).call;
    expect(betaJoined.participants.map((p) => p.userId)).toEqual(
      expect.arrayContaining([alpha.account.userId, beta.account.userId])
    );

    // Gamma starts a call in the same group concurrently -> seamlessly joins existing call!
    const gammaJoinedRes = await api(root, gamma.cookie, { method: "POST" });
    await expectStatus(gammaJoinedRes, 201);
    const gammaJoined = (await json(gammaJoinedRes)).call;
    expect(gammaJoined.callId).toBe(started.callId);
    expect(gammaJoined.participants).toHaveLength(3);

    // Outsider cannot join even knowing the callId
    await expectStatus(await api(`${callRoot}/join`, outsider.cookie, { method: "POST" }), 404);

    // Targeted signaling: Alpha -> Beta offer must be visible ONLY to Beta, NOT to Gamma
    const offerAB = await api(`${callRoot}/signals`, alpha.cookie, {
      method: "POST",
      body: JSON.stringify({
        kind: "offer",
        targetUserId: beta.account.userId,
        payload: { type: "offer", sdp: "v=0\r\nalpha-to-beta" }
      })
    });
    await expectStatus(offerAB, 201);

    // Targeted signaling: Alpha -> Gamma offer must be visible ONLY to Gamma
    const offerAG = await api(`${callRoot}/signals`, alpha.cookie, {
      method: "POST",
      body: JSON.stringify({
        kind: "offer",
        targetUserId: gamma.account.userId,
        payload: { type: "offer", sdp: "v=0\r\nalpha-to-gamma" }
      })
    });
    await expectStatus(offerAG, 201);

    // Batched targeted ICE: Beta -> Gamma
    const iceBG = await api(`${callRoot}/signals`, beta.cookie, {
      method: "POST",
      body: JSON.stringify({
        signals: [{
          kind: "ice",
          targetUserId: gamma.account.userId,
          payload: { candidate: "candidate:1 1 UDP 1 192.0.2.5 50000 typ host", sdpMid: "0", sdpMLineIndex: 0 }
        }]
      })
    });
    await expectStatus(iceBG, 201);

    // Signal targeting outsider (not joined) must be rejected with 400
    const badTarget = await api(`${callRoot}/signals`, alpha.cookie, {
      method: "POST",
      body: JSON.stringify({
        kind: "offer",
        targetUserId: outsider.account.userId,
        payload: { type: "offer", sdp: "v=0\r\nbad" }
      })
    });
    await expectStatus(badTarget, 400);

    // Verify signal isolation
    const betaSignals = (await json(await api(`${callRoot}/signals?after=0`, beta.cookie))).signals;
    expect(betaSignals).toHaveLength(1);
    expect(betaSignals[0]).toMatchObject({
      senderUserId: alpha.account.userId,
      targetUserId: beta.account.userId,
      kind: "offer"
    });

    const gammaSignals = (await json(await api(`${callRoot}/signals?after=0`, gamma.cookie))).signals;
    expect(gammaSignals).toHaveLength(2);
    expect(gammaSignals.every((s) => s.targetUserId === gamma.account.userId)).toBe(true);

    // Beta mutes microphone -> state visible in call participants
    const muteRes = await api(`${callRoot}/mute`, beta.cookie, {
      method: "POST",
      body: JSON.stringify({ muted: true })
    });
    await expectStatus(muteRes, 200);
    const mutedCall = (await json(muteRes)).call;
    expect(mutedCall.participants.find((p) => p.userId === beta.account.userId)?.muted).toBe(true);

    // Beta tries endForAll (not host) -> only Beta leaves, call stays active for Alpha & Gamma!
    const betaLeaveRes = await api(`${callRoot}/leave`, beta.cookie, {
      method: "POST",
      body: JSON.stringify({ endForAll: true })
    });
    await expectStatus(betaLeaveRes, 200);
    const afterBetaLeave = (await json(betaLeaveRes)).call;
    expect(afterBetaLeave.status).toBe("accepted");
    expect(afterBetaLeave.participants.map((p) => p.userId)).toEqual(
      expect.arrayContaining([alpha.account.userId, gamma.account.userId])
    );
    expect(afterBetaLeave.participants.some((p) => p.userId === beta.account.userId)).toBe(false);
    expect(await activeCallFor(beta.account.userId)).toBeNull();
    expect(await activeCallFor(alpha.account.userId)).toMatchObject({ callId: started.callId });

    // Beta rejoins cleanly
    const betaRejoinRes = await api(`${callRoot}/join`, beta.cookie, { method: "POST" });
    await expectStatus(betaRejoinRes, 200);
    expect((await json(betaRejoinRes)).call.participants).toHaveLength(3);

    // Alpha (host) ends the call for everyone
    const endAllRes = await api(`${callRoot}/end`, alpha.cookie, {
      method: "POST",
      body: JSON.stringify({ endForAll: true })
    });
    await expectStatus(endAllRes, 200);
    expect((await json(endAllRes)).call.status).toBe("ended");
    expect(await activeCallFor(alpha.account.userId)).toBeNull();
    expect(await activeCallFor(beta.account.userId)).toBeNull();
    expect(await activeCallFor(gamma.account.userId)).toBeNull();
    expect((await json(await api(`${root}/active`, gamma.cookie))).call).toBeNull();
  });

  test("validates selective invitedUserIds and stores exact invited subset on group calls", async () => {
    await seedInvite("BULBAM-GS-ALPHA-2026", "gs-invite-alpha");
    await seedInvite("BULBAM-GS-BETA-2026", "gs-invite-beta");
    await seedInvite("BULBAM-GS-GAMMA-2026", "gs-invite-gamma");
    await seedInvite("BULBAM-GS-OUTSIDER-2026", "gs-invite-outsider");

    const alpha = await register({ username: "gs_alpha", displayName: "Алиса", inviteCode: "BULBAM-GS-ALPHA-2026" });
    const beta = await register({ username: "gs_beta", displayName: "Боб", inviteCode: "BULBAM-GS-BETA-2026" });
    const gamma = await register({ username: "gs_gamma", displayName: "Катя", inviteCode: "BULBAM-GS-GAMMA-2026" });
    const outsider = await register({ username: "gs_outsider", displayName: "Чужой", inviteCode: "BULBAM-GS-OUTSIDER-2026" });

    const groupRes = await api("/api/v1/chats/groups", alpha.cookie, {
      method: "POST",
      body: JSON.stringify({
        title: "Выборочный звонок",
        historyMode: "all",
        userIds: [beta.account.userId, gamma.account.userId]
      })
    });
    await expectStatus(groupRes, 201);
    const group = (await json(groupRes)).chat;
    const root = `/api/v1/chats/${group.conversationId}/calls`;

    await expectStatus(
      await api(root, alpha.cookie, { method: "POST", body: JSON.stringify({ invitedUserIds: [] }) }),
      400
    );
    await expectStatus(
      await api(root, alpha.cookie, { method: "POST", body: JSON.stringify({ invitedUserIds: [alpha.account.userId] }) }),
      400
    );
    await expectStatus(
      await api(root, alpha.cookie, { method: "POST", body: JSON.stringify({ invitedUserIds: [beta.account.userId, outsider.account.userId] }) }),
      400
    );

    const selectiveRes = await api(root, alpha.cookie, {
      method: "POST",
      body: JSON.stringify({ invitedUserIds: [beta.account.userId] })
    });
    await expectStatus(selectiveRes, 201);
    const call = (await json(selectiveRes)).call;
    expect(call.kind).toBe("group");
    expect(call.invitedUserIds).toEqual([beta.account.userId]);

    await expectStatus(
      await api(`${root}/${call.callId}/end`, alpha.cookie, {
        method: "POST",
        body: JSON.stringify({ endForAll: true })
      }),
      200
    );
  });
});

