import {test,expect} from "vitest";
import {createEnvironment} from "../tools/accesspilot/bulbam-provider.js";
import {launchHeadless} from "../tools/accesspilot/browser-launch.js";

test.skipIf(process.env.ACCESSPILOT_BROWSER_TESTS!=="1")(
  "a disposable outgoing call can be reproduced after resetting the test browser",async()=>{
    const environment=await createEnvironment();
    let browser;
    try{
      browser=await launchHeadless();
      const context=await browser.newContext({
        permissions:["microphone"],serviceWorkers:"block"
      });
      await environment.prepare({context,scenario:{profile:"user"}});
      const page=await context.newPage();
      const reset=()=>environment.reset({
        page,context,scenario:{profile:"user"},url:environment.url
      });
      async function startCall(){
        await page.locator("#chat-list .chat-item").first().click();
        await page.locator("#call-start").click();
        await page.locator("#call-mute").waitFor({state:"visible",timeout:6500});
        expect(await page.locator("#call-mute").isVisible()).toBe(true);
      }
      await reset();
      await startCall();
      await reset();
      await startCall();
      await context.close();
    }finally{
      if(browser)await browser.close();
      await environment.close();
    }
  },60000
);
