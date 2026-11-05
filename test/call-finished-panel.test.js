import { describe, expect, test } from "vitest";
import {
  callPanelHasActiveControls,
  releaseFinishedCallPanel
} from "../web/js/call-finished-panel.js";

describe("finished call panel", () => {
  test("terminal call state is released before a new voice recording", () => {
    const panel = { hidden: false };
    const controls = [
      { hidden: true },
      { hidden: true },
      { hidden: true },
      { hidden: true },
      { hidden: true }
    ];

    expect(callPanelHasActiveControls(controls)).toBe(false);
    expect(releaseFinishedCallPanel(panel, controls)).toBe(true);
    expect(panel.hidden).toBe(true);
  });

  test("dismissal clears modal state and unblocks the messenger shell",()=>{
    const original=globalThis.document;
    const shell={inert:true};
    const calls=[];
    globalThis.document={querySelector:selector=>selector===".messenger-shell"?shell:null};
    try{
      const panel={hidden:false,removeAttribute:name=>calls.push(name)};
      expect(releaseFinishedCallPanel(panel,[{hidden:true}])).toBe(true);
      expect(panel.hidden).toBe(true);
      expect(calls).toEqual(["aria-modal"]);
      expect(shell.inert).toBe(false);
    }finally{
      if(original===undefined)delete globalThis.document;else globalThis.document=original;
    }
  });

  test("ringing, recovery or connected call remains active", () => {
    const panel = { hidden: false };
    const controls = [{ hidden: true }, { hidden: false }];

    expect(callPanelHasActiveControls(controls)).toBe(true);
    expect(releaseFinishedCallPanel(panel, controls)).toBe(false);
    expect(panel.hidden).toBe(false);
  });
});
