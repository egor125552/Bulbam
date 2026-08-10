import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { createTestHarness } from "wrangler";

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

async function readJson(response) {
  return response.json();
}

async function expectStatus(response, status) {
  if (response.status !== status) {
    const diagnostic = await response.clone().text();
    throw new Error(`Expected HTTP ${status}, received ${response.status}: ${diagnostic}`);
  }
}

describe("bulbam-api integration", () => {
  test("health endpoint starts without touching durable storage", async () => {
    const response = await server.fetch("/api/health");
    await expectStatus(response, 200);
    const body = await readJson(response);
    expect(body.ok).toBe(true);
    expect(body.service).toBe("bulbam-api");
  });

  test("ready endpoint initializes the identity D1 schema", async () => {
    const response = await server.fetch("/api/ready");
    await expectStatus(response, 200);
    const body = await readJson(response);
    expect(body).toMatchObject({ ok: true, storage: "ready" });
  });

  test("registration rejects an unknown invite without creating an account", async () => {
    const response = await server.fetch("/api/v1/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "tester",
        displayName: "Тестер",
        password: "test-password-12345",
        inviteCode: "BULBAM-THIS-INVITE-DOES-NOT-EXIST",
        deviceName: "Integration test"
      })
    });

    await expectStatus(response, 400);
    const body = await readJson(response);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("invite_invalid");
  });
});
