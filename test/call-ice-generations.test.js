import { describe, expect, test } from "vitest";
import { classifyIceCandidate } from "../web/js/call-recovery-utils.js";

describe("ICE generation safety", () => {
  test("accept matching candidates and older clients lacking generation IDs", () => {
    expect(classifyIceCandidate("offer-b", "offer-b", true)).toBe("apply");
    expect(classifyIceCandidate(null, "offer-b", true)).toBe("apply");
    expect(classifyIceCandidate("offer-b", null, true)).toBe("apply");
  });
  test("buffer new callee-side candidates that can arrive before a new offer", () => {
    expect(classifyIceCandidate("offer-c", "offer-b", true)).toBe("queue");
  });
  test("drop stale candidate generations on the caller, which only receives answers", () => {
    expect(classifyIceCandidate("old-offer", "offer-c", false)).toBe("ignore");
  });
});
