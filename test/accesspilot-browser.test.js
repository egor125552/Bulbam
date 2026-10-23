import { describe, test, expect } from "vitest";
import { launchHeadless } from "../tools/accesspilot/browser-launch.js";
import { inspectBrowser } from "../tools/accesspilot/browser-engine.js";
import { crawlBrowser } from "../tools/accesspilot/crawler.js";
import {actionIdentity} from "../tools/accesspilot/action-coverage.js";
import { launchBulbamTestHost } from "../tools/accesspilot/browser-host.js";
import { installAccessibilityAudit } from "../tools/accesspilot/audit.js";

describe.skipIf(process.env.ACCESSPILOT_BROWSER_TESTS !== "1")("Universal real-browser accessibility explorer", () => {
  test("finds unnamed canvas and explores an open Shadow DOM widget",async()=>{
    const browser=await launchHeadless();
    try{
      const page=await browser.newPage();
      const html=`<!doctype html><html lang="en"><head><title>Widgets</title></head>
        <body><main>
          <div id="widget-host"></div>
          <canvas id="only-pixels" width="100" height="40"></canvas>
          <script>
            const shadow=document.querySelector('#widget-host').attachShadow({mode:'open'});
            shadow.innerHTML='<button id="inside">Execute</button>';
            shadow.querySelector('button').addEventListener('click',event=>{
              event.currentTarget.textContent='Done';
            });
          </script>
        </main></body></html>`;
      await page.setContent(html);
      const snapshot=await inspectBrowser(page);
      expect(snapshot.elements.some(el=>el.selector.includes('#widget-host')&&
        el.selector.includes('#inside'))).toBe(true);
      expect(snapshot.issues).toContainEqual(expect.objectContaining({
        code:"canvas-without-accessible-alternative",element:"#only-pixels"
      }));
      await page.close();
    }finally{await browser.close();}
  },30000);

  test("collects independent violations across successive button states", async () => {
    const browser=await launchHeadless();
    try{
      const context=await browser.newContext();
      await installAccessibilityAudit(context);
      const page=await context.newPage();
      await page.goto('about:blank');
      const html=`<!doctype html><html lang="ru"><head><title>Тест</title></head><body>
        <main><h1>Тестирование</h1>
        <button id="toggle" onclick="this.setAttribute('aria-label','Скрытое название')">Включить</button>
        <button id="unnamed"></button>
        </main></body></html>`;
      const report=await crawlBrowser({page,reset:()=>page.setContent(html),
        maxActions:12,maxStates:5,maxDepth:2});
      expect(report.findings).toContainEqual(expect.objectContaining({
        code:"missing-name",element:"#unnamed"
      }));
      expect(report.findings).toContainEqual(expect.objectContaining({
        code:"wcag-label-content-name-mismatch",selector:"#toggle"
      }));
      await context.close();
    }finally{await browser.close();}
  },30000);

  test("keeps untested controls in a resumable checkpoint", async () => {
    const browser=await launchHeadless();
    try {
      const page=await browser.newPage();
      const html=`<html><body><button id="first" onclick="this.textContent='First done'">First</button><button id="second" onclick="this.textContent='Second done'">Second</button></body></html>`;
      const reset=()=>page.setContent(html);
      const part=await crawlBrowser({page,reset,maxStates:10,maxActions:1,maxDepth:3});
      expect(part.summary.truncated).toBe(true);
      expect(part.actions).toHaveLength(1);
      expect(part.checkpoint?.queue?.length).toBeGreaterThan(0);
      const final=await crawlBrowser({page,reset,maxStates:10,maxActions:12,maxDepth:3,initialState:part.checkpoint});
      expect(final.actions.some(x=>x.name==='Second')).toBe(true);
      await page.close();
    } finally { await browser.close(); }
  },30000);

  test("explores transient child screen before an irreversible trigger disappears", async () => {
    const browser=await launchHeadless();
    try {
      const page=await browser.newPage();
      const html=`<html><body>
        <button id="open" onclick="if(window.alreadyOpened)return;window.alreadyOpened=true;document.querySelector('#child').hidden=false">Start</button>
        <section id="child" hidden><button id="inside" onclick="this.textContent='Clicked'">Inside</button></section>
      </body></html>`;
      const reset=()=>page.setContent(html);
      const report=await crawlBrowser({page,reset,depthFirst:true,maxStates:4,maxActions:10,maxDepth:3});
      expect(report.actions.some(a=>a.selector==="#inside"&&a.success)).toBe(true);
      await page.close();
    } finally {await browser.close();}
  },30000);

  test("waits for seeded conversations before marking the first screen inspected", async () => {
    const host=await launchBulbamTestHost();
    let browser;
    try {
      browser=await launchHeadless();
      const context=await browser.newContext({serviceWorkers:"block"});
      await context.addCookies([{name:"bulbam_session",value:host.cookie,url:host.baseURL}]);
      await context.addInitScript(id=>localStorage.setItem("bulbam.welcome.v1."+id,"yes"),host.account.userId);
      const page=await context.newPage();
      await page.goto(host.baseURL,{waitUntil:"domcontentloaded"});
      await page.locator(host.readySelector).first().waitFor({state:"attached",timeout:10000});
      const actual=await inspectBrowser(page);
      expect(actual.elements).toContainEqual(expect.objectContaining({role:"button",selector:"#chat-list > button:nth-of-type(1)"}));
      await context.close();
    } finally {if(browser)await browser.close(); await host.close();}
  },30000);

  test("attempts every control it encounters before marking coverage complete",async()=>{
    const browser=await launchHeadless();
    try{
      const page=await browser.newPage();
      const html=`<html><body><button id="details" onclick="document.querySelector('#panel').hidden=false">Details</button><button id="other" onclick="this.setAttribute('aria-pressed','true')">Other</button><section id="panel" hidden><button id="nested" onclick="this.setAttribute('aria-pressed','true')">Nested</button></section></body></html>`;
      const report=await crawlBrowser({page,reset:()=>page.setContent(html),depthFirst:true,maxStates:12,maxActions:30});
      const done=new Set(report.actions.map(x=>x.actionKey));
      for(const screen of report.screens)for(const el of screen.elements){
        if(el.disabled||(el.kind==="fill"&&el.readOnly))continue;
        expect(done.has(actionIdentity(el,screen.stateKey))).toBe(true);
      }
      expect(report.summary.complete).toBe(true);
      expect(report.summary.untested).toBe(0);
      await page.close();
    }finally{await browser.close();}
  },30000);

  test("retries an untested button when unrelated controls change", async () => {
    const browser=await launchHeadless();
    try {
      const page=await browser.newPage();
      let resets=0;
      const reset=()=>page.setContent(`<html><body>
        <button id="open" onclick="document.querySelector('#child').hidden=false">Open</button>
        <button id="later" onclick="this.setAttribute('aria-pressed','true')">Later</button>
        ${++resets>=3?'<button id="extra">Extra</button>':''}
        <section id="child" hidden><button id="close" onclick="this.parentElement.hidden=true">Close</button></section>
        </body></html>`);
      const report=await crawlBrowser({page,reset,depthFirst:true,maxStates:14,maxActions:45,maxDepth:3});
      expect(report.actions.some(action=>action.selector==="#later"&&action.success)).toBe(true);
      expect(report.findings.some(issue=>issue.code==="state-unavailable"&&issue.element==="#later")).toBe(false);
      await page.close();
    } finally { await browser.close(); }
  },30000);

  test("discovers and activates a nested screen without a button map", async () => {
    const browser=await launchHeadless();
    try {
      const page=await browser.newPage();
      const html=`<!doctype html><html><body>
        <button id="open" onclick="document.querySelector('#details').hidden=false">Раздел</button>
        <section id="details" hidden>
          <button id="blank" aria-label=""></button>
          <input id="unnamed" placeholder="Подсказка">
          <div aria-hidden="true"><button id="invisible">Скрытая</button></div>
        </section>
      </body></html>`;
      const reset=()=>page.setContent(html);
      const report=await crawlBrowser({page,reset,maxStates:5,maxActions:15,maxDepth:3});
      expect(report.screens.length).toBeGreaterThanOrEqual(2);
      expect(report.screens.find(screen => screen.path.length > 0)?.pathSteps)
        .toContainEqual(expect.objectContaining({selector:"#open"}));
      expect(report.findings).toContainEqual(expect.objectContaining({code:"missing-name",element:"#blank"}));
      expect(report.findings).toContainEqual(expect.objectContaining({code:"missing-name",element:"#unnamed"}));
      expect(report.findings).toContainEqual(expect.objectContaining({
        code:"interactive-hidden-from-screen-reader",element:"#invisible"
      }));
      expect(report.actions).toContainEqual(expect.objectContaining({name:"Раздел",success:true,changed:true}));
      const snapshot=await inspectBrowser(page);
      expect(snapshot.elements).toEqual(expect.any(Array));
      await page.close();
    } finally {await browser.close();}
  },30000);
});
