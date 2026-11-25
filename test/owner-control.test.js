import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { createTestHarness } from "wrangler";

const server = createTestHarness({ workers: [{ configPath: "./wrangler.test.jsonc" }] });

beforeAll(() => server.listen());
afterEach(() => server.reset());
afterAll(() => server.close());

async function api(path, { method = "GET", body, cookie } = {}) {
  return server.fetch(path, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {})
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });
}

function sessionCookie(response) {
  const header = response.headers.get("set-cookie") || "";
  const match = header.match(/bulbam_session=([^;]+)/);
  expect(match).not.toBeNull();
  return `bulbam_session=${match[1]}`;
}

async function seedUsers() {
  await server.fetch("/api/ready");
  const env = await server.getWorker("bulbam-api-test").getEnv();
  const ownerInvite = "BULBAM-OWNER-CTRL-2026";
  await env.DB.prepare("INSERT INTO invites(invite_id, code_hash, role_grant, created_at) VALUES (?, ?, ?, ?)")
    .bind("owner-ctrl-invite", createHash("sha256").update(ownerInvite).digest("hex"), "owner", Date.now())
    .run();

  const ownerRes = await api("/api/v1/auth/register", {
    method: "POST",
    body: {
      username: "egor_owner",
      displayName: "Егор",
      password: "owner-secret-password-2026",
      inviteCode: ownerInvite
    }
  });
  expect(ownerRes.status).toBe(201);
  const ownerData = await ownerRes.json();
  const owner = {
    cookie: sessionCookie(ownerRes),
    userId: ownerData.account.userId,
    username: ownerData.account.username
  };

  async function createMember(username, displayName) {
    const inv = await api("/api/v1/invites", {
      method: "POST",
      cookie: owner.cookie,
      body: { expiresInHours: 24 }
    });
    expect(inv.status).toBe(201);
    const { code } = await inv.json();
    const res = await api("/api/v1/auth/register", {
      method: "POST",
      body: {
        username,
        displayName,
        password: `secret-${username}-2026`,
        inviteCode: code
      }
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    return {
      cookie: sessionCookie(res),
      userId: data.account.userId,
      username: data.account.username
    };
  }

  const pasha = await createMember("pasha_user", "Паша");
  const sveta = await createMember("sveta_user", "Света");
  return { owner, pasha, sveta, env };
}

describe("owner control panel and session resilience", () => {
  test("only owner can access /api/v1/owner/* endpoints", async () => {
    const { owner, pasha } = await seedUsers();

    expect((await api("/api/v1/owner/users")).status).toBe(401);
    expect((await api("/api/v1/owner/users", { cookie: pasha.cookie })).status).toBe(403);
    expect(
      (
        await api(`/api/v1/owner/users/${pasha.userId}/restore-session`, {
          method: "POST",
          cookie: pasha.cookie
        })
      ).status
    ).toBe(403);
    expect(
      (
        await api(`/api/v1/owner/users/${pasha.userId}/login-link`, {
          method: "POST",
          cookie: pasha.cookie
        })
      ).status
    ).toBe(403);
    expect(
      (
        await api(`/api/v1/owner/users/${pasha.userId}`, {
          method: "DELETE",
          cookie: pasha.cookie,
          body: { confirmed: true, reason: "test" }
        })
      ).status
    ).toBe(403);

    const listRes = await api("/api/v1/owner/users", { cookie: owner.cookie });
    expect(listRes.status).toBe(200);
    const { users } = await listRes.json();
    expect(users.map((u) => u.username)).toEqual(
      expect.arrayContaining(["egor_owner", "pasha_user", "sveta_user"])
    );
    const ownerEntry = users.find((u) => u.username === "egor_owner");
    expect(ownerEntry.isSelf).toBe(true);
    expect(ownerEntry.activeSessionsCount).toBeGreaterThanOrEqual(1);
  });

  test("owner can revoke and restore a member session so their existing cookie works again", async () => {
    const { owner, pasha } = await seedUsers();

    // Revoke all sessions for Pasha
    const revokeRes = await api(`/api/v1/owner/users/${pasha.userId}/revoke-sessions`, {
      method: "POST",
      cookie: owner.cookie
    });
    expect(revokeRes.status).toBe(200);
    expect((await revokeRes.json()).revokedCount).toBeGreaterThanOrEqual(1);

    // Pasha's cookie is now rejected
    expect((await api("/api/v1/auth/me", { cookie: pasha.cookie })).status).toBe(401);

    // Owner restores Pasha's expired/revoked session
    const restoreRes = await api(`/api/v1/owner/users/${pasha.userId}/restore-session`, {
      method: "POST",
      cookie: owner.cookie
    });
    expect(restoreRes.status).toBe(200);
    const restoreData = await restoreRes.json();
    expect(restoreData.restored).toBe(true);
    expect(restoreData.expiresAt).toBeGreaterThan(Date.now() + 80 * 24 * 60 * 60 * 1000);

    // Pasha's exact same cookie immediately works again!
    const meRes = await api("/api/v1/auth/me", { cookie: pasha.cookie });
    expect(meRes.status).toBe(200);
    expect((await meRes.json()).account.username).toBe("pasha_user");
  });

  test("owner can issue a single-use login link that signs the member in once", async () => {
    const { owner, pasha } = await seedUsers();

    const linkRes = await api(`/api/v1/owner/users/${pasha.userId}/login-link`, {
      method: "POST",
      cookie: owner.cookie
    });
    expect(linkRes.status).toBe(200);
    const { loginUrl } = await linkRes.json();
    const token = new URL(loginUrl).searchParams.get("loginToken");
    expect(token).toMatch(/^ol_[0-9a-f]{64}$/);

    // Cannot create one-time link for owner account
    expect(
      (
        await api(`/api/v1/owner/users/${owner.userId}/login-link`, {
          method: "POST",
          cookie: owner.cookie
        })
      ).status
    ).toBe(403);

    // Redeem once
    const redeemRes = await api("/api/v1/auth/owner-login-token", {
      method: "POST",
      body: { token, deviceName: "iPhone Safari" }
    });
    expect(redeemRes.status).toBe(200);
    const redeemData = await redeemRes.json();
    expect(redeemData.account.username).toBe("pasha_user");
    const newCookie = sessionCookie(redeemRes);
    expect((await api("/api/v1/auth/me", { cookie: newCookie })).status).toBe(200);

    // Second redemption fails (strictly one-time)
    const secondRes = await api("/api/v1/auth/owner-login-token", {
      method: "POST",
      body: { token, deviceName: "Other Device" }
    });
    expect(secondRes.status).toBe(400);
  });

  test("owner deletion requires checkbox confirmation, wipes direct chats, excludes from groups with reason, and blocks re-login with reason", async () => {
    const { owner, pasha, sveta } = await seedUsers();

    // 1. Create a direct chat between owner and pasha with messages
    const directRes = await api("/api/v1/chats/direct", {
      method: "POST",
      cookie: owner.cookie,
      body: { userId: pasha.userId }
    });
    expect(directRes.status).toBe(200);
    const directChat = (await directRes.json()).chat;
    expect(
      (
        await api(`/api/v1/chats/${directChat.conversationId}/messages`, {
          method: "POST",
          cookie: pasha.cookie,
          body: { clientMessageId: "dm_pasha_0001", text: "Привет в личке" }
        })
      ).status
    ).toBe(201);

    // 2. Create a shared group (owner + pasha + sveta) with messages from pasha and sveta
    const groupRes = await api("/api/v1/chats/groups", {
      method: "POST",
      cookie: pasha.cookie,
      body: {
        title: "Общий чат",
        historyMode: "all",
        userIds: [owner.userId, sveta.userId]
      }
    });
    expect(groupRes.status).toBe(201);
    const groupChat = (await groupRes.json()).chat;
    expect(
      (
        await api(`/api/v1/chats/${groupChat.conversationId}/messages`, {
          method: "POST",
          cookie: pasha.cookie,
          body: { clientMessageId: "grp_pasha_0001", text: "Сообщение Паши в группе" }
        })
      ).status
    ).toBe(201);
    expect(
      (
        await api(`/api/v1/chats/${groupChat.conversationId}/messages`, {
          method: "POST",
          cookie: sveta.cookie,
          body: { clientMessageId: "grp_sveta_0001", text: "Сообщение Светы в группе" }
        })
      ).status
    ).toBe(201);

    // 3. Cannot delete self or without confirmed: true
    expect(
      (
        await api(`/api/v1/owner/users/${owner.userId}`, {
          method: "DELETE",
          cookie: owner.cookie,
          body: { confirmed: true, reason: "oops" }
        })
      ).status
    ).toBe(400);
    expect(
      (
        await api(`/api/v1/owner/users/${pasha.userId}`, {
          method: "DELETE",
          cookie: owner.cookie,
          body: { confirmed: false, reason: "Не подтверждено" }
        })
      ).status
    ).toBe(400);

    // 4. Delete Pasha with confirmed: true and reason
    const reason = "Удалён по решению владельца за тест";
    const delRes = await api(`/api/v1/owner/users/${pasha.userId}`, {
      method: "DELETE",
      cookie: owner.cookie,
      body: { confirmed: true, reason }
    });
    expect(delRes.status).toBe(200);
    const delData = await delRes.json();
    expect(delData.username).toBe("pasha_user");
    expect(delData.reason).toBe(reason);
    expect(delData.removedDirectChats).toBeGreaterThanOrEqual(1);
    expect(delData.updatedGroups).toBe(1);

    // 5. Pasha's session is dead and login shows 403 account_deleted with owner's reason
    expect((await api("/api/v1/auth/me", { cookie: pasha.cookie })).status).toBe(401);
    const loginRes = await api("/api/v1/auth/login", {
      method: "POST",
      body: { username: "pasha_user", password: "secret-pasha_user-2026" }
    });
    expect(loginRes.status).toBe(403);
    const loginBody = await loginRes.json();
    expect(loginBody.error.code).toBe("account_deleted");
    expect(loginBody.error.message).toContain(reason);

    // 6. Direct chat is completely wiped from owner's chat list
    const ownerChatsRes = await api("/api/v1/chats", { cookie: owner.cookie });
    const ownerChats = (await ownerChatsRes.json()).chats;
    expect(ownerChats.some((c) => c.conversationId === directChat.conversationId)).toBe(false);

    // 7. Shared group still exists, Pasha is removed, Pasha's message is gone,
    // Sveta's message remains, and exclusion notice is posted!
    const remainingGroup = ownerChats.find((c) => c.conversationId === groupChat.conversationId);
    expect(remainingGroup).toBeDefined();
    const groupMsgsRes = await api(`/api/v1/chats/${groupChat.conversationId}/messages`, {
      cookie: sveta.cookie
    });
    expect(groupMsgsRes.status).toBe(200);
    const { messages } = await groupMsgsRes.json();
    expect(messages.some((m) => m.text === "Сообщение Паши в группе")).toBe(false);
    expect(messages.some((m) => m.text === "Сообщение Светы в группе")).toBe(true);
    expect(
      messages.some((m) => m.text.includes("Паша") && m.text.includes("@pasha_user") && m.text.includes("исключён"))
    ).toBe(true);
  });
});
