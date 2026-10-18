import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";

const read = (name) => readFile(new URL(`../web/${name}`, import.meta.url), "utf8");

describe("accessible messenger layout", () => {
  test("has explicit controls for chat searching and returning to recent messages", async () => {
    const html = await read("index.html");
    expect(html).toContain('id="chat-filter"');
    expect(html).toContain('id="chat-filter-clear"');
    expect(html).toContain('id="chat-filter-empty"');
    expect(html).toContain('id="jump-to-latest"');
    expect(html).toContain('id="chat-start-empty"');
  });
  test("does not invent unsupported unread counts, and keeps chat and message modules separate", async () => {
    const source = await read("js/messenger.js");
    expect(source).toContain('chatPreview(');
    expect(source).toContain('dayLabel(');
    expect(source).toContain('isNearBottom(');
    expect(source).toContain('chat-time');
    expect(source).not.toContain('Непрочитано: 0');
  });
});
