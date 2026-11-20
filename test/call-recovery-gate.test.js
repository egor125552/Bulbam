import { describe, expect, test } from "vitest";
import { createRecoveryGate } from "../web/js/call-recovery-gate.js";

describe("WebRTC reconnect storms", () => {
  test("coalesces same-second resume, ICE failure and watchdog requests", () => {
    const gate = createRecoveryGate(11_000);
    expect(gate.admit("call-one", 1_000)).toBe(true);
    expect(gate.admit("call-one", 1_001)).toBe(false);
    expect(gate.admit("call-one", 4_000)).toBe(false);
    expect(gate.admit("call-one", 11_999)).toBe(false);
    expect(gate.admit("call-one", 12_000)).toBe(true);
  });
  test("a distinct redial can immediately recover; resetting on hangup is safe", () => {
    const gate = createRecoveryGate();
    expect(gate.admit("old", 1_000)).toBe(true);
    expect(gate.admit("new", 1_001)).toBe(true);
    gate.reset();
    expect(gate.admit("new", 1_002)).toBe(true);
  });
});
