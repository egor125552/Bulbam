import {test,expect} from "vitest";
import {launchHeadless} from "../tools/accesspilot/browser-launch.js";
import {inspectBrowser} from "../tools/accesspilot/browser-engine.js";
import {actionIdentity} from "../tools/accesspilot/action-coverage.js";

test.skipIf(process.env.ACCESSPILOT_BROWSER_TESTS!=="1")(
  "global settings action keeps identity as unrelated sibling controls appear",async()=>{
    const browser=await launchHeadless();
    try{
      const page=await browser.newPage();
      await page.setContent('<main id="application"><button id="settings">Settings</button><button id="extra" hidden>Later</button></main>');
      const first=(await inspectBrowser(page)).elements.find(el=>el.selector==="#settings");
      await page.locator("#extra").evaluate(el=>el.hidden=false);
      const second=(await inspectBrowser(page)).elements.find(el=>el.selector==="#settings");
      expect(actionIdentity(first,"first")).toBe(actionIdentity(second,"second"));
      await browser.close();
    }finally{if(browser.isConnected())await browser.close();}
  },25000);
