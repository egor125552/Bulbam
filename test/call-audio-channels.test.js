import { describe, expect, test, vi } from "vitest";
import { preferMonoCallCapture } from "../web/js/call-audio-channels.js";

describe("call audio channels", () => {
  test("forces a two-channel speech capture to mono", async () => {
    const applyConstraints = vi.fn().mockResolvedValue(undefined);
    const track = {
      getSettings: () => ({ channelCount: 2 }),
      applyConstraints
    };

    await expect(preferMonoCallCapture(track, "normal")).resolves.toBe(true);
    expect(applyConstraints).toHaveBeenCalledOnce();
    expect(applyConstraints).toHaveBeenCalledWith({ channelCount: 1 });
  });

  test("keeps music mode stereo", async () => {
    const applyConstraints = vi.fn();
    const track = {
      getSettings: () => ({ channelCount: 2 }),
      applyConstraints
    };

    await expect(preferMonoCallCapture(track, "music")).resolves.toBe(false);
    expect(applyConstraints).not.toHaveBeenCalled();
  });

  test("does not touch an already mono track", async () => {
    const applyConstraints = vi.fn();
    const track = {
      getSettings: () => ({ channelCount: 1 }),
      applyConstraints
    };

    await expect(preferMonoCallCapture(track, "clean")).resolves.toBe(false);
    expect(applyConstraints).not.toHaveBeenCalled();
  });

  test("does not break the call if the browser rejects mono", async () => {
    const track = {
      getSettings: () => ({ channelCount: 2 }),
      applyConstraints: vi.fn().mockRejectedValue(new Error("unsupported"))
    };

    await expect(preferMonoCallCapture(track, "studio")).resolves.toBe(false);
  });
});
