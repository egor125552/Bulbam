import { afterEach, describe, expect, test, vi } from "vitest";
import { prepareCallCues, playCallCue, stopCallCues, resetCallCueAudio } from "../web/js/call-cues.js";
afterEach(() => { resetCallCueAudio(); delete globalThis.window; });
describe("call event feedback", () => {
  test("iOS interrupted AudioContext is resumed, and a stale context is replaced after return", async () => {
    let creations = 0;
    let resumes = 0;
    class MockAudio {
      state = "interrupted";
      constructor() { creations++; }
      resume() { resumes++; this.state = "running"; return Promise.resolve(); }
      close() { this.state = "closed"; return Promise.resolve(); }
    }
    globalThis.window = { AudioContext: MockAudio };
    expect(await prepareCallCues()).toBe(true);
    expect(resumes).toBe(1);
    resetCallCueAudio();
    expect(await prepareCallCues()).toBe(true);
    expect(creations).toBe(2);
  });
  test("answer, established audio, declined and hang-up have separate gentle tones", async () => {
    const tones = [];
    class MockAudio {
      state = "running";
      currentTime = 1;
      destination = {};
      createOscillator() {
        const tone = { frequency: { value: 0 }, connect() { return this; },
          start() { tones.push(tone.frequency.value); }, stop() {} };
        return tone;
      }
      createGain() {
        return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {} },
          connect() { return this; } };
      }
    }
    globalThis.window = { AudioContext: MockAudio };
    expect(await prepareCallCues()).toBe(true);
    for (const state of ["answered", "connected", "declined", "ended"]) {
      const before = tones.length;
      playCallCue(state);
      await Promise.resolve();
      expect(tones.length).toBeGreaterThan(before);
    }
    expect(new Set(tones).size).toBeGreaterThan(4);
  });
});
