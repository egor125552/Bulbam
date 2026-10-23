import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

beforeEach(() => vi.resetModules());
afterEach(() => {
  vi.useRealTimers();
  delete globalThis.window;
});

function mockAudioContext({ suspended = false } = {}) {
  const oscillators = [];
  const envelopes = [];
  let resumed = 0;
  class AudioContextFake {
    state = suspended ? "suspended" : "running";
    currentTime = 0;
    destination = {};
    async resume() {
      resumed++;
      this.state = "running";
    }
    createOscillator() {
      const oscillator = {
        frequency: { value: 0 },
        type: "sine",
        connect() { return this; },
        start(at) { this.startedAt = at; this.wallTime = Date.now(); },
        stop(at) { this.stoppedAt = at; this.stopCount = (this.stopCount ?? 0) + 1; }
      };
      oscillators.push(oscillator);
      return oscillator;
    }
    createGain() {
      const changes = [];
      const gain = {
        gain: {
          setValueAtTime(value, at) { changes.push({ kind: "set", value, at }); },
          linearRampToValueAtTime(value, at) { changes.push({ kind: "ramp", value, at }); }
        },
        connect() { return this; }
      };
      envelopes.push(changes);
      return gain;
    }
  }
  globalThis.window = { AudioContext: AudioContextFake };
  return { oscillators, envelopes, get resumed() { return resumed; } };
}

describe("realistic outgoing telephone ringback", () => {
  test("plays a sustained 425 Hz ring for one second, then four seconds of silence", async () => {
    vi.useFakeTimers();
    const audio = mockAudioContext({ suspended: true });
    const { prepareRingback, startRingback, stopRingback } = await import("../web/js/call-ringback.js");

    expect(await prepareRingback()).toBe(true);
    expect(audio.resumed).toBe(1);

    startRingback();
    startRingback(); // duplicate setup must not layer sounds
    await Promise.resolve();

    expect(audio.oscillators).toHaveLength(1);
    expect(audio.oscillators[0].frequency.value).toBe(425);
    expect(audio.oscillators[0].type).toBe("sine");
    expect(audio.oscillators[0].stoppedAt - audio.oscillators[0].startedAt).toBeCloseTo(1, 1);

    const envelope = audio.envelopes[0];
    expect(envelope[0].value).toBeLessThan(0.001);
    expect(envelope.at(-1).value).toBeLessThan(0.001);
    expect(envelope.at(-1).at - envelope[0].at).toBeCloseTo(1, 1);

    await vi.advanceTimersByTimeAsync(4999);
    expect(audio.oscillators).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(audio.oscillators).toHaveLength(2);
    expect(audio.oscillators[1].frequency.value).toBe(425);

    stopRingback(); // answer, reject and hang-up must silence the cue
    expect(audio.oscillators.every((o) => o.stopCount >= 1)).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(audio.oscillators).toHaveLength(2);
  });

  test("cannot start a delayed tone after the call has ended", async () => {
    vi.useFakeTimers();
    const audio = mockAudioContext({ suspended: true });
    let allowResume;
    globalThis.window.AudioContext.prototype.resume = function () {
      return new Promise((resolve) => { allowResume = () => { this.state = "running"; resolve(); }; });
    };
    const { startRingback, stopRingback } = await import("../web/js/call-ringback.js");
    startRingback();
    stopRingback();
    allowResume();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(audio.oscillators).toHaveLength(0);
  });
});
