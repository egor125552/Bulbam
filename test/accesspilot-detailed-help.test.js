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
    expect(await page.locator('html').evaluate(element=>element.hidden)).toBe(false);
    const closeVisible=await page.locator('#settings-close').isVisible();
    if(!closeVisible){
      const diagnostic=await page.evaluate(()=>{
        const button=document.querySelector('#settings-close');
        const dialog=document.querySelector('#settings-dialog');
        const ancestors=[];
        for(let n=button;n;n=n.parentElement){
          ancestors.push({tag:n.tagName,id:n.id,className:String(n.className||''),
            hidden:n.hidden,display:getComputedStyle(n).display,
            visibility:getComputedStyle(n).visibility,
            detailedHelp:n.getAttribute('data-detailed-help')});
        }
        return {url:location.href,readyState:document.readyState,
          signedInHidden:document.querySelector('#signed-in')?.hidden,
          dialogOpen:dialog?.open,rootDetailedHelp:document.documentElement.dataset.detailedHelp,
          ancestors};
      });
      throw new Error('Detailed help checkbox made close button invisible: '+JSON.stringify(diagnostic));
    }
    const tree=await page.locator('body').ariaSnapshot();
    expect(tree).toContain('checkbox');
    expect(tree).toContain('button');
    await page.reload({waitUntil:'domcontentloaded'});
    await page.locator(host.readySelector).first().waitFor({state:'attached',timeout:10000});
    await page.locator('#settings-button').click();
    await page.locator('[data-open-settings="accessibility"]').click();
    expect(await page.locator('#voice-detailed-help').isChecked()).toBe(false);
    expect(await page.locator('html').evaluate(element=>element.hidden)).toBe(false);
    expect(await page.locator('#settings-close').isVisible()).toBe(true);
    await context.close();
  }finally{
    if(browser)await browser.close();
    await host.close();
  }
},45000);
