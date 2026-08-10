import { describe, expect, test } from "vitest";
import { handleRequest } from "../worker/src/app.ts";

const assets = {
  fetch() {
    return Promise.resolve(new Response("asset"));
  }
};

describe("storage binding diagnostics", () => {
  test("health stays available and reports a missing D1 binding", async () => {
    const response = await handleRequest(new Request("https://bulbam.test/api/health"), { ASSETS: assets });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.storage).toEqual({ binding: "missing" });
  });

  test("ready returns a useful 503 when D1 is not bound", async () => {
    const response = await handleRequest(new Request("https://bulbam.test/api/ready"), { ASSETS: assets });
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error.code).toBe("storage_binding_missing");
  });

  test("identity endpoints do not collapse to internal 500 without D1", async () => {
    const response = await handleRequest(
      new Request("https://bulbam.test/api/v1/auth/me", { method: "GET" }),
      { ASSETS: assets }
    );
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error.code).toBe("storage_binding_missing");
  });
});
