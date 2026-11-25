import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  DEFAULT_MESSAGE_READING_MODE,
  MESSAGE_READING_MODES,
  MESSAGE_READING_SAMPLE_ITEMS,
  buildMessageReadingText,
  deliveryStatusSummary,
  formatDurationSpoken,
  normalizeMessageReadingMode,
  readingModeAnnouncement,
  readingModeDescription
} from "../web/js/message-reading-core.js";
import { be } from "../web/js/locales/be.js";

const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
const translateBe = (value) => be[value] ?? value;

describe("accessible message reading modes", () => {
  test("normalizes valid modes and safely falls back to parts", () => {
    expect(MESSAGE_READING_MODES).toEqual(["parts", "single", "telegram", "table"]);
    expect(DEFAULT_MESSAGE_READING_MODE).toBe("parts");
    for (const mode of MESSAGE_READING_MODES) {
      expect(normalizeMessageReadingMode(mode)).toBe(mode);
    }
    expect(normalizeMessageReadingMode("invalid")).toBe("parts");
    expect(normalizeMessageReadingMode(null)).toBe("parts");
  });

  test("formats spoken durations accurately in Russian and Belarusian without English leaks", () => {
    expect(formatDurationSpoken(7000)).toBe("7 секунд");
    expect(formatDurationSpoken(69000)).toBe("1 минута 9 секунд");
    expect(formatDurationSpoken(122000)).toBe("2 минуты 2 секунды");
    expect(formatDurationSpoken(3661000)).toBe("1 час 1 минута 1 секунда");

    expect(formatDurationSpoken(69000, translateBe)).toBe("1 хвіліна 9 секунд");
    expect(formatDurationSpoken(122000, translateBe)).toBe("2 хвіліны 2 секунды");
  });

  test("formats Telegram-style detailed voice readout cleanly with separated read and listened statuses", () => {
    const sampleVoice = MESSAGE_READING_SAMPLE_ITEMS[2];
    const readout = buildMessageReadingText(sampleVoice, {
      mode: "telegram",
      mine: true,
      authorName: "Вы",
      locale: "ru"
    });
    expect(readout).toContain("Ваше голосовое сообщение.");
    expect(readout).toContain("Длительность: 1 минута 9 секунд.");
    expect(readout).toContain("03:03.");
    expect(readout).toContain("Прочитано получателем, прослушано получателем.");
    expect(readout).not.toContain("Прочитано получателемПрослушано получателем");
    expect(readout).not.toMatch(/seven|minute|Nov/i);
  });

  test("formats Telegram-style incoming and outgoing text messages naturally", () => {
    const incoming = MESSAGE_READING_SAMPLE_ITEMS[0];
    const outgoing = MESSAGE_READING_SAMPLE_ITEMS[1];

    const incomingReadout = buildMessageReadingText(incoming, {
      mode: "telegram",
      mine: false,
      authorName: "Паша",
      locale: "ru"
    });
    expect(incomingReadout).toContain("Паша. Короче, всё заработало, можешь проверять!");
    expect(incomingReadout).toContain("23:31.");
    expect(incomingReadout).not.toContain("Прочитано получателем");

    const outgoingReadout = buildMessageReadingText(outgoing, {
      mode: "telegram",
      mine: true,
      authorName: "Вы",
      locale: "ru"
    });
    expect(outgoingReadout).toContain("Ваше сообщение. Отлично, сейчас посмотрю и напишу.");
    expect(outgoingReadout).toContain("Прочитано получателем.");
  });

  test("formats compact single-swipe mode cleanly for text, voice, and files", () => {
    const textReadout = buildMessageReadingText(MESSAGE_READING_SAMPLE_ITEMS[0], {
      mode: "single",
      mine: false,
      authorName: "Паша",
      locale: "ru"
    });
    expect(textReadout).toBe("Паша: Короче, всё заработало, можешь проверять!. 23:31");

    const fileMsg = {
      kind: "file",
      text: "Мастер-трек",
      createdAt: new Date(2026, 10, 24, 21, 15).getTime(),
      deliveredAt: new Date(2026, 10, 24, 21, 15).getTime(),
      file: { mediaKind: "audio", fileName: "studio-mix.flac", sizeBytes: 12 * 1024 * 1024 }
    };
    const fileReadout = buildMessageReadingText(fileMsg, {
      mode: "single",
      mine: true,
      authorName: "Вы",
      locale: "ru"
    });
    expect(fileReadout).toContain("Вы: аудиофайл studio-mix.flac, 12 МБ. Мастер-трек");
    expect(fileReadout).toContain("21:15, доставлено");
  });

  test("supports Belarusian localization for voice status and Telegram-style readouts", () => {
    const sampleVoice = MESSAGE_READING_SAMPLE_ITEMS[2];
    const beReadout = buildMessageReadingText(sampleVoice, {
      mode: "telegram",
      mine: true,
      authorName: "Вы",
      locale: "be",
      translate: translateBe
    });
    expect(beReadout).toContain("Ваша галасавое паведамленне.");
    expect(beReadout).toContain("Працягласць: 1 хвіліна 9 секунд.");
    expect(beReadout).toContain("Прачытана атрымальнікам, праслухана атрымальнікам.");
  });

  test("reports active listening and partial voice listening cleanly", () => {
    const activeVoice = {
      kind: "voice",
      readAt: Date.now(),
      voice: { durationMs: 45000, progress: { active: true, listenedMs: 12000 } }
    };
    expect(deliveryStatusSummary(activeVoice, { mine: true, verbose: true }))
      .toBe("прочитано получателем, сейчас слушает");

    const partialVoice = {
      kind: "voice",
      readAt: Date.now(),
      voice: { durationMs: 45000, progress: { active: false, listenedMs: 12000 } }
    };
    expect(deliveryStatusSummary(partialVoice, { mine: true, verbose: false }))
      .toBe("прочитано, прослушано 12 секунд");
  });

  test("exposes all 4 modes, live preview region, and shortcut button in Settings HTML", () => {
    expect(html).toContain('id="open-accessibility-reading"');
    expect(html).toContain('id="message-reading-mode"');
    expect(html).toContain('id="message-reading-mode-description"');
    expect(html).toContain('id="message-reading-preview"');
    for (const mode of MESSAGE_READING_MODES) {
      expect(html).toContain(`value="${mode}"`);
      expect(readingModeDescription(mode).length).toBeGreaterThan(20);
      expect(readingModeAnnouncement(mode).length).toBeGreaterThan(15);
    }
  });
});
