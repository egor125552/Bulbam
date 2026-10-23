import {test,expect,vi} from "vitest";
import {makeIceServers} from "../worker/src/modules/calls/infrastructure/webrtc-config.ts";

test("self-hosted TURN wins over a configured Cloudflare TURN token",async()=>{
  const fetchSpy=vi.spyOn(globalThis,"fetch").mockRejectedValue(new Error("should not call Cloudflare"));
  try{
    const servers=await makeIceServers({
      WEBRTC_TURN_URLS:"turn:169.58.224.216:3478?transport=udp",
      WEBRTC_TURN_SECRET:"fixture-only-secret",
      WEBRTC_CLOUDFLARE_TURN_KEY_ID:"test-key",
      WEBRTC_CLOUDFLARE_TURN_API_TOKEN:"fixture-token",
      WEBRTC_STUN_URLS:"stun:stun.cloudflare.com:3478"
    },"test-user");
    expect(servers.some(s=>String(s.urls).startsWith("turn:"))).toBe(true);
    const relay=servers.find(s=>String(s.urls).startsWith("turn:"));
    expect(relay.username).toMatch(/^\d+:test-user$/);
    expect(relay.credential).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  }finally{fetchSpy.mockRestore();}
});

test("without matching TURN credentials, STUN is retained as fallback",async()=>{
  const servers=await makeIceServers({
    WEBRTC_TURN_URLS:"turn:169.58.224.216:3478?transport=udp",
    WEBRTC_STUN_URLS:"stun:stun.cloudflare.com:3478"
  },"test-user");
  expect(servers.some(s=>String(s.urls).startsWith("turn:"))).toBe(false);
  expect(servers.some(s=>String(s.urls).startsWith("stun:"))).toBe(true);
});
