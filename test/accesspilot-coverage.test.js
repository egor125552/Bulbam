import { expect, test } from "vitest";
import { measureStaticCoverage } from "../tools/accesspilot/coverage.js";

test("reports all static controls and source lines without scripted action maps", () => {
  const html='<main>\n<button id="open">Открыть</button>\n<input id="field">\n<button id="remaining">Дальше</button></main>';
  const runs=[{screens:[{elements:[{selector:"#open"},{selector:"#field"}]}],actions:[
    {selector:"#open",success:true},{selector:"#field",success:false}
  ]}];
  const found=measureStaticCoverage(html,runs);
  expect(found.totalStaticControls).toBe(3);
  expect(found.rendered).toBe(2);
  expect(found.activated).toBe(1);
  expect(found.notActivated).toContainEqual(expect.objectContaining({id:"remaining",line:4}));
});
