import {afterEach,expect,test,vi} from "vitest";
import {shouldAutoPlayNextVoice} from "../web/js/voice-autoplay-policy.js";
import {bindVoiceMaterializationTriggers,cachedVoiceResponse} from "../web/js/voice-webkit-timeline.js";
import {matchesChatFilter} from "../web/js/chat-filter-policy.js";
import {resetVoiceCueAudio,prepareVoiceCues} from "../web/js/voice-cues.js";
import {parseHTML} from "linkedom";
import {setLanguage} from "../web/js/i18n.js";

const previous={};
for(const key of ["AudioContext","document","window","caches","Node","NodeFilter","localStorage","CustomEvent"])previous[key]=globalThis[key];
afterEach(()=>{
 for(const [key,value] of Object.entries(previous)){
  if(value===undefined)delete globalThis[key];else globalThis[key]=value;
 }
 resetVoiceCueAudio();
 vi.restoreAllMocks();
});

test("autoplay skips own, completed and text messages, but proceeds to unheard incoming audio",()=>{
 expect(shouldAutoPlayNextVoice({kind:"voice",senderUserId:"other",completedAt:null},"me")).toBe(true);
 expect(shouldAutoPlayNextVoice({kind:"voice",senderUserId:"me",completedAt:null},"me")).toBe(false);
 expect(shouldAutoPlayNextVoice({kind:"voice",senderUserId:"other",completedAt:1234},"me")).toBe(false);
 expect(shouldAutoPlayNextVoice({kind:"text",senderUserId:"other",completedAt:null},"me")).toBe(false);
 expect(shouldAutoPlayNextVoice({kind:"voice",senderUserId:"other"},"")).toBe(false);
});
test("VoiceOver focus cannot start WebKit materialization, activation can",()=>{
 const listeners=new Map(),start=vi.fn();
 const button={addEventListener:(name,fn)=>listeners.set(name,fn)};
 bindVoiceMaterializationTriggers(button,start);
 expect(listeners.has("focus")).toBe(false);
 listeners.get("pointerdown")();
 listeners.get("click")();
 expect(start).toHaveBeenCalledTimes(2);
});
test("WebKit checks the existing per-account cache before network",async()=>{
 const cached={ok:true},match=vi.fn(async()=>cached);
 globalThis.window={caches:true};
 globalThis.caches={open:vi.fn(async()=>({match}))};
 expect(await cachedVoiceResponse("user-1","/voice/1")).toBe(cached);
 expect(globalThis.caches.open).toHaveBeenCalledWith("bulbam-voice-cache-v1-user-1");
 expect(match).toHaveBeenCalledWith("/voice/1");
});
test("chat filter matches only allowed visible content",()=>{
 expect(matchesChatFilter("Наташа @natasha Привет","наташа")).toBe(true);
 expect(matchesChatFilter("Наташа @natasha Привет","в сети")).toBe(false);
 expect(matchesChatFilter("Наташа @natasha Привет","17:35")).toBe(false);
 expect(matchesChatFilter("Наташа @natasha Привет","привет")).toBe(true);
});
test("interrupted iOS audio context is resumed or rebuilt",async()=>{
 const contexts=[];
 globalThis.AudioContext=class {
   constructor(){this.state=contexts.length?"running":"interrupted";this.resume=vi.fn(async()=>{this.state="running";});this.close=vi.fn(async()=>{});contexts.push(this);}
 };
 await prepareVoiceCues();
 expect(contexts[0].resume).toHaveBeenCalled();
 resetVoiceCueAudio();
 expect(contexts[0].close).toHaveBeenCalled();
});
test("Belarusian controls created dynamically can return to Russian, including attributes",()=>{
 const {window,document}=parseHTML("<html><body><button id='b'>Выйсці</button></body></html>");
 const storage=new Map();
 Object.assign(globalThis,{
   Node:window.Node,NodeFilter:{SHOW_ELEMENT:1,SHOW_TEXT:4},
   document,window:{dispatchEvent:()=>{}},
   localStorage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value)},
   CustomEvent:class{constructor(type,detail){this.type=type;this.detail=detail;}}
 });
 const button=document.getElementById("b");
 button.setAttribute("aria-label","Закрыть настройки");
 setLanguage("be");
 button.textContent="Выйсці";
 button.setAttribute("aria-label","Закрыць налады");
 setLanguage("ru");
 expect(button.textContent).toBe("Выйти");
 expect(button.getAttribute("aria-label")).toBe("Закрыть настройки");
});
