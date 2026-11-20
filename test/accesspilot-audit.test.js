import {test,expect} from 'vitest';
import {existsSync} from 'node:fs';
import {chromium} from 'playwright';
import {launchHeadless} from '../tools/accesspilot/browser-launch.js';
import {installAccessibilityAudit,auditAccessibility} from '../tools/accesspilot/audit.js';

// The default non-browser CI job does not install Chromium. Dedicated
// AccessPilot CI sets ACCESSPILOT_BROWSER_TESTS=1 and must execute this test.
const browserReady=process.env.ACCESSPILOT_BROWSER_TESTS==='1' ||
  existsSync(chromium.executablePath()) ||
  (process.env.ACCESSPILOT_BROWSER_PATH && existsSync(process.env.ACCESSPILOT_BROWSER_PATH));
test.skipIf(!browserReady)('real-browser audit catches a missing form label autonomously',async()=>{
  const browser=await launchHeadless();
  try{
    const context=await browser.newContext();
    await installAccessibilityAudit(context);
    const page=await context.newPage();
    await page.goto('about:blank');
    await page.setContent('<!doctype html><html lang="ru"><title>Example</title><body><main><input id="unlabeled"></main></body></html>');
    const violations=await auditAccessibility(page);
    expect(violations).toContainEqual(expect.objectContaining({code:'wcag-label',selector:'#unlabeled'}));
    await context.close();
  }finally{await browser.close();}
},30000);
