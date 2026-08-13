import { describe, expect, test } from "vitest";
import {
  effectiveVoicePositionMs,
  voiceSeekTargetMs
} from "../web/js/voice-position.js";

describe("voice playback position", () => {
  test("keeps saved resume while the media element still reports zero", () => {
    expect(effectiveVoicePositionMs(0, 80_000)).toBe(80_000);
  });

  test("uses the real media position after playback or seek has moved", () => {
    expect(effectiveVoicePositionMs(12.5, 80_000)).toBe(12_500);
  });

  test("seeks from saved resume before first playback and clamps to duration", () => {
    expect(voiceSeekTargetMs(0, 80_000, 15, 120_000)).toBe(95_000);
    expect(voiceSeekTargetMs(0, 5_000, -15, 120_000)).toBe(0);
    expect(voiceSeekTargetMs(0, 115_000, 15, 120_000)).toBe(120_000);
  });
});
