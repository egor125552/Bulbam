import { openSettingsScreen } from "./settings-screens.js";
import { api, deviceName } from "./api.js";
import { announce, getCurrentAccount, showSignedIn } from "./ui.js";
import { loadSessions } from "./sessions.js";
import { showRecoveryCodes } from "./auth.js";

const STORAGE_KEY="bulbam.admin-recovery.pending";
const QUEUE_SYNC_KEY="bulbam.admin-recovery.queue-sync";
const HELP_KEY="bulbam.admin-recovery.skip-help";
let pending=null, timer=null, refreshing=false, refreshQueued=false;
let lastAnnouncedApprovedId=null, lastRequestAnnouncementAt=0;

function parsePending(raw){
  try {
    const value=JSON.parse(raw||"null");
    if(value && typeof value.requestId==="string" && /^ar_[a-f0-9]{64}$/.test(value.secret))
      return value;
  }catch{}
  return null;
}
function restore(){
  try {
    pending=parsePending(localStorage.getItem(STORAGE_KEY));
  }catch{
    pending=null;
  }
}
function save(){
  try {
    if(pending)localStorage.setItem(STORAGE_KEY,JSON.stringify(pending));
    else localStorage.removeItem(STORAGE_KEY);
  }catch{}
}
function notifyQueueSync(){
  try{localStorage.setItem(QUEUE_SYNC_KEY,String(Date.now()));}catch{}
}
function stopPolling(){if(timer)clearInterval(timer);timer=null;}
function startPolling(){
  stopPolling();
  if(pending)timer=setInterval(()=>void checkStatus(true),5000);
}
function state(message) {
  const el=document.querySelector("#admin-recovery-state");
  if(el)el.textContent=message;
}
function updateForm(){
  const area=document.querySelector("#admin-recovery-progress");
  if(area)area.hidden=!pending;
  const code=document.querySelector("#admin-recovery-verification");
  if(code)code.textContent=pending?.verificationCode||"";
  if(!pending){
    const complete=document.querySelector("#admin-recovery-complete");
    if(complete)complete.hidden=true;
  }
}
async function requestRecovery(event){
  event.preventDefault();
  const form=event.currentTarget,button=form.querySelector("button[type=submit]");
  button.disabled=true;
  try{
    const data=new FormData(form);
    const result=await api("/api/v1/auth/admin-recovery/request",{
      method:"POST",
      body:JSON.stringify({username:data.get("username"),deviceName:deviceName()})
    });
    pending={requestId:result.requestId,secret:result.secret,
      verificationCode:result.verificationCode,expiresAt:result.expiresAt};
    lastAnnouncedApprovedId=null;
    save();updateForm();startPolling();
    state(result.message);
    announce("Запрос отправлен. Ожидайте решения администратора.");
    await checkStatus(true);
  }catch(error){announce("Не удалось отправить запрос: "+error.message);}
  finally{button.disabled=false;}
}
async function checkStatus(quiet=false){
  if(!pending)return;
  const current=pending;
  if(current.expiresAt<=Date.now()){
    pending=null;lastAnnouncedApprovedId=null;save();stopPolling();updateForm();
    state("Срок заявки истёк. Отправьте новую заявку.");
    return;
  }
  try{
    const result=await api("/api/v1/auth/admin-recovery/status",{
      method:"POST",body:JSON.stringify({requestId:current.requestId,secret:current.secret})
    });
    if(pending!==current)return;
    const complete=document.querySelector("#admin-recovery-complete");
    if(result.status==="approved"){
      stopPolling();
      if(complete)complete.hidden=false;
      state("Администратор подтвердил заявку. Установите новый пароль в течение 15 минут.");
      const firstApproval=lastAnnouncedApprovedId!==current.requestId;
      if(firstApproval){
        lastAnnouncedApprovedId=current.requestId;
        if(!getCurrentAccount()){
          const recoveryView=document.querySelector("#auth-view-recovery");
          if(recoveryView?.hidden){
            window.dispatchEvent(new CustomEvent("bulbam:show-auth-view",{detail:{view:"recovery"}}));
          }
        }
      }
      if(!quiet || firstApproval){
        announce("Заявка одобрена. Можно установить новый пароль.");
      }
    }else if(result.status==="denied" || result.status==="expired" || result.status==="consumed"){
      stopPolling();if(complete)complete.hidden=true;
      state(result.status==="denied"?"Администратор отклонил заявку.":"Заявка больше не действует. Отправьте новый запрос позже.");
      pending=null;lastAnnouncedApprovedId=null;save();
    }else{
      if(complete)complete.hidden=true;
      state("Ожидаем решения администратора. Не закрывайте эту вкладку, чтобы увидеть результат, или вернитесь к ней позднее.");
    }
  }catch(error){if(!quiet)announce("Проверка заявки не удалась: "+error.message);}
}
async function completeRecovery(event){
  event.preventDefault();
  if(!pending)return;
  const form=event.currentTarget,button=form.querySelector("button[type=submit]");
  const data=new FormData(form);
  if(data.get("newPassword")!==data.get("confirmPassword")){
    announce("Новые пароли не совпадают.");return;
  }
  button.disabled=true;
  try {
    const result=await api("/api/v1/auth/admin-recovery/complete",{
      method:"POST",
      body:JSON.stringify({
        requestId:pending.requestId,secret:pending.secret,
        newPassword:data.get("newPassword"),deviceName:deviceName()
      })
    });
    pending=null;lastAnnouncedApprovedId=null;save();stopPolling();form.reset();updateForm();
    // This user is returning after account recovery, not a new registrant.
    try{localStorage.setItem("bulbam.welcome.v1."+result.account.userId,"yes");}catch{}
    showSignedIn(result.account,result.session);
    announce("Пароль изменён. Вы вошли в Бульбам.");
    await loadSessions({quiet:true});
    const codesDialog=document.querySelector("#recovery-codes-dialog");
    showRecoveryCodes(result.recoveryCodes);
    const showHelp=()=>{
      try{
        if(localStorage.getItem(HELP_KEY)!=="yes"){
          const dialog=document.querySelector("#admin-recovery-help");
          dialog?.showModal();
          document.querySelector("#admin-recovery-help-title")?.focus();
        }
      }catch{}
    };
    if(codesDialog?.open)codesDialog.addEventListener("close",showHelp,{once:true});
    else showHelp();
  }catch(error){announce("Не удалось завершить восстановление: "+error.message);}
  finally{button.disabled=false;}
}
function isManagerAccount(){
  const role=getCurrentAccount()?.role;
  return role==="owner" || role==="admin";
}
async function refreshQueue(){
  if(refreshing){
    refreshQueued=true;
    return;
  }
  const area=document.querySelector("#admin-recovery-queue");
  const authorized=isManagerAccount();
  if(area)area.hidden=!authorized;
  if(!authorized)return;
  refreshing=true;
  refreshQueued=false;
  const list=document.querySelector("#admin-recovery-requests");
  const status=document.querySelector("#admin-recovery-queue-status");
  try{
    const result=await api("/api/v1/admin/recovery-requests");
    // Polling and settings navigation must not replace a checked checkbox or
    // move VoiceOver away from the active recovery request.
    const existing=new Map([...list.children].map(item=>[item.dataset.requestId,item]));
    const current=new Set((result.requests??[]).map(req=>req.requestId));
    for(const [id,item] of existing)if(!current.has(id))item.remove();
    const summary=current.size?"Заявок: "+current.size:"Новых заявок нет.";
    if(status.textContent!==summary)status.textContent=summary;
    for(const req of result.requests??[]){
      if(existing.has(req.requestId))continue;
      const li=document.createElement("li");
      li.dataset.requestId=req.requestId;
      const details=document.createElement("p");
      details.textContent="Пользователь @"+req.username+", устройство: "+req.deviceName+
        ", код заявки: "+req.verificationCode+", время: "+
        new Date(req.createdAt).toLocaleString()+".";
      const check=document.createElement("label");
      const verified=document.createElement("input");
      verified.type="checkbox";
      check.append(verified," Я независимо проверил личность владельца по заранее известному мне способу связи.");
      const approve=document.createElement("button");
      approve.type="button";approve.textContent="Одобрить";
      const deny=document.createElement("button");
      deny.type="button";deny.textContent="Отклонить";
      async function decide(yes){
        if(yes && !verified.checked){
          announce("Сначала независимо проверьте личность пользователя и подтвердите это флажком.");
          verified.focus();return;
        }
        approve.disabled=deny.disabled=true;
        status.textContent=yes?"Одобряю заявку…":"Отклоняю заявку…";
        try{
          await api("/api/v1/admin/recovery-requests/"+encodeURIComponent(req.requestId)+"/decision",{
            method:"POST",body:JSON.stringify({approve:yes,verifiedIdentity:verified.checked})
          });
          li.remove();
          notifyQueueSync();
          await refreshQueue();
          status.textContent=yes?`Заявка пользователя @${req.username} одобрена.`:`Заявка пользователя @${req.username} отклонена.`;
          status.focus({preventScroll:true});
        }catch(error){
          status.textContent="Решение не сохранено: "+error.message;
          announce(status.textContent);
          approve.disabled=deny.disabled=false;
          void refreshQueue();
        }
      }
      approve.addEventListener("click",()=>void decide(true));
      deny.addEventListener("click",()=>void decide(false));
      li.append(details,check,document.createTextNode(" "),approve,document.createTextNode(" "),deny);
      list.append(li);
    }
  }catch(error){status.textContent="Не удалось загрузить заявки: "+error.message;}
  finally{
    refreshing=false;
    if(refreshQueued){
      refreshQueued=false;
      void refreshQueue();
    }
  }
}
export function setupAdminRecovery(){
  restore();updateForm();startPolling();
  if(pending)void checkStatus(true);
  document.querySelector("#admin-recovery-form")?.addEventListener("submit",requestRecovery);
  document.querySelector("#admin-recovery-complete")?.addEventListener("submit",completeRecovery);
  document.querySelector("#admin-recovery-check")?.addEventListener("click",()=>void checkStatus());
  document.querySelector("#admin-recovery-refresh")?.addEventListener("click",()=>void refreshQueue());
  document.querySelector("#admin-recovery-help-close")?.addEventListener("click",()=>{
    if(document.querySelector("#admin-recovery-help-skip")?.checked){
      try{localStorage.setItem(HELP_KEY,"yes");}catch{}
    }
    document.querySelector("#admin-recovery-help")?.close();
  });
  window.addEventListener("bulbam:account-changed",()=>{
    void refreshQueue();
    if(!isManagerAccount())return;
    const url=new URL(location.href);
    if(url.searchParams.get("reviewRecovery")!=="1")return;
    openSettingsScreen("security");
    document.querySelector("#admin-recovery-queue-title")?.focus();
    url.searchParams.delete("reviewRecovery");
    history.replaceState(null,"",url.pathname+url.search+url.hash);
  });
  let lastReturnSyncAt = 0;
  const isCallActive = () =>
    typeof document !== "undefined" && document.documentElement?.dataset?.bulbamCallActive === "true";
  const syncOnReturn=()=>{
    if (isCallActive()) return;
    const now = Date.now();
    if (now - lastReturnSyncAt < 1500) return;
    lastReturnSyncAt = now;
    if(pending)void checkStatus(true);
    if(isManagerAccount())void refreshQueue();
  };
  document.addEventListener("visibilitychange",()=>{
    if(document.visibilityState==="visible")syncOnReturn();
  });
  window.addEventListener("focus",syncOnReturn);
  window.addEventListener("storage",(event)=>{
    if(event.key===STORAGE_KEY){
      const next=parsePending(event.newValue);
      pending=next;
      if(!pending)lastAnnouncedApprovedId=null;
      updateForm();
      startPolling();
      if(pending)void checkStatus(true);
    }else if(event.key===QUEUE_SYNC_KEY && isManagerAccount()){
      void refreshQueue();
    }
  });
  window.addEventListener("bulbam:admin-recovery-request",()=>{
    if(isManagerAccount()){
      const now=Date.now();
      if(now-lastRequestAnnouncementAt>3000){
        lastRequestAnnouncementAt=now;
        announce("Поступила новая заявка на восстановление аккаунта.");
      }
      void refreshQueue();
    }
  });
  window.addEventListener("bulbam:admin-recovery-updated",()=>{
    if(isManagerAccount())void refreshQueue();
  });
  // Never refresh on every settings click: that destroyed the confirmation
  // checkbox right after VoiceOver activated it.
  document.querySelector("#settings-button")?.addEventListener("click",()=>void refreshQueue());
  document.addEventListener("click",(event)=>{
    const button=event.target?.closest?.('[data-open-settings="security"]');
    if(button && isManagerAccount())void refreshQueue();
  });
  setInterval(()=>{if(isManagerAccount() && !isCallActive())void refreshQueue();},30000);
}
