import { describe, expect, test } from "vitest";
import { createRequestEpoch, matchesCallResponse } from "../web/js/call-request-guards.js";
describe("Second call cannot reuse first call's async responses", () => {
  test("ignores a late state poll for the previous call even if the new call is active", () => {
    const first = "00000000-0000-4000-8000-000000000001";
    const second = "00000000-0000-4000-8000-000000000002";
    expect(matchesCallResponse({ callId: first }, first, { callId: first })).toBe(true);
    expect(matchesCallResponse({ callId: second }, first, { callId: first })).toBe(false);
    expect(matchesCallResponse({ callId: second }, second, { callId: first })).toBe(false);
    expect(matchesCallResponse({ callId: second }, second, { callId: second })).toBe(true);
  });
  test("invalidates pending TURN/STUN responses on hangup and forced refresh", () => {
    const epochs = createRequestEpoch();
    const oldTurnRequest = epochs.token();
    epochs.invalidate();
    const newTurnRequest = epochs.token();
    expect(epochs.isCurrent(oldTurnRequest)).toBe(false);
    expect(epochs.isCurrent(newTurnRequest)).toBe(true);
    epochs.invalidate();
    expect(epochs.isCurrent(newTurnRequest)).toBe(false);
  });
});
