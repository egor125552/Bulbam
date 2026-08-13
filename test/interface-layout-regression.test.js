import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";

describe("conversation layout regression", () => {
  test("composer keeps its own grid row when optional call UI is hidden", async () => {
    const css = await readFile(new URL("../web/canonical-ui.css", import.meta.url), "utf8");

    expect(css).toMatch(/\.conversation-header\s*\{[^}]*grid-row:\s*1/s);
    expect(css).toMatch(/\.call-banner\s*\{[^}]*grid-row:\s*2/s);
    expect(css).toMatch(/\.conversation-empty,\s*\n?\.message-list\s*\{[^}]*grid-row:\s*3/s);
    expect(css).toMatch(/\.composer\s*\{[^}]*grid-row:\s*4/s);
  });
});
