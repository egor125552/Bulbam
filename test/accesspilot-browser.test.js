import { describe, test, expect } from "vitest";
import { launchHeadless } from "../tools/accesspilot/browser-launch.js";
import { inspectBrowser, crawlBrowser } from "../tools/accesspilot/browser-engine.js";

describe.skipIf(process.env.ACCESSPILOT_BROWSER_TESTS !== "1")("Universal real-browser accessibility explorer", () => {
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
