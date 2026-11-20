import { describe, expect, test, vi } from "vitest";
import { replaceCallCapture } from "../web/js/call-microphone-replacement.js";
function audioStream() { const track={kind:"audio",enabled:true,stop:vi.fn()};return {track,getAudioTracks:()=>[track],getTracks:()=>[track]}; }
describe("live microphone quality switching on Android",()=>{
  test("new capture replaces sender track without renegotiating and preserves mute",async()=>{
    const old=audioStream(),fresh=audioStream();const sender={replaceTrack:vi.fn().mockResolvedValue(undefined)};
    const result=await replaceCallCapture({oldStream:old,sender,acquire:async()=>fresh,isCurrent:()=>true,muted:true});
    expect(sender.replaceTrack).toHaveBeenCalledWith(fresh.track);
    expect(fresh.track.enabled).toBe(false);
    expect(old.track.stop).toHaveBeenCalledOnce();
    expect(result.stream).toBe(fresh);
  });
  test("failure keeps existing microphone alive and stops new capture",async()=>{
    const old=audioStream(),fresh=audioStream();const sender={replaceTrack:vi.fn().mockRejectedValue(Error("failed"))};
    await expect(replaceCallCapture({oldStream:old,sender,acquire:async()=>fresh,isCurrent:()=>true})).rejects.toThrow("failed");
    expect(old.track.stop).not.toHaveBeenCalled();
    expect(fresh.track.stop).toHaveBeenCalled();
  });
  test("a stale profile request cannot replace the microphone",async()=>{
    const old=audioStream(),fresh=audioStream();const sender={replaceTrack:vi.fn()};
    const result=await replaceCallCapture({oldStream:old,sender,acquire:async()=>fresh,isCurrent:()=>false});
    expect(result.changed).toBe(false);
    expect(sender.replaceTrack).not.toHaveBeenCalled();
    expect(fresh.track.stop).toHaveBeenCalled();
    expect(old.track.stop).not.toHaveBeenCalled();
  });
});

test("stale request after replaceTrack restores the old live audio track", async () => {
  const old=audioStream(),fresh=audioStream();
  let current=true;
  const sender={replaceTrack:vi.fn().mockImplementation(async()=>{current=false;})};
  const result=await replaceCallCapture({oldStream:old,sender,acquire:async()=>fresh,isCurrent:()=>current});
  expect(result.stale).toBe(true);
  expect(sender.replaceTrack).toHaveBeenCalledTimes(2);
  expect(sender.replaceTrack).toHaveBeenLastCalledWith(old.track);
  expect(old.track.stop).not.toHaveBeenCalled();
  expect(fresh.track.stop).toHaveBeenCalled();
});
