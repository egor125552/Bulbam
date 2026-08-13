import { describe, expect, test } from "vitest";
import {
  isAppleWebKitVoiceEnvironment,
  isWebMVoiceContentType
} from "../web/js/voice-webkit-timeline.js";

describe("WebKit voice playback workaround", () => {
  test("targets Safari on macOS and WebKit browsers on iOS", () => {
    const macSafari = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.3 Safari/605.1.15";
    const iphoneSafari = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";
    const macChrome = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

    expect(isAppleWebKitVoiceEnvironment(macSafari, "Apple Computer, Inc.")).toBe(true);
    expect(isAppleWebKitVoiceEnvironment(iphoneSafari, "Apple Computer, Inc.")).toBe(true);
    expect(isAppleWebKitVoiceEnvironment(macChrome, "Google Inc.")).toBe(false);
  });

  test("materializes only WebM voice responses", () => {
    expect(isWebMVoiceContentType("audio/webm;codecs=opus")).toBe(true);
    expect(isWebMVoiceContentType("audio/webm")).toBe(true);
    expect(isWebMVoiceContentType("audio/ogg;codecs=opus")).toBe(false);
    expect(isWebMVoiceContentType("audio/mp4")).toBe(false);
  });
});
