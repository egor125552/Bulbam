import { describe, expect, test, vi } from "vitest";
import { describeCallQuality, setupCallQualityReport } from "../web/js/call-quality-report.js";

function stats({ received = 200, lost = 1, jitter = 0.006, rtt = 0.1 } = {}) {
  return new Map([
    ["incoming", {
      id: "incoming", type: "inbound-rtp", kind: "audio",
      packetsReceived: received, packetsLost: lost, jitter
    }],
    ["network", {
      id: "network", type: "candidate-pair", state: "succeeded",
      nominated: true, currentRoundTripTime: rtt
    }]
  ]);
}

function controls(connection) {
  const button = {
    hidden: false, disabled: false,
    addEventListener: vi.fn()
  };
  const status = { textContent: "" };
  const getPeerConnection = vi.fn(() => connection);
  const report = setupCallQualityReport({ button, status, getPeerConnection });
  return { button, status, getPeerConnection, report };
}

describe("on-demand audio call quality report", () => {
  test("explains good inbound audio using actual statistics", () => {
    const report = describeCallQuality(stats());
    expect(report.level).toBe("good");
    expect(report.text).toContain("Качество входящего звука: хорошее");
    expect(report.text).toContain("потери звуковых пакетов 0,5%");
    expect(report.text).toContain("отклик сети 100 мс");
  });

  test("reports moderate jitter even when packet loss is low", () => {
    const report = describeCallQuality(stats({ jitter: 0.05 }));
    expect(report.level).toBe("unstable");
    expect(report.text).toContain("колебания задержки 50 мс");
  });

  test("reports severe packet loss without hiding it behind good RTT", () => {
    const report = describeCallQuality(stats({ received: 90, lost: 10 }));
    expect(report.level).toBe("poor");
    expect(report.text).toContain("потери звуковых пакетов 10,0%");
  });

  test("does not present a fresh call with no audio as good", () => {
    const report = describeCallQuality(stats({ received: 0, lost: 0, jitter: 0 }));
    expect(report.level).toBe("unknown");
    expect(report.text).toContain("недостаточно данных");
  });

  test("does not invent unavailable network metrics", () => {
    const report = describeCallQuality(new Map([
      ["incoming", { type: "inbound-rtp", kind: "audio", packetsReceived: 120 }]
    ]));
    expect(report.level).toBe("unknown");
    expect(report.text).not.toContain("0,0%");
  });

  test("does not read microphone or send statistics to the server", async () => {
    const connection = { connectionState: "connected", getStats: vi.fn(async () => stats()) };
    const { button, status, report } = controls(connection);
    await report.check();
    expect(connection.getStats).toHaveBeenCalledOnce();
    expect(status.textContent).toContain("Качество входящего звука");
    expect(button.disabled).toBe(false);
    expect(button.addEventListener).toHaveBeenCalledWith("click", expect.any(Function));
  });

  test("does not report a disconnected call as healthy", async () => {
    const connection = { connectionState: "disconnected", getStats: vi.fn() };
    const { status, report } = controls(connection);
    await report.check();
    expect(connection.getStats).not.toHaveBeenCalled();
    expect(status.textContent).toContain("восстанавливается");
  });

  test("ignores a delayed result after a call ends", async () => {
    let release;
    const connection = { connectionState: "connected", getStats: () =>
      new Promise((resolve) => { release = resolve; }) };
    const { status, button, report } = controls(connection);
    const pending = report.check();
    button.hidden = true;
    status.textContent = "";
    release(stats());
    await pending;
    expect(status.textContent).toBe("");
    expect(button.disabled).toBe(false);
  });

  test("handles browsers that reject WebRTC statistics", async () => {
    const connection = {
      connectionState: "connected",
      getStats: vi.fn(async () => { throw new Error("unsupported"); })
    };
    const { status, button, report } = controls(connection);
    await report.check();
    expect(status.textContent).toContain("Не получилось измерить");
    expect(button.disabled).toBe(false);
  });
});
