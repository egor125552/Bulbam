import {test,expect} from 'vitest';
import {launchHeadless} from '../tools/accesspilot/browser-launch.js';
import {installAccessibilityAudit,auditAccessibility} from '../tools/accesspilot/audit.js';

test('real-browser audit catches a missing form label autonomously',async()=>{
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
