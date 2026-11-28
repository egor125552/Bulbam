import { describe, expect, test } from "vitest";
import {
  extractMessageLinks,
  normalizeSafeHref,
  tokenizeMessageText
} from "../web/js/message-links.js";
import { buildMessageReadingText } from "../web/js/message-reading-core.js";

describe("message link parsing and security", () => {
  test("parses https, http, www, and allowlisted bare domains cleanly", () => {
    const tokens = tokenizeMessageText(
      "Смотри https://bulbam.app/docs, http://example.org/test?a=1&b=2, www.google.com и github.com/bulbam."
    );
    const links = tokens.filter((t) => t.type === "link");
    expect(links.map((l) => ({ text: l.text, href: l.href }))).toEqual([
      { text: "https://bulbam.app/docs", href: "https://bulbam.app/docs" },
      { text: "http://example.org/test?a=1&b=2", href: "http://example.org/test?a=1&b=2" },
      { text: "www.google.com", href: "https://www.google.com/" },
      { text: "github.com/bulbam", href: "https://github.com/bulbam" }
    ]);
  });

  test("trims trailing sentence punctuation while preserving balanced parentheses", () => {
    const links = extractMessageLinks(
      "Вот (https://en.wikipedia.org/wiki/Audio_(sound)) и ещё (https://example.com/a)!"
    );
    expect(links.map((l) => l.text)).toEqual([
      "https://en.wikipedia.org/wiki/Audio_(sound)",
      "https://example.com/a"
    ]);
  });

  test("does not link emails, file names, version strings, or word fragments", () => {
    expect(extractMessageLinks("Почта test@example.com, файл app.js, версия v1.2.3 и index.html")).toEqual([]);
  });

  test("rejects javascript:, data:, file:, and credential phishing URLs", () => {
    expect(normalizeSafeHref("javascript:alert(1)")).toBeNull();
    expect(normalizeSafeHref("data:text/html,<script>alert(1)</script>")).toBeNull();
    expect(normalizeSafeHref("file:///etc/passwd")).toBeNull();
    expect(normalizeSafeHref("https://user:pass@evil.com/login")).toBeNull();
    expect(
      extractMessageLinks("Не кликай javascript:alert(1) data:text/html,hi https://admin:123@phish.com/a")
    ).toEqual([]);
  });

  test("includes edited indicator in VoiceOver reading summaries", () => {
    const baseMsg = {
      kind: "text",
      text: "Обновлённый текст",
      createdAt: Date.UTC(2026, 10, 27, 12, 30),
      editedAt: Date.UTC(2026, 10, 27, 12, 35)
    };
    const singleSummary = buildMessageReadingText(baseMsg, {
      mode: "single",
      mine: true,
      authorName: "Вы",
      isGroup: false
    });
    const telegramSummary = buildMessageReadingText(baseMsg, {
      mode: "telegram",
      mine: false,
      authorName: "Алёна",
      isGroup: false
    });
    expect(singleSummary.toLowerCase()).toContain("изменено");
    expect(telegramSummary.toLowerCase()).toContain("изменено");
  });
});
