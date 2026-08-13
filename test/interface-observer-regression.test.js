import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("interface observer", () => {
  it("uses guarded DOM updates", async () => {
    const source = await readFile(new URL("../web/js/canonical-interface.js", import.meta.url), "utf8");
    expect(source.includes("characterData: true")).toBe(false);
    expect(source.includes("avatar && avatar.textContent !== next")).toBe(true);
    expect(source.includes("button.hidden !== next")).toBe(true);
  });
});
