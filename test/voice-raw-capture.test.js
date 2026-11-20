import { describe, expect, test, vi } from "vitest";
import { rawVoiceConstraints, keepVoiceRaw } from "../web/js/voice-raw-capture.js";

describe("raw voice message capture", () => {
  test("requests no processing at 48 kHz and optional stereo, never forces mono", () => {
    expect(rawVoiceConstraints()).toEqual({echoCancellation:false,noiseSuppression:false,autoGainControl:false,sampleRate:{ideal:48000},channelCount:{ideal:2}});
    expect(rawVoiceConstraints({echoCancellation:true,noiseSuppression:true,autoGainControl:true,channelCount:false,sampleRate:true})).not.toHaveProperty("channelCount");
  });
  test("enforces raw settings and reports what hardware actually did", async () => {
    const navigatorBefore = globalThis.navigator;
    Object.defineProperty(globalThis,"navigator",{value:{mediaDevices:{getSupportedConstraints:()=>({echoCancellation:true,noiseSuppression:true,autoGainControl:true})}},configurable:true});
    try {
      const track={contentHint:"speech",applyConstraints:vi.fn().mockResolvedValue(undefined),getSettings:()=>({echoCancellation:false,noiseSuppression:false,autoGainControl:false})};
      const result=await keepVoiceRaw(track);
      expect(result.confirmed).toBe(true);
      expect(track.contentHint).toBe("music");
      expect(track.applyConstraints).toHaveBeenCalledWith({echoCancellation:false,noiseSuppression:false,autoGainControl:false});
    } finally { if(navigatorBefore===undefined)delete globalThis.navigator; else Object.defineProperty(globalThis,"navigator",{value:navigatorBefore,configurable:true}); }
  });
  test("does not falsely promise that Android/iOS disabled all processing", async () => {
    const track={getSettings:()=>({echoCancellation:true}),applyConstraints:vi.fn().mockRejectedValue(Error("ignored"))};
    const result=await keepVoiceRaw(track);
    expect(result.confirmed).toBe(false);
    expect(result.summary).toContain("echoCancellation on");
  });
});
