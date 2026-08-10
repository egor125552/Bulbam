import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { createTestHarness } from "wrangler";

const TEST_INVITE_CODE = "BULBAM-TEST-OWNER-REGISTRATION-SMOKE";
const TEST_USERNAME = "ci_owner";
const TEST_PASSWORD = "Bulbam-CI-Registration-2026!";

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
    const body = await response.clone().text();
    throw new Error(`Expected HTTP ${expected}, got ${response.status}: ${body}`);
  }
}

function sessionCookie(response) {
  const setCookie = response.headers.get("set-cookie") ?? "";
  const match = setCookie.match(/(?:^|,\s*)bulbam_session=([^;]+)/);
  if (!match) throw new Error(`Registration/login response did not set bulbam_session: ${setCookie}`);
  return `bulbam_session=${match[1]}`;
}

async function seedOwnerInvite() {
  const ready = await server.fetch("/api/ready");
  await expectStatus(ready, 200);

  const worker = server.getWorker("bulbam-api-test");
  const env = await worker.getEnv();
  const codeHash = createHash("sha256").update(TEST_INVITE_CODE).digest("hex");
  const now = Date.now();

  const result = await env.DB
    .prepare(`
      INSERT INTO invites (
        invite_id, code_hash, created_by_user_id, role_grant,
        created_at, expires_at, used_at, used_by_user_id
      ) VALUES (?, ?, NULL, 'owner', ?, NULL, NULL, NULL)
    `)
    .bind("ci-registration-owner-invite", codeHash, now)
    .run();

  if (result.success === false) {
    throw new Error(`Could not seed registration invite: ${result.error ?? "unknown D1 error"}`);
  }
}

describe("registration smoke", () => {
  test("registers an owner, authenticates the session, logs out and logs back in", async () => {
    await seedOwnerInvite();

    const register = await server.fetch("/api/v1/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: TEST_USERNAME,
        displayName: "CI Owner",
        password: TEST_PASSWORD,
        inviteCode: TEST_INVITE_CODE,
        deviceName: "GitHub Actions"
      })
    });
    await expectStatus(register, 201);

    const registered = await json(register.clone());
    expect(registered.ok).toBe(true);
    expect(registered.account).toMatchObject({ username: TEST_USERNAME, role: "owner" });
    expect(registered.account.userId).toMatch(/^[0-9a-f-]{36}$/i);

    const cookie = sessionCookie(register);
    const me = await server.fetch("/api/v1/auth/me", {
      headers: { cookie }
    });
    await expectStatus(me, 200);
    const current = await json(me);
    expect(current.account.userId).toBe(registered.account.userId);
    expect(current.account.username).toBe(TEST_USERNAME);

    const logout = await server.fetch("/api/v1/auth/logout", {
      method: "POST",
      headers: { cookie }
    });
    await expectStatus(logout, 200);

    const oldSession = await server.fetch("/api/v1/auth/me", {
      headers: { cookie }
    });
    await expectStatus(oldSession, 401);

    const login = await server.fetch("/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: TEST_USERNAME,
        password: TEST_PASSWORD,
        deviceName: "GitHub Actions login"
      })
    });
    await expectStatus(login, 200);
    const loggedIn = await json(login.clone());
    expect(loggedIn.account.userId).toBe(registered.account.userId);
    expect(loggedIn.account.role).toBe("owner");
    expect(sessionCookie(login)).toContain("bulbam_session=");

    const worker = server.getWorker("bulbam-api-test");
    const env = await worker.getEnv();
    const account = await env.DB
      .prepare("SELECT username, password_hash, role FROM accounts WHERE user_id = ?")
      .bind(registered.account.userId)
      .first();
    expect(account.username).toBe(TEST_USERNAME);
    expect(account.role).toBe("owner");
    expect(account.password_hash).not.toBe(TEST_PASSWORD);
    expect(String(account.password_hash)).toMatch(/^PBKDF2-SHA256\$/);

    const invite = await env.DB
      .prepare("SELECT used_at, used_by_user_id FROM invites WHERE invite_id = ?")
      .bind("ci-registration-owner-invite")
      .first();
    expect(Number(invite.used_at)).toBeGreaterThan(0);
    expect(invite.used_by_user_id).toBe(registered.account.userId);
  });
});
