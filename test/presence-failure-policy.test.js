import {test,expect} from "vitest";
import {offlinePresenceAfterFailedRefresh} from "../web/js/presence-failure-policy.js";
import {formatPresence} from "../web/js/presence-format.js";
test("a failed status refresh preserves earlier visit times without claiming online",()=>{
 const time=Date.now()-600000;
 const statuses=[
  {userId:"friend1",lastSeenAt:time,online:true,hidden:false},
  {userId:"friend2",lastSeenAt:null,online:false,hidden:true}
 ];
 const fallback=offlinePresenceAfterFailedRefresh(statuses);
 expect(fallback[0]).toMatchObject({userId:"friend1",lastSeenAt:time,online:false});
 expect(fallback[1]).toMatchObject({hidden:true,online:false});
 expect(statuses[0].online).toBe(true);
 expect(formatPresence(fallback[0],Date.now(),"ru")).toContain("Последняя активность:");
 expect(formatPresence(fallback[0],Date.now(),"be")).toContain("Апошняя актыўнасць:");
});
