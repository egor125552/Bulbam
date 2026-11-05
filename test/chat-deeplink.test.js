import {test,expect} from "vitest";
import {takeRequestedChat} from "../web/js/chat-deeplink.js";
const id="01234567-89ab-cdef-0123-456789abcdef";

test("push navigation opens the requested chat while clearing only that URL parameter",()=>{
 const replacements=[];
 const found=takeRequestedChat("https://bulbam.test/?chat="+id+"&mode=compact",x=>replacements.push(x));
 expect(found).toBe(id);
 expect(replacements).toEqual(["/?mode=compact"]);
});
test("active call links are left for the call system, and invalid chat IDs are ignored",()=>{
 const replaced=[];
 expect(takeRequestedChat("https://bulbam.test/?chat="+id+"&call=active",x=>replaced.push(x))).toBeNull();
 expect(takeRequestedChat("https://bulbam.test/?chat=not-a-chat",x=>replaced.push(x))).toBeNull();
 expect(replaced).toEqual([]);
});
