import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { validateVoiceStart } from "../worker/src/modules/media/domain/validation";

describe("Android voice format compatibility", () => {
  test("server accepts MP4 voice uploads", () => {
    expect(validateVoiceStart({ mimeType: "audio/mp4", bitrateBps: 64_000 })).toEqual({
      mimeType: "audio/mp4",
      bitrateBps: 64_000
    });
  });

  test("Android prefers MP4 before WebM while other platforms keep the existing order", () => {
    const source = readFileSync(new URL("../web/js/voice-recorder.js", import.meta.url), "utf8");
    expect(source).toContain("/android/i.test(navigator.userAgent)");
    expect(source).toContain('["audio/mp4", "audio/webm;codecs=opus", "audio/ogg;codecs=opus"]');
    expect(source).toContain(': ["audio/webm;codecs=opus", "audio/ogg;codecs=opus"]');
  });
});
