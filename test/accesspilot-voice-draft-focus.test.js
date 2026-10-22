import {test,expect} from 'vitest';
import {existsSync} from 'node:fs';
import {chromium} from 'playwright';
import {launchHeadless} from '../tools/accesspilot/browser-launch.js';
import {launchBulbamTestHost} from '../tools/accesspilot/browser-host.js';

const browserReady=process.env.ACCESSPILOT_BROWSER_TESTS==='1' ||
  existsSync(chromium.executablePath()) ||
  (process.env.ACCESSPILOT_BROWSER_PATH && existsSync(process.env.ACCESSPILOT_BROWSER_PATH));

test.skipIf(!browserReady)(
  'deleting a recovered voice draft never leaves VoiceOver focused inside a hidden panel',
  async()=>{
    const host=await launchBulbamTestHost();
    let browser;
    try{
      browser=await launchHeadless();
      const context=await browser.newContext({serviceWorkers:'block'});
      await context.addCookies([{name:'bulbam_session',value:host.cookie,url:host.baseURL}]);
      await context.addInitScript(id=>localStorage.setItem('bulbam.welcome.v1.'+id,'yes'),
        host.account.userId);
      const page=await context.newPage();
      await page.goto(host.baseURL,{waitUntil:'domcontentloaded'});
      await page.locator(host.readySelector).first().waitFor({state:'attached',timeout:10000});
      await page.locator(host.readySelector).first().click();
      await page.locator('#message-form').waitFor({state:'visible',timeout:10000});
      await page.evaluate(async accountId=>{
        const {createVoiceDraft}=await import('/js/voice-drafts.js');
        const {getSelectedChat}=await import('/js/messenger.js');
        const conversationId=getSelectedChat()?.conversationId;
        if(!conversationId)throw new Error('Seeded chat not selected');
        const now=Date.now();
        await createVoiceDraft({
          id:'accesspilot-focus-'+now,accountId,conversationId,
          state:'interrupted',startedAt:now-1000,lastChunkAt:now,
          durationMs:1000,totalBytes:0,mimeType:'audio/webm'
        });
        window.dispatchEvent(new CustomEvent('bulbam:chat-changed',{
          detail:{chat:{conversationId}}
        }));
      },host.account.userId);
      await page.locator('#voice-draft-panel').waitFor({state:'visible',timeout:10000});
      await page.locator('#voice-draft-delete').focus();
      expect(await page.evaluate(()=>document.activeElement?.id)).toBe('voice-draft-delete');
      await page.locator('#voice-draft-delete').click();
      await page.locator('#voice-draft-panel').waitFor({state:'hidden',timeout:10000});
      const focus=await page.evaluate(()=>({
        id:document.activeElement?.id,
        insideHiddenDraft:document.querySelector('#voice-draft-panel')
          ?.contains(document.activeElement)
      }));
      expect(focus.insideHiddenDraft).toBe(false);
      expect(focus.id).toBe('voice-record-button');
      await context.close();
    }finally{
      if(browser)await browser.close();
      await host.close();
    }
  },45000);
