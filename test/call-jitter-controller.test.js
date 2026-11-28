import { describe, expect, test } from "vitest";
import {
  JITTER_BUFFER_ELEVATED_MS,
  JITTER_BUFFER_HIGH_MS,
  applyJitterBufferTarget,
  createJitterBufferController,
  formatJitterBufferLabel
} from "../web/js/call-jitter-controller.js";

describe("call jitter buffer controller", () => {
  test("starts at auto (null) and requires 2 consecutive degraded samples before stepping up", () => {
    const ctrl = createJitterBufferController();
    expect(ctrl.targetMs).toBeNull();
    expect(formatJitterBufferLabel(null)).toBe("авто");

    // Single transient jitter/loss spike does not jump the buffer immediately.
    expect(ctrl.onStatsSample({ packetDelta: 50, lossRate: 0.04, jitterMs: 55 })).toEqual({
      targetMs: null,
      changed: false
    });
    expect(ctrl.targetMs).toBeNull();

    // Second consecutive degraded sample steps up to elevated (120 ms).
    expect(ctrl.onStatsSample({ packetDelta: 50, lossRate: 0.04, jitterMs: 55 })).toEqual({
      targetMs: JITTER_BUFFER_ELEVATED_MS,
      changed: true
    });
    expect(ctrl.targetMs).toBe(JITTER_BUFFER_ELEVATED_MS);
    expect(formatJitterBufferLabel(JITTER_BUFFER_ELEVATED_MS)).toBe("120 мс");
  });

  test("escalates immediately on severe packet loss or high jitter and resets smoothly on recovery", () => {
    const ctrl = createJitterBufferController();

    // Severe loss jumps immediately to high (240 ms) without waiting for 2 samples.
    expect(ctrl.onStatsSample({ packetDelta: 40, lossRate: 0.12, jitterMs: 95 })).toEqual({
      targetMs: JITTER_BUFFER_HIGH_MS,
      changed: true
    });
    expect(ctrl.targetMs).toBe(JITTER_BUFFER_HIGH_MS);

    // 1 healthy sample is not enough yet (anti-flapping hysteresis).
    expect(ctrl.onStatsSample({ packetDelta: 50, lossRate: 0.0, jitterMs: 18 })).toEqual({
      targetMs: JITTER_BUFFER_HIGH_MS,
      changed: false
    });
    // 2nd consecutive healthy sample steps down 240 -> 120.
    expect(ctrl.onStatsSample({ packetDelta: 50, lossRate: 0.0, jitterMs: 18 })).toEqual({
      targetMs: JITTER_BUFFER_ELEVATED_MS,
      changed: true
    });
    expect(ctrl.targetMs).toBe(JITTER_BUFFER_ELEVATED_MS);

    // Next 2 consecutive healthy samples step down 120 -> auto (null).
    expect(ctrl.onStatsSample({ packetDelta: 50, lossRate: 0.005, jitterMs: 22 })).toEqual({
      targetMs: JITTER_BUFFER_ELEVATED_MS,
      changed: false
    });
    expect(ctrl.onStatsSample({ packetDelta: 50, lossRate: 0.005, jitterMs: 22 })).toEqual({
      targetMs: null,
      changed: true
    });
    expect(ctrl.targetMs).toBeNull();
  });

  test("relaxes cleanly on steady TURN relay links even with 50-60ms jitter", () => {
    const ctrl = createJitterBufferController();
    expect(ctrl.onNetworkStress("severe")).toEqual({
      targetMs: JITTER_BUFFER_HIGH_MS,
      changed: true
    });

    // Recovered connect immediately lowers 240 -> 120 so voice doesn't stay laggy.
    expect(ctrl.onConnected({ recovered: true })).toEqual({
      targetMs: JITTER_BUFFER_ELEVATED_MS,
      changed: true
    });

    // Steady TURN link with 0.5% loss and 55 ms jitter steps down 120 -> null after 2 samples.
    expect(ctrl.onStatsSample({ packetDelta: 50, lossRate: 0.005, jitterMs: 55 })).toEqual({
      targetMs: JITTER_BUFFER_ELEVATED_MS,
      changed: false
    });
    expect(ctrl.onStatsSample({ packetDelta: 50, lossRate: 0.005, jitterMs: 55 })).toEqual({
      targetMs: null,
      changed: true
    });
    expect(ctrl.targetMs).toBeNull();
  });

  test("clean connect and full reset always clear stuck buffer targets", () => {
    const ctrl = createJitterBufferController();
    ctrl.onNetworkStress("severe");
    expect(ctrl.targetMs).toBe(JITTER_BUFFER_HIGH_MS);

    expect(ctrl.onConnected({ recovered: false })).toEqual({
      targetMs: null,
      changed: true
    });
    expect(ctrl.targetMs).toBeNull();

    ctrl.onNetworkStress("mild");
    expect(ctrl.targetMs).toBe(JITTER_BUFFER_ELEVATED_MS);
    expect(ctrl.reset()).toEqual({ targetMs: null, changed: true });
    expect(ctrl.targetMs).toBeNull();
  });

  test("ignores zero-packet samples so muted/quiet pauses never lock or flap buffer", () => {
    const ctrl = createJitterBufferController();
    ctrl.onNetworkStress("mild");
    expect(ctrl.onStatsSample({ packetDelta: 0, lossRate: 0, jitterMs: 0 })).toEqual({
      targetMs: JITTER_BUFFER_ELEVATED_MS,
      changed: false
    });
    expect(ctrl.onStatsSample({ packetDelta: 0, lossRate: 0.5, jitterMs: 500 })).toEqual({
      targetMs: JITTER_BUFFER_ELEVATED_MS,
      changed: false
    });
    expect(ctrl.targetMs).toBe(JITTER_BUFFER_ELEVATED_MS);
  });

  test("applyJitterBufferTarget sets ms, falls back to 0 when null throws, and supports legacy playoutDelayHint", () => {
    const normalReceiver = { jitterBufferTarget: 120 };
    expect(applyJitterBufferTarget(normalReceiver, 240)).toBe(true);
    expect(normalReceiver.jitterBufferTarget).toBe(240);
    expect(applyJitterBufferTarget(normalReceiver, null)).toBe(true);
    expect(normalReceiver.jitterBufferTarget).toBeNull();

    let stored = 120;
    const strictReceiver = {};
    Object.defineProperty(strictReceiver, "jitterBufferTarget", {
      get: () => stored,
      set: (value) => {
        if (value === null) throw new TypeError("null not supported");
        stored = value;
      },
      enumerable: true,
      configurable: true
    });
    expect(applyJitterBufferTarget(strictReceiver, null)).toBe(true);
    expect(stored).toBe(0);

    const legacyReceiver = { playoutDelayHint: 0.1 };
    expect(applyJitterBufferTarget(legacyReceiver, 120)).toBe(true);
    expect(legacyReceiver.playoutDelayHint).toBe(0.12);
    expect(applyJitterBufferTarget(legacyReceiver, null)).toBe(true);
    expect(legacyReceiver.playoutDelayHint).toBe(0);

    expect(applyJitterBufferTarget(null, 120)).toBe(false);
    expect(applyJitterBufferTarget({}, 120)).toBe(false);
  });
});
