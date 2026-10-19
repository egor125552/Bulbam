import { be } from "./locales/be.js";

const KEY="bulbam.interface.language";
const supported=new Set(["ru","be"]);
const originalStrings=new WeakMap();
const originalAttributes=new WeakMap();
const inverse=new Map(Object.entries(be).map(([from,to])=>[to,from]));
const prefixTranslations=Object.entries(be).filter(([key])=>key.endsWith(":"));
const blocked="#message-list, #chat-list, #user-search-results, #account-display-name, #account-username, #account-id, #account-role, #conversation-title, #conversation-peer, textarea, code, pre";
let current="ru",observer=null;

const patterns=[
  [/^Привет, (.+)! Вот что умеет Бульбам\.$/,m=>`Вітаю, ${m[1]}! Вось што ўмее Бульбам.`],
  [/^Вы вошли как (.+)\.$/,m=>`Вы ўвайшлі як ${m[1]}.`],
  [/^Вы вошли как (.+) с помощью ключа доступа\.$/,m=>`Вы ўвайшлі як ${m[1]} з дапамогай ключа доступу.`],
  [/^Входящий звонок от (.+)\.$/,m=>`Уваходны званок ад ${m[1]}.`],
  [/^Звоним (.+)\.(.*)$/,m=>`Тэлефануем ${m[1]}.${m[2]}`],
  [/^Вы ответили (.+)\.(.*)$/,m=>`Вы адказалі ${m[1]}.${m[2]}`],
  [/^Звук звонка с (.+) восстанавливается\.$/,m=>`Гук званка з ${m[1]} аднаўляецца.`],
  [/^Активный звонок с (.+) найден\.$/,m=>`Актыўны званок з ${m[1]} знойдзены.`],
  [/^Собеседник переносит звонок\.(.*)$/,m=>`Суразмоўца пераносіць званок.${m[1]}`],
  [/^Пользователь @(.+), устройство: (.+), код заявки: (.+), время: (.+)\.$/,m=>
    `Карыстальнік @${m[1]}, прылада: ${m[2]}, код заяўкі: ${m[3]}, час: ${m[4]}.`],
  [/^Заявок: (\d+)$/,m=>`Заявак: ${m[1]}`],
  [/^Активных сессий: (\d+)\.$/,m=>`Актыўных сеансаў: ${m[1]}.`],
  [/^Последняя активность: (.+)$/,m=>`Апошняя актыўнасць: ${m[1]}`],
  [/^(.+) · текущая$/,m=>`${m[1]} · бягучая`],
  [/^Не удалось (.+): (.+)$/,m=>`Не ўдалося ${m[1]}: ${translateText(m[2])}`],
  [/^Ошибка (.+): (.+)$/,m=>`Памылка ${m[1]}: ${translateText(m[2])}`]
];

export function language(){return current;}
export function originalText(value){return inverse.get(value)??value;}
export function translateText(value) {
  if(current!=="be" || typeof value!=="string")return value;
  const trimmed=value.trim();
  if(!trimmed)return value;
  let translated=be[trimmed];
  if(!translated){
    for(const [regex,render] of patterns) {
      const match=trimmed.match(regex);
      if(match){translated=render(match);break;}
    }
  }
  if(!translated){
    // Dynamic errors include a runtime-supplied detail after a fixed prefix.
    // Translate only the interface prefix, never modify the detail itself.
    for(const [prefix,translation] of prefixTranslations){
      if(trimmed.startsWith(prefix+" ")){
        translated=translation+" "+trimmed.slice(prefix.length+1);
        break;
      }
    }
  }
  if(!translated)return value;
  const prefix=value.match(/^\s*/)?.[0]??"";
  const suffix=value.match(/\s*$/)?.[0]??"";
  return prefix+translated+suffix;
}
function shouldSkip(node) {
  if(!node || node.nodeType===Node.COMMENT_NODE)return true;
  const parent=node.nodeType===Node.ELEMENT_NODE?node:node.parentElement;
  if(!parent || parent.closest("script, style, noscript"))return true;
  if(parent.closest("[contenteditable=true]"))return true;
  if(parent.closest(blocked)) {
    // Only interface controls inside user-generated message areas may be translated.
    if(!parent.closest("button, option, label, summary"))return true;
  }
  return false;
}
function updateText(node){
  if(node.nodeType!==Node.TEXT_NODE || shouldSkip(node))return;
  const value=node.nodeValue??"";
  let memo=originalStrings.get(node);
  if(!memo || value!==memo.displayed) memo={original:value,displayed:value};
  const desired=current==="be"?translateText(memo.original):memo.original;
  memo.displayed=desired;
  originalStrings.set(node,memo);
  if(value!==desired)node.nodeValue=desired;
}
const attrs=["aria-label","placeholder","title","alt"];
function updateAttributes(el){
  if(el.nodeType!==Node.ELEMENT_NODE||shouldSkip(el))return;
  let map=originalAttributes.get(el);
  if(!map){map=new Map();originalAttributes.set(el,map);}
  for(const attr of attrs){
    if(!el.hasAttribute(attr))continue;
    const value=el.getAttribute(attr);
    let memo=map.get(attr);
    if(!memo || value!==memo.displayed)memo={original:value,displayed:value};
    const desired=current==="be"?translateText(memo.original):memo.original;
    memo.displayed=desired;
    map.set(attr,memo);
    if(value!==desired)el.setAttribute(attr,desired);
  }
}
function translateSubtree(root) {
  if(root.nodeType===Node.TEXT_NODE){updateText(root);return;}
  if(root.nodeType!==Node.ELEMENT_NODE||shouldSkip(root))return;
  updateAttributes(root);
  const walker=document.createTreeWalker(root,NodeFilter.SHOW_ELEMENT|NodeFilter.SHOW_TEXT);
  let node;
  while((node=walker.nextNode())){
    if(node.nodeType===Node.TEXT_NODE)updateText(node);
    else updateAttributes(node);
  }
}
export function setLanguage(next){
  if(!supported.has(next))next="ru";
  current=next;
  try{localStorage.setItem(KEY,next);}catch{}
  document.documentElement.lang=next;
  for(const select of [document.querySelector("#settings-language"),document.querySelector("#welcome-language")]){
    if(select)select.value=next;
  }
  translateSubtree(document.body);
  window.dispatchEvent(new CustomEvent("bulbam:language-changed",{detail:{language:next}}));
}
export function setupI18n(){
  let saved="ru";
  try{saved=localStorage.getItem(KEY)??"ru";}catch{}
  for(const id of ["settings-language","welcome-language"]){
    document.querySelector("#"+id)?.addEventListener("change",event=>setLanguage(event.target.value));
  }
  setLanguage(saved);
  observer?.disconnect();
  observer=new MutationObserver(records=>{
    for(const record of records){
      if(record.type==="characterData")updateText(record.target);
      else if(record.type==="attributes")updateAttributes(record.target);
      else for(const node of record.addedNodes)translateSubtree(node);
    }
  });
  observer.observe(document.body,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:attrs});
}
