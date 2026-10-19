import {readFileSync} from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import {IDBFactory} from "fake-indexeddb";
import {parseHTML} from "linkedom";
import {describe,test,expect,afterEach} from "vitest";
import {be} from "../web/js/locales/be.js";
import {setLanguage,translateText} from "../web/js/i18n.js";
import {translateServerText,localizeApiResponse} from "../worker/src/i18n.ts";
import {chatPreview,chatAccessibleLabel,dayLabel} from "../web/js/chat-presentation.js";

const original={};
for(const key of ["Node","NodeFilter","window","document","localStorage","CustomEvent"]){
 original[key]=globalThis[key];
}
afterEach(()=>{
 for(const [key,value] of Object.entries(original)){
   if(value===undefined)delete globalThis[key];else globalThis[key]=value;
 }
});

function installPage() {
 const {window,document}=parseHTML(`<!doctype html><html lang="ru"><body>
 <label for="settings-language">Язык интерфейса</label>
 <select id="settings-language"><option value="ru">Русский</option><option value="be">Беларуская</option></select>
 <select id="welcome-language"><option value="ru">Русский</option><option value="be">Беларуская</option></select>
 <button id="transfer">Перенести звонок на это устройство</button>
 <p id="state"></p><div id="message-list"><p id="real-message">Привет, ты здесь?</p></div>
 <div id="account-display-name">Александр</div>
 <div id="live-status"></div>
 <link rel="manifest" href="/manifest.webmanifest">
 </body></html>`);
 for(const id of ["settings-language","welcome-language"]){
   const el=document.getElementById(id);
   Object.defineProperty(el,"value",{
      get(){return this.getAttribute("data-selected")??"ru";},
      set(value){this.setAttribute("data-selected",value);}
   });
 }
 const settings=new Map();
 Object.assign(globalThis,{
  Node:window.Node,NodeFilter:{SHOW_ELEMENT:1,SHOW_TEXT:4},
  document,window:{dispatchEvent(){}},
  localStorage:{getItem:k=>settings.get(k)??null,setItem:(k,v)=>settings.set(k,v)},
  CustomEvent:class {constructor(type,detail){this.type=type;this.detail=detail;}}
 });
 return {document,settings};
}
describe("whole-product Belarusian localization",()=>{
 test("translates dynamic calls, server errors and VoiceOver statuses without rewriting names",()=>{
  const {document}=installPage();
  setLanguage("be");
  const examples=[
    ["Входящий звонок от Екатерина.","Уваходны званок ад Екатерина."],
    ["Вы вошли как Александр с помощью ключа доступа.","Вы ўвайшлі як Александр з дапамогай ключа доступу."],
    ["Новое сообщение от Войти.","Новае паведамленне ад Войти."],
    ["Входящий звонок от Войти.","Уваходны званок ад Войти."],
    ["Активных сессий: 4.","Актыўных сеансаў: 4."],
    ["Не удалось открыть чат: Диалог не найден.","Не ўдалося адкрыць чат: Дыялог не знойдзены."],
    ["Новых сообщений от Дмитрий: 2.","Новых паведамленняў ад Дмитрий: 2."]
  ];
  for(const [source,target] of examples)
    expect(translateText(source)).toBe(target);
  document.querySelector("#state").textContent="Входящий звонок от Екатерина.";
  // Direct translation uses the same audited dictionary as DOM updates.
  expect(translateText(document.querySelector("#state").textContent))
    .toBe("Уваходны званок ад Екатерина.");
  expect(document.querySelector("#real-message").textContent).toBe("Привет, ты здесь?");
  expect(document.querySelector("#account-display-name").textContent).toBe("Александр");
  expect(document.documentElement.lang).toBe("be");
  expect(dayLabel(new Date("2026-10-01T13:00:00Z").getTime(),new Date("2026-10-19T13:00:00Z"))).toMatch(/кастрычніка/);
  expect(chatPreview({kind:"voice",senderUserId:"me"},"me")).toBe("Вы: Галасавое паведамленне");
  expect(chatPreview({kind:"text",senderUserId:"me",text:"Войти"},"me")).toBe("Вы: Войти");
  expect(chatAccessibleLabel({peer:{displayName:"Егор",username:"egor125"},lastMessage:{kind:"text",senderUserId:"other",text:"Привет, Егор!"}},"me"))
    .toContain("Привет, Егор!");
  expect(document.querySelector('link[rel="manifest"]').getAttribute("href")).toBe("/manifest-be.webmanifest");
  setLanguage("ru");
  expect(document.documentElement.lang).toBe("ru");
 });
 test("every Cyrillic JS/TS interface literal is present in dictionary unless deliberate proper noun or markup",()=>{
  const fs=readFileSync;
  const child=(dir)=>import("node:fs").then(({readdirSync})=>{
    const walk=d=>readdirSync(d,{withFileTypes:true}).flatMap(entry=>{
      const f=d+"/"+entry.name;
      return entry.isDirectory()?walk(f):/\.(js|ts)$/.test(f)?[f]:[];
    });
    return walk(dir);
  });
  // Tests run inside project root in Vitest.
  return Promise.all([child("web/js"),child("worker/src")]).then(([front,back])=>{
    const intentional=new Set(["Б","Бульбам","Вы","собеседником","{{0}} Гц","{{0}} канал","{{0}} на 15 секунд. {{1}}."]);
    const missing=[];
    for(const f of [...front,...back]){
      if(f.includes("/locales/")||f.endsWith("/i18n.js")||f.endsWith("/i18n.ts"))continue;
      const source=fs(f,"utf8");
      const ast=ts.createSourceFile(f,source,ts.ScriptTarget.Latest,true);
      const visit=node=>{
        if(ts.isStringLiteral(node)||ts.isNoSubstitutionTemplateLiteral(node)||ts.isTemplateExpression(node)){
          const value=ts.isTemplateExpression(node)
            ? node.head.text+node.templateSpans.map((span,index)=>`{{${index}}}`+span.literal.text).join("")
            : node.text;
          if(/[А-Яа-яЁё]/.test(value)&&!be[value]&&!intentional.has(value)
            &&!value.startsWith("<label>"))missing.push([f,value]);
        }
        ts.forEachChild(node,visit);
      };
      visit(ast);
    }
    expect(missing).toEqual([]);
  });
 });
 test("API message localizer translates only explicit server metadata, not message payloads",async()=>{
  const request=new Request("https://bulbam.example/api/v1/chats",{"headers":{"accept-language":"be-BY,ru;q=0.9"}});
  const original={error:{code:"forbidden",message:"Недостаточно прав."},chat:{text:"Привет, как дела?",displayName:"Егор"}};
  const response=new Response(JSON.stringify(original),{status:403,headers:{"content-type":"application/json"}});
  const beResponse=await localizeApiResponse(request,response);
  const data=await beResponse.json();
  expect(data.error.message).toBe("Недастаткова правоў.");
  expect(data.error.code).toBe("forbidden");
  expect(data.chat.text).toBe("Привет, как дела?");
  expect(data.chat.displayName).toBe("Егор");
  expect(translateServerText("Дыялог не знойдзены.")).toBe("Дыялог не знойдзены.");
 });
 test("Service Worker stores device language and localizes call/admin notifications, not chat previews",async()=>{
  const listeners={};
  const notifications=[];
  const self={
   addEventListener:(type,fn)=>listeners[type]=fn,
   skipWaiting:()=>{},
   clients:{matchAll:async()=>[],claim:async()=>{}},
   registration:{showNotification:async(title,params)=>notifications.push({title,...params})},
   location:{origin:"https://bulbam.example"}
  };
  const ctx={self,indexedDB:new IDBFactory(),Promise,URL,console};
  vm.runInNewContext(readFileSync(new URL("../web/sw.js",import.meta.url),"utf8"),ctx);
  async function send(type,props){
   let promise=Promise.resolve();
   const event={...props,waitUntil:p=>promise=Promise.resolve(p)};
   listeners[type](event);await promise;
  }
  await send("message",{data:{type:"bulbam.locale",locale:"be"}});
  await send("push",{data:{json:()=>({kind:"call",title:"Входящий звонок — Егор",
   body:"Нажмите, чтобы открыть Бульбам и ответить.",data:{url:"/"}})}});
  expect(notifications.at(-1).title).toBe("Уваходны званок — Егор");
  expect(notifications.at(-1).body).toBe("Націсніце, каб адкрыць Бульбам і адказаць.");
  await send("push",{data:{json:()=>({kind:"admin-recovery",title:"Бульбам: запрос восстановления",
   body:"Новая заявка. Прежде чем одобрить, проверьте личность пользователя.",data:{url:"/"}})}});
  expect(notifications.at(-1).title).toBe("Бульбам: запыт аднаўлення");
  await send("push",{data:{json:()=>({kind:"message",title:"Егор",
   body:"Привет, спасибо!",data:{url:"/"}})}});
  expect(notifications.at(-1).title).toBe("Егор");
  expect(notifications.at(-1).body).toBe("Привет, спасибо!");
 });
});
