import{test,expect}from"vitest";
import{createPendingMessageOutbox,isDisplayedConversation}from"../web/js/pending-message-outbox.js";

test("pending messages remain inside their own conversation through switching and acknowledgments",()=>{
 const outbox=createPendingMessageOutbox();
 const first={conversationId:"chat-a",clientMessageId:"msg-a",localState:"pending"};
 const second={conversationId:"chat-b",clientMessageId:"msg-b",localState:"pending"};
 outbox.add(first);outbox.add(second);
 expect(outbox.forConversation("chat-a")).toEqual([first]);
 expect(outbox.forConversation("chat-b")).toEqual([second]);
 first.localState="failed";
 outbox.remove(second);
 expect(outbox.forConversation("chat-a")).toEqual([first]);
 expect(outbox.forConversation("chat-b")).toEqual([]);
 expect(isDisplayedConversation({conversationId:"chat-b"},first)).toBe(false);
 expect(isDisplayedConversation({conversationId:"chat-a"},first)).toBe(true);
 outbox.clear();
 expect(outbox.forConversation("chat-a")).toEqual([]);
});
