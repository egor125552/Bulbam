import { describe, expect, test, vi } from "vitest";
import { createCallHeadsetControls } from "../web/js/call-headset-controls.js";

function fakeSession(supported = null) {
  const actions = new Map();
  const session = {
    actions,
    playbackState: "none",
    setMicrophoneActive: vi.fn(),
    setActionHandler(name, handler) {
      if (supported && !supported.includes(name)) throw new Error("Unsupported");
      if (handler) actions.set(name, handler);
      else actions.delete(name);
    }
  };
  return session;
}

describe("headset and OS call controls", () => {
  test("headset mic toggle, pause/play and hangup control the active call", () => {
    const session = fakeSession();
    const onMute = vi.fn();
    const onHangup = vi.fn();
    const controls = createCallHeadsetControls({ mediaSession: session }, { onMute, onHangup });
    expect(controls.activate(false)).toBe(true);
    expect(session.playbackState).toBe("playing");
    session.actions.get("togglemicrophone")();
    expect(onMute).toHaveBeenLastCalledWith(true);
    controls.updateMuted(true);
    expect(session.setMicrophoneActive).toHaveBeenLastCalledWith(false);
    expect(session.playbackState).toBe("paused");
    session.actions.get("play")();
    expect(onMute).toHaveBeenLastCalledWith(false);
    controls.updateMuted(false);
    session.actions.get("pause")();
    expect(onMute).toHaveBeenLastCalledWith(true);
    session.actions.get("hangup")();
    expect(onHangup).toHaveBeenCalledTimes(1);
    controls.deactivate();
    expect(session.playbackState).toBe("none");
    expect(session.actions.size).toBe(0);
  });
  test("unsupported media actions do not prevent mute of the microphone", () => {
    const session = fakeSession(["play", "pause"]);
    const onMute = vi.fn();
    const controls = createCallHeadsetControls({ mediaSession: session }, { onMute });
    expect(controls.activate(false)).toBe(true);
    session.actions.get("pause")();
    expect(onMute).toHaveBeenCalledWith(true);
    expect(() => controls.deactivate()).not.toThrow();
  });
  test("without Media Session, button mute remains available", () => {
    const controls = createCallHeadsetControls({}, { onMute: () => {} });
    expect(controls.activate(false)).toBe(false);
    expect(() => controls.updateMuted(true)).not.toThrow();
    expect(() => controls.deactivate()).not.toThrow();
  });
  test("stale headset commands after ending a call are ignored", () => {
    const session = fakeSession();
    const onMute = vi.fn();
    const controls = createCallHeadsetControls({mediaSession:session}, {onMute});
    controls.activate(false);
    const old = session.actions.get("togglemicrophone");
    controls.deactivate();
    old();
    expect(onMute).not.toHaveBeenCalled();
  });
});
