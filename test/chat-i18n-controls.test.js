import {test,expect} from "vitest";
import {parseHTML} from "linkedom";
import {setLanguage} from "../web/js/i18n.js";
test("translates voice controls within a blocked message list",()=>{
  const {document,window}=parseHTML('<html><body><div id="message-list"><p id="body">Войти</p><section class="voice-message" aria-label="Голосовое сообщение, 0:15"><button id="play">Воспроизвести</button><input class="voice-progress" aria-label="Положение голосового сообщения" aria-valuetext="0:05 из 0:15"><span class="voice-time">0:05 из 0:15</span><span class="voice-listen-status">Прослушано полностью</span></section></div></body></html>');
  const saved={document:globalThis.document,window:globalThis.window,Node:globalThis.Node,NodeFilter:globalThis.NodeFilter,localStorage:globalThis.localStorage};
  Object.assign(globalThis,{document,window:{dispatchEvent:()=>{}},Node:window.Node,NodeFilter:{SHOW_ELEMENT:1,SHOW_TEXT:4},localStorage:{setItem:()=>{}}});
  try{
    setLanguage("be");
    expect(document.querySelector("#body").textContent).toBe("Войти");
    expect(document.querySelector("#play").textContent).toBe("Прайграць");
    expect(document.querySelector(".voice-progress").getAttribute("aria-valuetext")).toBe("0:05 з 0:15");
    expect(document.querySelector(".voice-time").textContent).toBe("0:05 з 0:15");
    expect(document.querySelector(".voice-listen-status").textContent).toBe("Праслухана цалкам");
    setLanguage("ru");
    expect(document.querySelector("#play").textContent).toBe("Воспроизвести");
  }finally{for(const [key,value] of Object.entries(saved))if(value===undefined)delete globalThis[key];else globalThis[key]=value;}
});
