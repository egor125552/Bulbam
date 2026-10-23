import {test,expect} from "vitest";
import {launchHeadless} from "../tools/accesspilot/browser-launch.js";
import {launchBulbamTestHost} from "../tools/accesspilot/browser-host.js";

test.skipIf(process.env.ACCESSPILOT_BROWSER_TESTS!=="1")(
  "diagnostics explains selected WebRTC route and refuses relay-only without TURN credentials",
  async()=>{
    const host=await launchBulbamTestHost();
    let browser;
    try{
      browser=await launchHeadless();
      const context=await browser.newContext({serviceWorkers:"block"});
      await context.addCookies([{name:"bulbam_session",value:host.cookie,url:host.baseURL}]);
      await context.addInitScript(id=>
        localStorage.setItem("bulbam.welcome.v1."+id,"yes"),host.account.userId);
      const page=await context.newPage();
      await page.goto(host.baseURL,{waitUntil:"domcontentloaded"});
      await page.locator("#settings-button").click();
      await page.locator('[data-open-settings="diagnostics"]').click();
      const choice=page.locator("#call-ice-mode");
      await choice.waitFor({state:"visible"});
      expect(await choice.inputValue()).toBe("all");
      expect(await page.locator("#call-ice-route").innerText()).toMatch(/Звонка нет/);
      await choice.selectOption("relay");
      await page.waitForFunction(()=>document.getElementById("call-ice-mode").value==="all"
        &&/TURN/.test(document.getElementById("call-ice-mode-status")?.textContent||""));
      expect(await choice.inputValue()).toBe("all");
      expect(await page.locator("#call-ice-mode-status").innerText()).toMatch(/сервер не выдал/);
      await page.locator("#refresh-call-route").click();
      expect(await page.locator("#call-turn-availability").innerText()).toMatch(/TURN не предоставлен/);
      await context.close();
    }finally{
      if(browser)await browser.close();
      await host.close();
    }
  },45000);
