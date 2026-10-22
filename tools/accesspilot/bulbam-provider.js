import {launchBulbamTestHost} from "./browser-host.js";

// Bulbam-specific fixture only. No button names, actions or navigation scripts
// are defined here. The generic crawler drives all UI interactions.
export async function createEnvironment(){
  const host=await launchBulbamTestHost();
  return {
    url:host.baseURL,
    isolated:true,
    confirmDialogs:true,
    async prepare({context,scenario}){
      await context.addInitScript(id=>
        localStorage.setItem("bulbam.welcome.v1."+id,"yes"),
      host.account.userId);
      if(scenario.profile==="user"){
        await context.addCookies([{name:"bulbam_session",value:host.cookie,
          url:host.baseURL,httpOnly:true,sameSite:"Lax"}]);
      }
    },
    async reset({page,context,scenario,url}){
      // A call is a persistent fixture-side resource. Merely reloading the
      // browser keeps the caller "busy", so subsequent independent explorations
      // cannot reproduce the outgoing-call controls. Clean up *test data*
      // before resetting the UI; this contains no application-button map.
      if(scenario.profile==="user"){
        try{
          const activeResponse=await context.request.get(
            new URL("/api/v1/calls/active",url).href,{timeout:3500});
          if(activeResponse.ok()){
            const {call}=await activeResponse.json();
            if(call?.conversationId&&call?.callId){
              await context.request.post(
                new URL("/api/v1/chats/"+encodeURIComponent(call.conversationId)
                  +"/calls/"+encodeURIComponent(call.callId)+"/end",url).href,
                {timeout:3500});
            }
          }
        }catch{
          // A fixture account may have changed credentials. The existing
          // authenticated-session recovery below handles that case.
        }
      }
      let error;
      for(let attempt=0;attempt<3;attempt++){
        try{
          if(scenario.profile==="guest")await context.clearCookies();
          await page.goto(url,{waitUntil:"domcontentloaded",timeout:14000});
          if(scenario.profile==="user"){
            await page.waitForFunction(()=>{
              const yes=document.querySelector("#signed-in");
              const no=document.querySelector("#signed-out");
              return (yes&&!yes.hidden)||(no&&!no.hidden);
            },null,{timeout:9000});
            if(await page.locator("#signed-in").isHidden()){
              const cookie=await host.issueSession();
              await context.addCookies([{
                name:"bulbam_session",value:cookie,url,httpOnly:true,sameSite:"Lax"
              }]);
              await page.reload({waitUntil:"domcontentloaded",timeout:14000});
            }
            await page.locator("#signed-in").waitFor({state:"visible",timeout:9000});
            await page.locator(host.readySelector).first().waitFor({
              state:"attached",timeout:9000
            });
          }else{
            await page.locator("#signed-out").waitFor({state:"visible",timeout:9000});
          }
          return;
        }catch(e){error=e;}
      }
      throw new Error("Disposable Bulbam fixture failed to load: "+
        String(error?.message||error).slice(0,350));
    },
    async close(){await host.close();}
  };
}
