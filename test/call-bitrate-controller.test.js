import { describe, expect, test } from "vitest";
import {
  bitrateBounds,
  classifySenderNetwork,
  extractSenderNetworkSample,
  nextAdaptiveBitrate
} from "../web/js/call-bitrate-controller.js";

describe("adaptive call bitrate", () => {
  test("keeps a conservative floor while respecting the profile maximum", () => {
    expect(bitrateBounds({ maxBitrate: 64_000 })).toEqual({
      floorBitrate: 16_000,
      maxBitrate: 64_000
    });
    expect(bitrateBounds({ maxBitrate: 192_000 })).toEqual({
      floorBitrate: 48_000,
      maxBitrate: 192_000
    });
  });

  test("classifies severe loss or RTT immediately", () => {
    expect(classifySenderNetwork({ fractionLost: 0.09, roundTripTime: 0.1 })).toBe("severe");
    expect(classifySenderNetwork({ fractionLost: 0.01, roundTripTime: 0.5 })).toBe("severe");
    expect(classifySenderNetwork({ fractionLost: 0.03, roundTripTime: 0.12 })).toBe("degraded");
    expect(classifySenderNetwork({ fractionLost: 0.005, roundTripTime: 0.1 })).toBe("good");
    expect(classifySenderNetwork({ fractionLost: null, roundTripTime: null })).toBe("unknown");
  });

  test("cuts bitrate aggressively on a severe sample", () => {
    const next = nextAdaptiveBitrate({
      currentBitrate: 64_000,
      floorBitrate: 16_000,
      maxBitrate: 64_000,
      badSamples: 0,
      goodSamples: 0
    }, "severe");

    expect(next.currentBitrate).toBe(38_000);
    expect(next.goodSamples).toBe(0);
  });

  test("requires sustained moderate trouble before reducing bitrate", () => {
    const initial = {
      currentBitrate: 64_000,
      floorBitrate: 16_000,
      maxBitrate: 64_000,
      badSamples: 0,
      goodSamples: 0
    };
    const first = nextAdaptiveBitrate(initial, "degraded");
    const second = nextAdaptiveBitrate(first, "degraded");

    expect(first.currentBitrate).toBe(64_000);
    expect(second.currentBitrate).toBe(52_000);
  });

  test("raises bitrate only after several healthy samples", () => {
    let state = {
      currentBitrate: 24_000,
      floorBitrate: 16_000,
      maxBitrate: 64_000,
      badSamples: 0,
      goodSamples: 0
    };
    for (let index = 0; index < 4; index += 1) state = nextAdaptiveBitrate(state, "good");
    expect(state.currentBitrate).toBe(24_000);
    state = nextAdaptiveBitrate(state, "good");
    expect(state.currentBitrate).toBe(28_000);
  });

  test("uses remote receiver loss and RTT for the local outgoing stream", () => {
    const reports = new Map([
      ["remote", {
        type: "remote-inbound-rtp",
        kind: "audio",
        fractionLost: 0.04,
        roundTripTime: 0.31
      }],
      ["pair", {
        type: "candidate-pair",
        state: "succeeded",
        nominated: true,
        currentRoundTripTime: 0.2
      }]
    ]);

    expect(extractSenderNetworkSample(reports)).toEqual({
      fractionLost: 0.04,
      roundTripTime: 0.31
    });
  });

  test("does not treat missing browser metrics as a perfect network", () => {
    const reports = new Map([
      ["remote", {
        type: "remote-inbound-rtp",
        kind: "audio",
        fractionLost: null,
        roundTripTime: null
      }]
    ]);

    const sample = extractSenderNetworkSample(reports);
    expect(sample).toEqual({ fractionLost: null, roundTripTime: null });
    expect(classifySenderNetwork(sample)).toBe("unknown");
  });
});
