import { afterEach, describe, expect, test, vi } from "vitest";
import { clearCallLog, getCallLogText, logCallEvent, startCallTrace, subscribeCallLog } from "../web/js/call-event-log.js";
afterEach(() => clearCallLog());
describe("Private WebRTC call journal", () => {
  test("shows separate calls and carries traces over a failed redial", () => {
    startCallTrace("outgoing");
    logCallEvent("ICE состояние", "checking");
    logCallEvent("звонок завершён");
    startCallTrace("outgoing");
    logCallEvent("таймер подключения истёк", "12 s");
    const text = getCallLogText();
    expect(text).toContain("№1, исходящий");
    expect(text).toContain("№2, исходящий");
    expect(text).toContain("таймер подключения истёк");
  });
  test("refuses unknown message fields or confidential addresses", () => {
    logCallEvent("ICE ошибка", "192.168.12.4");
    logCallEvent("ICE ошибка", "123e4567-e89b-12d3-a456-426614174000");
    logCallEvent("ICE ошибка", "candidate: secret");
    logCallEvent("arbitrary string from caller", "not allowed");
    expect(getCallLogText()).not.toContain("192.168.");
    expect(getCallLogText()).not.toContain("123e4567");
    expect(getCallLogText()).not.toContain("secret");
    expect(getCallLogText()).not.toContain("arbitrary string");
  });
  test("updates an accessible read-only log and retains a bounded history", () => {
    const update = vi.fn();
    const off = subscribeCallLog(update);
    for (let i = 0; i < 250; i++) logCallEvent("ICE состояние", "checking");
    expect(getCallLogText().split("\n").length).toBeLessThanOrEqual(180);
    expect(update).toHaveBeenCalled();
    off();
  });
});
