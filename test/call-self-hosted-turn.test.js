import {test,expect,vi} from "vitest";
import {makeIceServers} from "../worker/src/modules/calls/infrastructure/webrtc-config.ts";

test("when configured, VPS TURN relay is selected before Cloudflare",async()=>{
  const fetchSpy=vi.spyOn(globalThis,"fetch")
    .mockRejectedValue(new Error("Cloudflare credentials must not be requested"));
  try{
    const ice=await makeIceServers({
      WEBRTC_TURN_URLS:"turn:169.58.224.216:3478?transport=udp",
      WEBRTC_TURN_SECRET:"local-fixture-secret",
      WEBRTC_CLOUDFLARE_TURN_KEY_ID:"mock-id",
      WEBRTC_CLOUDFLARE_TURN_API_TOKEN:"mock-token"
    },"pilot");
    expect(ice.some(s=>String(s.urls).includes("turn:169.58.224.216"))).toBe(true);
    const server=ice.find(s=>String(s.urls).includes("turn:169.58.224.216"));
    expect(server.username).toMatch(/^\d+:pilot$/);
    expect(server.credential).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  }finally{fetchSpy.mockRestore();}
});
