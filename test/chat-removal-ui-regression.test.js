import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

test("all selected-chat removal paths use the common conversation closer",()=>{
  const source=readFileSync(new URL("../web/js/messenger.js",import.meta.url),"utf8");
  expect(source).toContain("function closeSelectedConversation() {");
  expect(source).toContain("else closeSelectedConversation();");
  expect(source).toContain("if(selectedChat?.conversationId===payload.conversationId)closeSelectedConversation();");
  expect(source).toContain("if(own)closeSelectedConversation();");
  expect(source).toContain('new CustomEvent("bulbam:chat-changed", { detail: { chat: null } })');
});
