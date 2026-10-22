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
    // Open the seeded conversation through the real application UI.
    await page.locator(host.readySelector).first().click();
    await page.locator('#message-form').waitFor({state:'visible',timeout:10000});
    // Hidden controls become testable in their corresponding UI states.
    // This checks their computed accessible label in the real browser.
    await page.evaluate(()=>{
      document.getElementById('voice-pause-button').hidden=false;
      document.getElementById('call-audio-cycle').hidden=false;
    });
    // Audio profile changes its visible text dynamically. Every state must
    // retain the exact visible label inside the accessible name.
    await page.evaluate(()=>{document.getElementById('call-panel').hidden=false;});
    const micButton=page.locator('#call-audio-cycle');
    for(let mode=0;mode<4;mode++){
      const visibleText=(await micButton.innerText()).trim();
      const accessibleLabel=await micButton.getAttribute('aria-label');
      expect((accessibleLabel||visibleText).includes(visibleText),
        'Visible call audio label must be present in the accessible name').toBe(true);
      await micButton.evaluate(element=>element.click());
    }
    const microphoneProblems=await auditAccessibility(page);
    expect(microphoneProblems.filter(p=>p.code==='wcag-label-content-name-mismatch'
      &&p.selector==='#call-audio-cycle')).toEqual([]);
    await page.evaluate(()=>{document.getElementById('call-panel').hidden=true;});
    const conversationProblems=await auditAccessibility(page);
    const specific=['#message-list','#voice-record-button','#voice-pause-button','#call-audio-cycle'];
    expect(conversationProblems.filter(p=>
      (p.code==='wcag-list' || p.code==='wcag-label-content-name-mismatch')
      && specific.includes(p.selector)
    )).toEqual([]);
    const listRoles=await page.locator('#message-list > li').evaluateAll(items=>
      items.map(el=>({role:el.getAttribute('role'),html:el.outerHTML.slice(0,350)}))
    );
    expect(listRoles.every(item=>!item.role || item.role==='listitem'),
      JSON.stringify(listRoles)).toBe(true);
    await context.close();
  }finally{if(browser)await browser.close();await host.close();}
},60000);
