import { describe, expect, test } from "vitest";
import {
  chatPreview,
  chatAccessibleLabel,
  chatTimeLabel,
  dayLabel,
  dayKey,
  isNearBottom,
  messageTime
} from "../web/js/chat-presentation.js";

const now = new Date("2026-10-18T13:00:00");

describe("human-readable chat previews", () => {
  test("announces a voice message instead of a blank preview", () => {
    expect(chatPreview({ kind: "voice", senderUserId: "me" }, "me")).toBe("Вы: Голосовое сообщение");
    expect(chatPreview({ kind: "voice", senderUserId: "other" }, "me")).toBe("Голосовое сообщение");
  });
  test("trims long text and mentions who wrote it", () => {
    const preview = chatPreview({ kind: "text", senderUserId: "me", text: "  Привет\\n ещё раз  " }, "me");
    expect(preview).toBe("Вы: Привет ещё раз");
    expect(chatPreview(null, "me")).toBe("Начните переписку");
    expect(chatPreview({ kind: "text", senderUserId: "other", text: "а".repeat(160) }, "me").length).toBeLessThan(85);
  });
  test("builds a meaningful button name and does not invent read receipts", () => {
    const chat = {
      peer: { displayName: "Ева", username: "eva" },
      lastMessage: { kind: "voice", senderUserId: "other", createdAt: now.getTime() }
    };
    expect(chatAccessibleLabel(chat, "me", now)).toContain("Ева");
    expect(chatAccessibleLabel(chat, "me", now)).toContain("Голосовое сообщение");
    expect(chatAccessibleLabel(chat, "me", now)).not.toContain("прочитано");
  });
});

describe("message presentation", () => {
  test("formats today, yesterday and older chat activity", () => {
    expect(chatTimeLabel(new Date("2026-10-18T10:20:00").getTime(), now)).toMatch(/10:20/);
    expect(chatTimeLabel(new Date("2026-10-17T18:20:00").getTime(), now)).toBe("вчера");
    expect(chatTimeLabel(new Date("2026-10-15T10:20:00").getTime(), now)).toMatch(/15/);
  });
  test("builds day separators for messages", () => {
    expect(dayLabel(now.getTime(), now)).toBe("Сегодня");
    expect(dayLabel(new Date("2026-10-17T12:00:00").getTime(), now)).toBe("Вчера");
    expect(dayKey(now.getTime())).toBe("2026-10-18");
    expect(messageTime(now.getTime())).toMatch(/13:00/);
  });
  test("preserves scroll position while the user reads older messages", () => {
    expect(isNearBottom({ scrollTop: 50, scrollHeight: 1500, clientHeight: 500 })).toBe(false);
    expect(isNearBottom({ scrollTop: 975, scrollHeight: 1500, clientHeight: 500 })).toBe(true);
    expect(isNearBottom({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 })).toBe(true);
  });
});
