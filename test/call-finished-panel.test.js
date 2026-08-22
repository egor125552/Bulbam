import { describe, expect, test } from "vitest";
import { callPanelHasActiveControls } from "../web/js/call-finished-panel.js";

describe("finished call panel", () => {
  test("terminal call state has no active controls and may release voice recording", () => {
    const controls = [
      { hidden: true },
      { hidden: true },
      { hidden: true },
      { hidden: true },
      { hidden: true }
    ];

    expect(callPanelHasActiveControls(controls)).toBe(false);
  });

  test("ringing, recovery or connected call keeps the panel active", () => {
    expect(callPanelHasActiveControls([{ hidden: true }, { hidden: false }])).toBe(true);
  });
});
