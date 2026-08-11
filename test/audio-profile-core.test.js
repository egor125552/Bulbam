import { describe, expect, test } from "vitest";
import {
  buildAudioConstraints,
  getAudioProfile,
  normalizeAudioProfile,
  summarizeTrackSettings
} from "../web/js/audio-profile-core.js";

describe("call audio profiles", () => {
  test("builds a raw studio profile only from browser-supported constraints", () => {
    const constraints = buildAudioConstraints("studio", {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      sampleRate: true,
      channelCount: false
    });

    expect(constraints).toEqual({
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      sampleRate: { ideal: 48_000 }
    });
    expect(getAudioProfile("studio").maxBitrate).toBe(128_000);
  });

  test("asks for stereo and higher bitrate in music mode", () => {
    const constraints = buildAudioConstraints("music", null);
    expect(constraints.channelCount).toEqual({ ideal: 2 });
    expect(constraints.sampleRate).toEqual({ ideal: 48_000 });
    expect(getAudioProfile("music").maxBitrate).toBe(192_000);
  });

  test("reports when the browser kept speech processing enabled", () => {
    const summary = summarizeTrackSettings("studio", {
      echoCancellation: false,
      noiseSuppression: true,
      autoGainControl: false,
      sampleRate: 48_000,
      channelCount: 1
    });

    expect(summary.mismatches).toEqual(["шумоподавление"]);
    expect(summary.text).toContain("48 000 Гц");
  });

  test("falls back unknown stored profile to normal", () => {
    expect(normalizeAudioProfile("mystery")).toBe("normal");
  });
});
