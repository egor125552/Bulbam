import {test,expect,vi,afterEach} from "vitest";
const stubs=vi.hoisted(()=>({getCurrentAccount:vi.fn(()=>null)}));
vi.mock("../web/js/ui.js",()=>({
 elements:{
  pushEnableButton:{addEventListener:()=>{}},
  pushDisableButton:{addEventListener:()=>{}},
  pushStatus:{textContent:""}
 },
 announce:()=>{},getCurrentAccount:stubs.getCurrentAccount
}));
vi.mock("../web/js/api.js",()=>({api:vi.fn()}));
import {setupPushNotifications} from "../web/js/push.js";
afterEach(()=>{vi.unstubAllGlobals();vi.clearAllMocks();});
test("opening a visible PWA clears its badge without a visibilitychange event",async()=>{
 const clearAppBadge=vi.fn(async()=>{});
 vi.stubGlobal("navigator",{clearAppBadge});
 vi.stubGlobal("document",{visibilityState:"visible",addEventListener:()=>{}});
 vi.stubGlobal("window",{addEventListener:()=>{}});
 setupPushNotifications();
 await vi.waitFor(()=>expect(clearAppBadge).toHaveBeenCalledTimes(1));
});
