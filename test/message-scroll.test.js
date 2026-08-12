import { describe, expect, test } from "vitest";
import { chooseScrollTop, isNearBottomMetrics } from "../web/js/message-scroll.js";

describe("message scroll preservation", () => {
  test("sticks to the end only when the user was already near the end", () => {
    expect(isNearBottomMetrics(900, 500, 1450)).toBe(true);
    expect(isNearBottomMetrics(600, 500, 1450)).toBe(false);

    expect(chooseScrollTop({
      previousScrollTop: 900,
      clientHeight: 500,
      scrollHeight: 1700,
      stickToBottom: true
    })).toBe(1200);
  });

  test("keeps an older reading position across a background rerender", () => {
    expect(chooseScrollTop({
      previousScrollTop: 420,
      clientHeight: 500,
      scrollHeight: 1900,
      stickToBottom: false
    })).toBe(420);
  });

  test("clamps a preserved position when the list becomes shorter", () => {
    expect(chooseScrollTop({
      previousScrollTop: 1300,
      clientHeight: 500,
      scrollHeight: 1100,
      stickToBottom: false
    })).toBe(600);
  });
});
