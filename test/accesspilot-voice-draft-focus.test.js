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
        const conversationId=document.getElementById('message-form')?.dataset.conversationId;
        if(!conversationId)throw new Error('Seeded chat not selected');
        const request=indexedDB.open('bulbam-voice-v1',2);
        const database=await new Promise((resolve,reject)=>{
          request.onsuccess=()=>resolve(request.result);
          request.onerror=()=>reject(request.error);
        });
        const now=Date.now();
        await new Promise((resolve,reject)=>{
          const transaction=database.transaction('drafts','readwrite');
          transaction.objectStore('drafts').put({
            id:'accesspilot-focus-'+now,accountId,conversationId,
            state:'interrupted',startedAt:now-1000,lastChunkAt:now,
            durationMs:1000,totalBytes:0,mimeType:'audio/webm'
          });
          transaction.oncomplete=()=>resolve();
          transaction.onerror=()=>reject(transaction.error);
        });
        database.close();
        window.dispatchEvent(new CustomEvent('bulbam:chat-changed',{
          detail:{chat:{conversationId}}
        }));
      },host.account.userId);
      await page.locator('#voice-draft-panel').waitFor({state:'visible',timeout:10000});
      await page.locator('#voice-draft-delete').focus();
      expect(await page.evaluate(()=>document.activeElement?.id)).toBe('voice-draft-delete');
      await page.locator('#voice-draft-delete').click();
      await page.locator('#voice-draft-panel').waitFor({state:'hidden',timeout:10000});
      const focus=await page.evaluate(()=>{
        const element=document.activeElement;
        const ancestorHidden=element?.closest('[hidden],[inert],[aria-hidden="true"]');
        return {
          id:element?.id,
          insideHiddenDraft:document.querySelector('#voice-draft-panel')
            ?.contains(element),
          visible:!!element?.getClientRects().length&&!ancestorHidden
        };
      });
      expect(focus.insideHiddenDraft).toBe(false);
      expect(focus.visible).toBe(true);
      // Refreshing the selected chat may deliberately transfer focus to its
      // visible heading. That is safe for screen-reader users; hidden focus isn't.
      expect(['voice-record-button','conversation-title','message-input']).toContain(focus.id);
      await context.close();
    }finally{
      if(browser)await browser.close();
      await host.close();
    }
  },45000);
