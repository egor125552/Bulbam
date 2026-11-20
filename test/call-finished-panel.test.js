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

  test("ringing, recovery or connected call remains active", () => {
    const panel = { hidden: false };
    const controls = [{ hidden: true }, { hidden: false }];

    expect(callPanelHasActiveControls(controls)).toBe(true);
    expect(releaseFinishedCallPanel(panel, controls)).toBe(false);
    expect(panel.hidden).toBe(false);
  });
});
