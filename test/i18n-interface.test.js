import {readFileSync} from "node:fs";
import {describe,expect,test,afterEach} from "vitest";
import {parseHTML} from "linkedom";
import {be} from "../web/js/locales/be.js";
import {setLanguage,setupI18n,translateText} from "../web/js/i18n.js";

const original={window:globalThis.window,document:globalThis.document,Node:globalThis.Node,
  NodeFilter:globalThis.NodeFilter,MutationObserver:globalThis.MutationObserver,localStorage:globalThis.localStorage};
function prepare(html){
  const {window:domWindow,document}=parseHTML(html);
  const window={dispatchEvent:()=>true,addEventListener:()=>{}};
  const storage=new Map();
  // linkedom models select.value as getter-only and lacks browser CustomEvent.
  // The real DOM supports both; these shims keep this test about our i18n logic.
  for(const el of document.querySelectorAll("select")){
    Object.defineProperty(el,"value",{
      get(){return this.getAttribute("data-selected")??"ru";},
      set(next){this.setAttribute("data-selected",next);}
    });
  }
  Object.assign(globalThis,{
    window,document,Node:domWindow.Node,NodeFilter:{SHOW_ELEMENT:1,SHOW_TEXT:4},
    MutationObserver:domWindow.MutationObserver,
    localStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)}
  });
  return {window,document,storage};
}
afterEach(()=>{
  for(const [key,value] of Object.entries(original)){
    if(value===undefined)delete globalThis[key];else globalThis[key]=value;
  }
});

describe("Belarusian localization",()=>{
  test("covers every fixed Russian interface phrase in HTML, except brand and names",()=>{
    const html=readFileSync(new URL("../web/index.html",import.meta.url),"utf8");
    const data=[...html.matchAll(/>([^<>]*[А-Яа-яЁё][^<>]*)</g)]
      .map(m=>m[1].trim()).filter(Boolean);
    const exceptions=new Set(["Бульбам","Б","Егор","Музыка","Назад"]);
    const missing=[...new Set(data)].filter(x=>!be[x]&&!exceptions.has(x));
    expect(missing).toEqual([]);
    expect(Object.keys(be).length).toBeGreaterThan(350);
  });

  test("switching language updates accessible labels and preserves user messages and typed names",()=>{
    const {document,storage}=prepare(
      '<!doctype html><html lang="ru"><body>'+
      '<label for="settings-language">Язык интерфейса</label>'+
      '<select id="settings-language"><option value="ru">Русский</option><option value="be">Беларуская</option></select>'+
      '<select id="welcome-language"><option value="ru">Русский</option><option value="be">Беларуская</option></select>'+
      '<button id="login-passkey" aria-label="Войти с помощью ключа доступа">Войти</button>'+
      '<div id="message-list"><p>Войти</p><button aria-label="Воспроизвести">Воспроизвести</button></div>'+
      '<div id="account-display-name">Егор</div><p id="status">Звонок не активен.</p>'+
      '</body></html>'
    );
    setupI18n();
    setLanguage("be");
    expect(document.documentElement.lang).toBe("be");
    expect(document.querySelector("#login-passkey").textContent).toBe("Увайсці");
    expect(document.querySelector("#login-passkey").getAttribute("aria-label")).toBe("Увайсці з дапамогай ключа доступу");
    expect(document.querySelector("#message-list p").textContent).toBe("Войти");
    expect(document.querySelector("#message-list button").textContent).toBe("Прайграць");
    expect(document.querySelector("#account-display-name").textContent).toBe("Егор");
    expect(document.querySelector("#status").textContent).toBe("Няма актыўнага званка.");
    expect(storage.get("bulbam.interface.language")).toBe("be");
    setLanguage("ru");
    expect(document.documentElement.lang).toBe("ru");
    expect(document.querySelector("#login-passkey").textContent).toBe("Войти");
    expect(document.querySelector("#message-list p").textContent).toBe("Войти");
    expect(document.querySelector("#status").textContent).toBe("Звонок не активен.");
  });

  test("dynamic call announcements retain names without translating them",()=>{
    prepare('<!doctype html><html lang="ru"><body><div id="live-status"></div></body></html>');
    setupI18n();
    setLanguage("be");
    expect(translateText("Входящий звонок от Егор.")).toBe("Уваходны званок ад Егор.");
    expect(translateText("Вы вошли как Настя.")).toBe("Вы ўвайшлі як Настя.");
  });
});
