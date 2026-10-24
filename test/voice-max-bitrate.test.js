import { describe, expect, test } from "vitest";
import { validateVoiceStart } from "../worker/src/modules/media/domain/validation.ts";
describe("highest-quality unprocessed voice recordings", () => {
  test("server accepts 192 kbps and keeps lower-quality compatibility", () => {
    for (const bitrateBps of [24000,32000,48000,64000,96000,192000]) {
      expect(validateVoiceStart({mimeType:"audio/webm;codecs=opus",bitrateBps})).toEqual({mimeType:"audio/webm;codecs=opus",bitrateBps});
    }
  });
  test("unknown codec bitrate is still rejected", () => {
    expect(()=>validateVoiceStart({mimeType:"audio/mp4",bitrateBps:512000})).toThrow();
  });
});
