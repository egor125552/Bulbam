import { describe, expect, test } from "vitest";
import { shouldPreferOggOnApple } from "../web/js/voice-apple-recording.js";

describe("Apple voice recording preference", () => {
  test("prefers Ogg only when Safari reports native Ogg Opus recording support", () => {
    expect(shouldPreferOggOnApple((mime) => mime === "audio/ogg;codecs=opus")).toBe(true);
    expect(shouldPreferOggOnApple(() => false)).toBe(false);
  });
});
