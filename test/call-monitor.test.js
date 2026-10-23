import { describe, expect, test } from "vitest";
import { describeCallDiagnostics, formatCallDuration, turnAvailable } from "../web/js/call-monitor.js";

describe("Call clock", () => {
  test("counts from server answer time and does not count waiting for an answer", () => {
    expect(formatCallDuration(null, 100000)).toBe("00:00");
    expect(formatCallDuration(10000, 10000)).toBe("00:00");
    expect(formatCallDuration(10000, 71234)).toBe("01:01");
    expect(formatCallDuration(10000, 3675234)).toBe("1:01:05");
    expect(formatCallDuration(10000, 9000)).toBe("00:00");
  });
});
describe("Call network diagnostics", () => {
  test("detects TURN configuration with multiple URL formats", () => {
    expect(turnAvailable([{ urls: "stun:stun.example.com" }])).toBe(false);
    expect(turnAvailable([{ urls: ["stun:stun.example.com", "turn:127.0.0.1:3478"] }])).toBe(true);
  });
  test("reports actual relay instead of claiming TURN just because it is configured", () => {
    const stats = new Map([
      ["transport", { id: "transport", type: "transport", selectedCandidatePairId: "pair" }],
      ["pair", { id: "pair", type: "candidate-pair", localCandidateId: "local", remoteCandidateId: "remote", currentRoundTripTime: 0.034 }],
      ["local", { id: "local", type: "local-candidate", candidateType: "relay", ip: "192.0.2.22" }],
      ["remote", { id: "remote", type: "remote-candidate", candidateType: "host" }],
      ["audio", { id: "audio", type: "inbound-rtp", kind: "audio", jitter: 0.012, packetsLost: 3 }]
    ]);
    const text = describeCallDiagnostics({ connectionState: "connected", iceConnectionState: "connected" }, stats);
    expect(text).toContain("через TURN-сервер");
    expect(text).toContain("34 мс");
    expect(text).toContain("Потеряно пакетов: 3");
    expect(text).not.toContain("192.0.2.22");
    stats.set("local", { candidateType: "host" });
    expect(describeCallDiagnostics({ connectionState: "connected" }, stats)).toContain("прямое соединение");
  });
});
