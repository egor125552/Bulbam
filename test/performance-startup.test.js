import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
const worker = readFileSync(new URL("../web/sw.js", import.meta.url), "utf8");

describe("slow-network site startup", () => {
  test("boot succeeds without waiting for two health requests or login", () => {
    expect(app).toContain("void loadCurrentAccount({ quiet: false })");
    expect(app).not.toContain("await checkServer()");
    expect(app).not.toContain("await loadCurrentAccount(");
  });
  test("one fingerprinted bundle is the startup entrypoint", () => {
    expect(html).toMatch(/import\("\/boot\.[a-f0-9]{12}\.js"\)/);
    expect(html).not.toContain('import("/js/ui.js")');
    expect(html).toContain('window.bulbamBootReady()');
    expect(html).toMatch(/rel="modulepreload" href="\/boot\.[a-f0-9]{12}\.js"/);
  });
  test("offline cache is constrained to public static assets, never API data", () => {
    expect(worker).toContain('url.pathname.startsWith("/api/")');
    expect(worker).toContain('request.method !== "GET"');
    expect(worker).toMatch(/boot\\\.[a-f0-9]|boot\\\./);
    expect(worker).toContain('request.mode === "navigate"');
  });
});
