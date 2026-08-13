import { describe, expect, it } from "vitest";
import {
  normalizeFontScale,
  normalizeMessageView,
  normalizeTheme
} from "../web/js/interface-preferences.js";

describe("interface preferences", () => {
  it("accepts every supported message view", () => {
    expect(normalizeMessageView("bubbles")).toBe("bubbles");
    expect(normalizeMessageView("compact")).toBe("compact");
    expect(normalizeMessageView("table")).toBe("table");
  });

  it("falls back safely for unknown values", () => {
    expect(normalizeMessageView("cards")).toBe("bubbles");
    expect(normalizeTheme("neon")).toBe("system");
    expect(normalizeFontScale("giant")).toBe("medium");
  });

  it("accepts supported theme and font scale values", () => {
    expect(normalizeTheme("dark")).toBe("dark");
    expect(normalizeTheme("light")).toBe("light");
    expect(normalizeTheme("system")).toBe("system");
    expect(normalizeFontScale("small")).toBe("small");
    expect(normalizeFontScale("medium")).toBe("medium");
    expect(normalizeFontScale("large")).toBe("large");
  });
});
