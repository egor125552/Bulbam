import {parseHTML} from "linkedom";
import {test,expect} from "vitest";
import {applyMessageScreenReaderSemantics} from "../web/js/message-screenreader-policy.js";

test("text message no longer duplicates its children with a named group",()=>{
 const {document}=parseHTML('<ul><li class="message" role="group" aria-label="Аня: Привет. 13:00"><strong>Аня</strong><p>Привет</p><time>13:00</time></li></ul>');
 applyMessageScreenReaderSemantics(document);
 const item=document.querySelector(".message");
 expect(item.hasAttribute("aria-label")).toBe(false);
 expect(item.hasAttribute("role")).toBe(false);
 expect(item.querySelector("p").textContent).toBe("Привет");
 expect(item.querySelector("time").textContent).toBe("13:00");
});
test("voice player keeps its own accessible name and interactive controls",()=>{
 const {document}=parseHTML('<ul><li class="message" role="group" aria-label="Петя: голосовое сообщение"><section class="voice-message" aria-label="Голосовое сообщение, 0:12"><button>Воспроизвести</button></section></li></ul>');
 applyMessageScreenReaderSemantics(document);
 expect(document.querySelector(".message").getAttribute("aria-label")).toBe(null);
 expect(document.querySelector(".voice-message").getAttribute("aria-label")).toBe("Голосовое сообщение, 0:12");
 expect(document.querySelector(".voice-message button").textContent).toBe("Воспроизвести");
});
test("interactive retry and read-receipt buttons stay focusable",()=>{
 const {document}=parseHTML('<div class="message" role="group" aria-label="Ошибка отправки"><button id="retry">Повторить отправку</button><button id="readers">Кто прочитал</button></div>');
 applyMessageScreenReaderSemantics(document);
 expect(document.querySelector("#retry").hasAttribute("hidden")).toBe(false);
 expect(document.querySelector("#readers").hasAttribute("aria-hidden")).toBe(false);
});
