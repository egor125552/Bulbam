import {test,expect} from "vitest";
import {existsSync} from "node:fs";
import {chromium} from "playwright";
import {launchHeadless} from "../tools/accesspilot/browser-launch.js";
import {inspectBrowser,clickBrowser} from "../tools/accesspilot/browser-engine.js";
import {controlCoverage} from "../tools/accesspilot/control-coverage.js";

const browserReady=process.env.ACCESSPILOT_BROWSER_TESTS==="1" ||
  existsSync(chromium.executablePath());

test.skipIf(!browserReady)("read-only recovery codes are inspectable, not editable",async()=>{
  const browser=await launchHeadless();
  try{
    const page=await browser.newPage();
    await page.setContent(`<main><h1>Recovery</h1>
      <label for="codes">Recovery codes</label>
      <textarea id="codes" readonly>12345678</textarea>
      <button id="copy" type="button">Copy codes</button></main>`);
    const state=await inspectBrowser(page);
    const codes=state.elements.find(item=>item.selector==="#codes");
    expect(codes).toMatchObject({readOnly:true,kind:"fill"});
    expect((await clickBrowser(page,codes)).reason).toBe("read-only");
    expect(await page.locator("#codes").inputValue()).toBe("12345678");
    const coverage=controlCoverage([{
      screens:[{elements:state.elements,inventory:state.inventory}],
      actions:[{selector:"#copy",success:true}]
    }]);
    expect(coverage.readOnly.map(item=>item.selector)).toContain("#codes");
    expect(coverage.untested.map(item=>item.selector)).not.toContain("#codes");
    await page.close();
  }finally{await browser.close();}
},30000);
