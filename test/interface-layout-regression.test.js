import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";

describe("conversation layout regression", () => {
  test("the composer stays at the bottom while the call screen is separate", async () => {
    const css = await readFile(new URL("../web/canonical-ui.css", import.meta.url), "utf8");
    const base = await readFile(new URL("../web/styles.css", import.meta.url), "utf8");

    expect(base).toMatch(/grid-template-rows:\s*auto minmax\(0, 1fr\) auto/);
    expect(css).toMatch(/\.conversation-header\s*\{[^}]*grid-row:\s*1/s);
    expect(css).toMatch(/\.conversation-empty,\s*\n?\.message-list\s*\{[^}]*grid-row:\s*2/s);
    expect(css).toMatch(/\.composer\s*\{[^}]*grid-row:\s*3/s);
  });

  test("chat presence has its own visible row instead of falling out of the chat card", async () => {
    const css = await readFile(new URL("../web/canonical-ui.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.chat-item\s*\{[^}]*grid-template-rows:\s*auto auto auto/s);
    expect(css).toMatch(/\.chat-item > \.chat-presence\s*\{[^}]*grid-row:\s*2[^}]*grid-column:\s*2 \/ 4/s);
    expect(css).toMatch(/\.chat-item > \.chat-preview\s*\{[^}]*grid-row:\s*3[^}]*grid-column:\s*2 \/ 4/s);
  });
});
