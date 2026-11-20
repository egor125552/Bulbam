import { afterEach, describe, expect, test, vi } from "vitest";
import { createCallConnectionWatchdog } from "../web/js/call-connection-watchdog.js";
afterEach(() => vi.useRealTimers());
describe("Initial call connection watchdog", () => {
  test("recovers a call stalled in ICE checking even when no failed event fires", async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const watchdog = createCallConnectionWatchdog(onTimeout);
    watchdog.arm("call-one");
    watchdog.arm("call-one");
    await vi.advanceTimersByTimeAsync(11_999);
    expect(onTimeout).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onTimeout).toHaveBeenCalledExactlyOnceWith("call-one");
  });
  test("old call timer cannot trigger a retry during the next call", async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const watchdog = createCallConnectionWatchdog(onTimeout);
    watchdog.arm("old-call");
    await vi.advanceTimersByTimeAsync(5_000);
    watchdog.disarm();
    watchdog.arm("next-call");
    await vi.advanceTimersByTimeAsync(7_000);
    expect(onTimeout).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(onTimeout).toHaveBeenCalledExactlyOnceWith("next-call");
  });
  test("disarming on connection prevents false retry", async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const watchdog = createCallConnectionWatchdog(onTimeout);
    watchdog.arm("call-one");
    watchdog.disarm();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onTimeout).not.toHaveBeenCalled();
  });
});
