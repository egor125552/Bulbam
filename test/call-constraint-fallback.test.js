import { describe, expect, test, vi } from "vitest";
import { applyCallConstraintsBestEffort } from "../web/js/call-constraint-fallback.js";
const full = {channelCount: {ideal: 2}, sampleRate: {ideal: 48000}, echoCancellation:false,noiseSuppression:false,autoGainControl:false};
describe("switching profiles on existing Android microphone", () => {
  test("fallback retains all three requested processing flags when channel switch is unsupported", async () => {
    const track = { applyConstraints:vi.fn().mockRejectedValueOnce(Object.assign(Error("unsupported stereo"),{name:"OverconstrainedError"})).mockResolvedValueOnce(undefined) };
    const result = await applyCallConstraintsBestEffort(track, full);
    expect(result).toEqual({applied:true,reduced:true});
    expect(track.applyConstraints).toHaveBeenNthCalledWith(2,{echoCancellation:false,noiseSuppression:false,autoGainControl:false});
  });
  test("successful full settings remain unchanged", async () => {
    const track={applyConstraints:vi.fn().mockResolvedValue(undefined)};
    expect(await applyCallConstraintsBestEffort(track,full)).toEqual({applied:true,reduced:false});
    expect(track.applyConstraints).toHaveBeenCalledTimes(1);
  });
  test("uses individual audio flags if the browser rejects their combination", async () => {
    const track = {applyConstraints:vi.fn()
      .mockRejectedValueOnce(Object.assign(Error("stereo unsupported"),{name:"OverconstrainedError"}))
      .mockRejectedValueOnce(Object.assign(Error("combined settings unsupported"),{name:"OverconstrainedError"}))
      .mockRejectedValueOnce(Object.assign(Error("echo cannot change"),{name:"OverconstrainedError"}))
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)};
    const result=await applyCallConstraintsBestEffort(track,full);
    expect(result).toEqual({applied:true,reduced:true});
    expect(track.applyConstraints).toHaveBeenNthCalledWith(3,{echoCancellation:false});
    expect(track.applyConstraints).toHaveBeenNthCalledWith(4,{noiseSuppression:false});
    expect(track.applyConstraints).toHaveBeenNthCalledWith(5,{autoGainControl:false});
  });
  test("both failures propagate so UI never falsely reports success", async () => {
    const track={applyConstraints:vi.fn().mockRejectedValue(Error("blocked"))};
    await expect(applyCallConstraintsBestEffort(track,full)).rejects.toThrow("blocked");
    expect(track.applyConstraints).toHaveBeenCalledTimes(5);
  });
});
