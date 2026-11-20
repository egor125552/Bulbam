import { announce, getCurrentAccount } from "./ui.js";

const KEY="bulbam.welcome.v1.";
let queuedFor=null;

function seen(userId) {
  try {return localStorage.getItem(KEY+userId)==="yes";}catch{return false;}
}
function markSeen(userId) {
  try {localStorage.setItem(KEY+userId,"yes");}catch{}
}
function showWhenReady(userId){
  const account=getCurrentAccount();
  if(account?.userId!==userId || seen(userId))return;
  // This introduction is for recently registered members, not every
  // long-standing account opening a different browser.
  if(!Number.isFinite(account.createdAt) || Date.now()-account.createdAt > 24*60*60_000)return;
  const dialog=document.querySelector("#bulbam-welcome-dialog");
  if(!dialog || dialog.open)return;
  const blocking=Array.from(document.querySelectorAll("dialog[open]")).find(d=>d!==dialog);
  if(blocking){
    blocking.addEventListener("close",()=>queueMicrotask(()=>showWhenReady(userId)),{once:true});
    return;
  }
  const name=document.querySelector("#bulbam-welcome-name");
  if(name) name.textContent="Привет, "+account.displayName+"! Вот что умеет Бульбам.";
  queuedFor=userId;
  dialog.showModal();
  document.querySelector("#bulbam-welcome-title")?.focus();
}
export function setupWelcome(){
  document.querySelector("#bulbam-welcome-close")?.addEventListener("click",()=>{
    const dialog=document.querySelector("#bulbam-welcome-dialog");
    if(queuedFor)markSeen(queuedFor);
    queuedFor=null;
    dialog?.close();
    document.querySelector("#chats-title")?.focus();
  });
  document.querySelector("#bulbam-welcome-dialog")?.addEventListener("close",()=>{
    if(queuedFor)markSeen(queuedFor);
    queuedFor=null;
  });
  window.addEventListener("bulbam:account-changed",event=>{
    const id=event.detail?.account?.userId;
    if(id && !seen(id))setTimeout(()=>showWhenReady(id),350);
  });
}
