import {test,expect} from 'vitest';
import {existsSync} from 'node:fs';
import {chromium} from 'playwright';
import {launchHeadless} from '../tools/accesspilot/browser-launch.js';
import {launchBulbamTestHost} from '../tools/accesspilot/browser-host.js';

// Required in the dedicated Chromium job, skipped in bare TypeScript CI.
const hasBrowser=process.env.ACCESSPILOT_BROWSER_TESTS==='1' ||
  existsSync(chromium.executablePath()) ||
  (process.env.ACCESSPILOT_BROWSER_PATH && existsSync(process.env.ACCESSPILOT_BROWSER_PATH));

test.skipIf(!hasBrowser)('toggling detailed help keeps screen-reader controls usable after reload',async()=>{
  const host=await launchBulbamTestHost();
  let browser;
  try{
    browser=await launchHeadless();
    const context=await browser.newContext({serviceWorkers:'block'});
    await context.addCookies([{name:'bulbam_session',value:host.cookie,url:host.baseURL}]);
    const page=await context.newPage();
    await page.goto(host.baseURL,{waitUntil:'domcontentloaded'});
    await page.locator(host.readySelector).first().waitFor({state:'attached',timeout:10000});
    await page.locator('#settings-button').click();
    await page.locator('[data-open-settings="accessibility"]').click();
    const input=page.locator('#voice-detailed-help');
    expect(await input.isVisible()).toBe(true);
    await input.uncheck();
    expect(await page.locator('#settings-close').isVisible()).toBe(true);
    const tree=await page.locator('body').ariaSnapshot();
    expect(tree).toContain('checkbox');
    expect(tree).toContain('button');
    await page.reload({waitUntil:'domcontentloaded'});
    await page.locator(host.readySelector).first().waitFor({state:'attached',timeout:10000});
    await page.locator('#settings-button').click();
    await page.locator('[data-open-settings="accessibility"]').click();
    expect(await page.locator('#voice-detailed-help').isChecked()).toBe(false);
    expect(await page.locator('#settings-close').isVisible()).toBe(true);
    await context.close();
  }finally{
    if(browser)await browser.close();
    await host.close();
  }
},45000);
