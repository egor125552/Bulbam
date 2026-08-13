import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("conversation layout", () => {
  it("keeps optional call state from moving the composer into the flexible row", async () => {
    const css = await readFile(new URL("../web/canonical-ui.css", import.meta.url), "utf8");
    expect(css).toContain(".conversation-header { grid-row: 1; }");
    expect(css).toContain(".call-banner { grid-row: 2; }");
    expect(css).toContain(".message-list { grid-row: 3; }");
    expect(css).toContain(".composer { grid-row: 4; }");
  });
});
