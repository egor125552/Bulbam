import {test,expect} from 'vitest';
import {existsSync} from 'node:fs';
import {chromium} from 'playwright';
import {launchHeadless} from '../tools/accesspilot/browser-launch.js';
import {launchBulbamTestHost} from '../tools/accesspilot/browser-host.js';
import {installAccessibilityAudit,auditAccessibility} from '../tools/accesspilot/audit.js';

// The default non-browser CI job does not install Chromium. Dedicated
// AccessPilot CI sets ACCESSPILOT_BROWSER_TESTS=1 and must execute this test.
const browserReady=process.env.ACCESSPILOT_BROWSER_TESTS==='1' ||
  existsSync(chromium.executablePath()) ||
  (process.env.ACCESSPILOT_BROWSER_PATH && existsSync(process.env.ACCESSPILOT_BROWSER_PATH));
test.skipIf(!browserReady)('visible chat button text is included in its accessible name',async()=>{
  const host=await launchBulbamTestHost(); let browser;
  try{
    browser=await launchHeadless();
    const context=await browser.newContext({serviceWorkers:'block'});
    await installAccessibilityAudit(context);
    await context.addCookies([{name:'bulbam_session',value:host.cookie,url:host.baseURL}]);
    await context.addInitScript(id=>localStorage.setItem('bulbam.welcome.v1.'+id,'yes'),host.account.userId);
    const page=await context.newPage();
    await page.goto(host.baseURL,{waitUntil:'domcontentloaded'});
    await page.locator(host.readySelector).first().waitFor({state:'attached',timeout:10000});
    const problems=await auditAccessibility(page);
    expect(problems.filter(p=>p.code==='wcag-label-content-name-mismatch'&&p.selector==='.chat-item')).toEqual([]);
    await context.close();
  }finally{if(browser)await browser.close();await host.close();}
},35000);
