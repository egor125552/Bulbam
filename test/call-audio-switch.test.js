import { describe, expect, test, vi } from "vitest";
import { switchCallAudioProfile, mediaErrorCategory } from "../web/js/call-audio-switch.js";

const stream = () => { const track = {kind: "audio", enabled: true}; return {getAudioTracks: () => [track]}; };
const valid = () => true;
describe("live call audio profile fallback", () => {
  test("retries on the still-active microphone when Android rejects a second capture", async () => {
    const existing = stream();
    const applyExisting = vi.fn().mockResolvedValue({mismatches: [], unknown: []});
    const acquire = vi.fn().mockRejectedValue(Object.assign(new Error("private device name"), {name: "NotReadableError"}));
    const sender = { replaceTrack: vi.fn() };
    const result = await switchCallAudioProfile({ oldStream: existing, sender, acquire, applyExisting, isCurrent: valid });
    expect(result).toEqual({status: "fallback", captureError: "NotReadableError", result: {mismatches: [], unknown: []}});
    expect(applyExisting).toHaveBeenCalledWith(existing.getAudioTracks()[0]);
    expect(sender.replaceTrack).not.toHaveBeenCalled();
  });
  test("recovers when replaceTrack rejects an incompatible stereo or mono track", async () => {
    const existing = stream();
    const acquired = {getAudioTracks: () => [track], getTracks: () => [track]};
    const track = {kind: "audio", stop: vi.fn(), enabled: true};
    const applyExisting = vi.fn().mockResolvedValue({mismatches: ["каналы"]});
    const result = await switchCallAudioProfile({ oldStream:existing, sender: {replaceTrack: vi.fn().mockRejectedValue(Object.assign(new Error("bad"), {name: "InvalidModificationError"}))}, acquire:async()=>acquired, applyExisting, isCurrent:valid });
    expect(result.status).toBe("fallback");
    expect(result.captureError).toBe("InvalidModificationError");
    expect(track.stop).toHaveBeenCalledOnce();
    expect(applyExisting).toHaveBeenCalledOnce();
  });
  test("never runs fallback for an obsolete call or old selected profile", async () => {
    const applyExisting = vi.fn();
    const result = await switchCallAudioProfile({ oldStream:stream(), sender:null, acquire:vi.fn(), applyExisting, isCurrent:()=>false });
    expect(result.status).toBe("stale");
    expect(applyExisting).not.toHaveBeenCalled();
  });
  test("if both capture methods fail, preserve call and show stable sanitized reason", async () => {
    const existing = stream();
    const result = await switchCallAudioProfile({oldStream:existing, sender:null, acquire:vi.fn(), isCurrent:valid, applyExisting:vi.fn().mockRejectedValue(Object.assign(new Error("https://private-device/path?auth=secret"),{name:"OverconstrainedError"}))});
    expect(result).toEqual({status:"failed", captureError:"NotSupportedError", fallbackError:"OverconstrainedError"});
    expect(JSON.stringify(result)).not.toContain("private-device");
  });
  test("error categories must never leak messages or unrecognized strings", () => {
    expect(mediaErrorCategory({name:"NotAllowedError",message:"secret@example.com"})).toBe("NotAllowedError");
    expect(mediaErrorCategory({name:"NoiseDevice-192.168.0.1"})).toBe("OtherError");
    expect(mediaErrorCategory(null)).toBe("OtherError");
  });
});
