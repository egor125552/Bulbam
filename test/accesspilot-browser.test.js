import { describe, test, expect } from "vitest";
import { launchHeadless } from "../tools/accesspilot/browser-launch.js";
import { inspectBrowser } from "../tools/accesspilot/browser-engine.js";
import { crawlBrowser } from "../tools/accesspilot/crawler.js";

describe.skipIf(process.env.ACCESSPILOT_BROWSER_TESTS !== "1")("Universal real-browser accessibility explorer", () => {
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
