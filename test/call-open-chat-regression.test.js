import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

describe("outgoing call uses the actually selected chat",()=>{
  test("presence text cannot corrupt call chat selection",()=>{
    const calls=readFileSync(new URL("../web/js/calls.js",import.meta.url),"utf8");
    const messenger=readFileSync(new URL("../web/js/messenger.js",import.meta.url),"utf8");
    expect(messenger).toContain("elements.messageForm.dataset.conversationId = chat.conversationId");
    expect(calls).toMatch(/messageForm\.dataset\?\.conversationId/);
    expect(calls).not.toContain("peerText.slice(1)");
  });
});
