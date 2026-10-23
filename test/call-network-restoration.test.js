import { describe, expect, test, vi } from "vitest";
import { createCallNetworkRestoration } from "../web/js/call-network-restoration.js";

describe("fast network restoration", () => {
  test("restores the moment online returns, not after 12 seconds", () => {
    const recover = vi.fn();
    const controller = createCallNetworkRestoration(recover);
    controller.offline();
    expect(controller.available("online", {active:true, connected:true})).toBe(true);
    expect(recover).toHaveBeenCalledExactlyOnceWith({reason:"browser-online",freshNetwork:true});
    expect(controller.available("connection-change", {active:true, connected:false})).toBe(false);
    expect(recover).toHaveBeenCalledTimes(1);
  });
  test("network change wakes a stuck ICE connection even without an offline event", () => {
    const recover = vi.fn();
    const controller = createCallNetworkRestoration(recover);
    expect(controller.available("connection-change", {active:true, connected:false})).toBe(true);
    expect(recover).toHaveBeenCalledWith({reason:"connection-change",freshNetwork:true});
  });
  test("online without an offline notification bypasses a stale ICE retry cooldown", () => {
    const recover = vi.fn();
    const controller = createCallNetworkRestoration(recover);
    controller.available("page-returned", {active:true,connected:false}, 10_000);
    expect(controller.available("online", {active:true, connected:false}, 10_030)).toBe(false);
    expect(controller.available("online", {active:true, connected:false}, 13_000)).toBe(true);
    expect(recover).toHaveBeenLastCalledWith({reason:"browser-online",freshNetwork:true});
  });
  test("does not renegotiate a healthy connected call after an unrelated event", () => {
    const recover = vi.fn();
    const controller = createCallNetworkRestoration(recover);
    expect(controller.available("online", {active:true, connected:true})).toBe(false);
    expect(controller.available("page-returned", {active:true, connected:true})).toBe(false);
    expect(recover).not.toHaveBeenCalled();
  });
  test("offline signal must not be consumed until there is an accepted call", () => {
    const recover = vi.fn();
    const controller = createCallNetworkRestoration(recover);
    controller.offline();
    expect(controller.available("online", {active:false, connected:false})).toBe(false);
    expect(controller.available("page-returned", {active:true, connected:true})).toBe(true);
    expect(recover).toHaveBeenCalledWith({reason:"page-returned",freshNetwork:true});
  });
  test("reset between calls prevents an old offline state leaking into the redial", () => {
    const recover = vi.fn();
    const controller = createCallNetworkRestoration(recover);
    controller.offline();
    controller.reset();
    expect(controller.available("online", {active:true,connected:true})).toBe(false);
  });
});
