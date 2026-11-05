import {test,expect,vi,afterEach} from "vitest";
const stubs=vi.hoisted(()=>({
 api:vi.fn(),announce:vi.fn(),getCurrentAccount:vi.fn(()=>null)
}));
vi.mock("../web/js/api.js",()=>({api:stubs.api,deviceName:()=> "test-device"}));
vi.mock("../web/js/ui.js",()=>({announce:stubs.announce,getCurrentAccount:stubs.getCurrentAccount}));
import {startPasskeyAutofill,signInWithPasskey,cancelPasskeyAutofill} from "../web/js/passkeys.js";
afterEach(()=>{cancelPasskeyAutofill();vi.unstubAllGlobals();vi.clearAllMocks();});
test("manual login aborts conditional options fetch before opening WebAuthn",async()=>{
 const get=vi.fn(async()=>null);
 vi.stubGlobal("window",{isSecureContext:true,PublicKeyCredential:class{}});
 vi.stubGlobal("navigator",{credentials:{get}});
 vi.stubGlobal("PublicKeyCredential",{isConditionalMediationAvailable:async()=>true});
 vi.stubGlobal("document",{querySelector:()=>({disabled:false})});
 let oldSignal=null;
 let oldAbort=null;
 stubs.api.mockImplementation((path,options)=>{
  if(path!=="/api/v1/passkeys/authentication/options")throw Error("Unexpected endpoint");
  if(!oldSignal){
   oldSignal=options.signal;
   return new Promise((resolve,reject)=>{
    oldAbort=()=>reject(Object.assign(new Error("Aborted"),{name:"AbortError"}));
    options.signal.addEventListener("abort",oldAbort,{once:true});
   });
  }
  return Promise.resolve({options:{challenge:"AQ"},challengeId:"manual"});
 });
 const conditional=startPasskeyAutofill();
 await vi.waitFor(()=>expect(oldSignal).not.toBeNull());
 expect(oldSignal.aborted).toBe(false);
 await signInWithPasskey();
 expect(oldSignal.aborted).toBe(true);
 expect(get).toHaveBeenCalledTimes(1);
 await conditional;
});
