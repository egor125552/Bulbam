import { describe, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../web/sw.js", import.meta.url), "utf8");
function listeners() {
  const hooks = {};
  const self = {
    location: { origin: "https://bulbam.test" },
    addEventListener(type, callback) { hooks[type] = callback; },
    skipWaiting() {},
    clients: { claim() {} }
  };
  const cache = { match: async () => null, put: async () => undefined };
  const caches = { open: async () => cache, match: async () => null };
  const fetch = async (req) => ({
    ok: true, url: req.url, clone() { return this; }
  });
  runInNewContext(source, { self, URL, fetch, caches, console });
  return hooks;
}
function request(url, { method = "GET", mode = "same-origin" } = {}) {
  const called = vi.fn();
  let pending = Promise.resolve();
  return {
    request: { method, url, mode },
    respondWith(response) { called(); pending = Promise.resolve(response); },
    waitUntil: vi.fn(), called,
    settled: () => pending
  };
}

describe("PWA cache on very slow mobile networks", () => {
  test("authenticated requests and POST are never intercepted", () => {
    const hooks = listeners();
    for (const path of ["/api/v1/auth/me", "/api/v1/chats", "/api/v1/calls/ice", "/api/v1/realtime"]) {
      const e = request("https://bulbam.test" + path);
      hooks.fetch(e);
      expect(e.called).not.toHaveBeenCalled();
    }
    const e = request("https://bulbam.test/js/calls.js", { method: "POST" });
    hooks.fetch(e);
    expect(e.called).not.toHaveBeenCalled();
  });
  test("only same-origin static shell, versioned JS and navigation are cacheable", async () => {
    const hooks = listeners();
    for (const [path, mode] of [["/boot.0123456789ab.js", "same-origin"], ["/styles.css", "same-origin"], ["/", "navigate"]]) {
      const e = request("https://bulbam.test" + path, { mode });
      hooks.fetch(e);
      expect(e.called).toHaveBeenCalledTimes(1);
      await e.settled();
    }
    for (const path of ["/js/calls.js", "/js/voice-player.js", "/voice/private.m4a"]) {
      const e = request("https://bulbam.test" + path);
      hooks.fetch(e);
      expect(e.called).not.toHaveBeenCalled();
    }
    const foreign = request("https://example.org/styles.css");
    hooks.fetch(foreign);
    expect(foreign.called).not.toHaveBeenCalled();
  });
});
