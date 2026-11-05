import { openSettingsScreen } from "./settings-screens.js";
import { api, deviceName } from "./api.js";
import { announce, getCurrentAccount, showSignedIn } from "./ui.js";
import { loadSessions } from "./sessions.js";
import { showRecoveryCodes } from "./auth.js";

const STORAGE_KEY="bulbam.admin-recovery.pending";
const HELP_KEY="bulbam.admin-recovery.skip-help";
let pending=null, timer=null, refreshing=false;

function restore(){
  try {
    const value=JSON.parse(localStorage.getItem(STORAGE_KEY)||"null");
    if(value && typeof value.requestId==="string" && /^ar_[a-f0-9]{64}$/.test(value.secret))
      pending=value;
  }catch{}
}
function save(){
  try {
    if(pending)localStorage.setItem(STORAGE_KEY,JSON.stringify(pending));
    else localStorage.removeItem(STORAGE_KEY);
  }catch{}
}
function stopPolling(){if(timer)clearInterval(timer);timer=null;}
function startPolling(){
  stopPolling();
  if(pending)timer=setInterval(()=>void checkStatus(true),12000);
}
function state(message) {
  const el=document.querySelector("#admin-recovery-state");
  if(el)el.textContent=message;
}
function updateForm(){
  const area=document.querySelector("#admin-recovery-progress");
  if(area)area.hidden=!pending;

}
async function requestRecovery(event){
  event.preventDefault();
  const form=event.currentTarget,button=form.querySelector("button[type=submit]");
  button.disabled=true;
  try{
    const data=new FormData(form);
    const result=await api("/api/v1/auth/admin-recovery/request",{
      method:"POST",
      body:JSON.stringify({username:data.get("username"),deviceName:deviceName(),note:data.get("note")||""})
    });
    pending={requestId:result.requestId,secret:result.secret,
      verificationCode:result.verificationCode,expiresAt:result.expiresAt};
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
    pending=null;save();stopPolling();updateForm();
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
      if(current.fromLink)document.querySelector("#admin-recovery-complete [name=newPassword]")?.focus();
      if(!quiet)announce("Заявка одобрена. Можно установить новый пароль.");
    }else if(result.status==="denied" || result.status==="expired" || result.status==="consumed"){
      stopPolling();if(complete)complete.hidden=true;
      state(result.status==="denied"?"Администратор отклонил заявку.":"Заявка больше не действует. Отправьте новый запрос позже.");
      pending=null;save();
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
    pending=null;save();stopPolling();form.reset();updateForm();
    document.querySelector("#auth-view-recovery")?.removeAttribute("data-recovery-link");
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
async function refreshQueue(){
  if(refreshing)return;
  const account=getCurrentAccount();
  const area=document.querySelector("#admin-recovery-queue");
  const authorized=account?.role==="owner" || account?.role==="admin";
  if(area)area.hidden=!authorized;
  if(!authorized)return;
  refreshing=true;
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
        ", статус: "+(req.knownDevice?"Знакомое устройство (входил ранее)":"Новое неизвестное устройство")+
        ", время: "+new Date(req.createdAt).toLocaleString()+".";
      const noteLabel=document.createElement("p");
      noteLabel.textContent="Сообщение для администратора:";
      const note=document.createElement("p");
      if(req.note)note.dataset.userContent="";
      note.textContent=req.note||"Сообщение не оставлено.";
      const check=document.createElement("label");
      const verified=document.createElement("input");
      verified.type="checkbox";
      check.append(verified," Я независимо проверил личность владельца по заранее известному мне способу связи.");
      const approve=document.createElement("button");
      approve.type="button";approve.textContent="Одобрить";
      const linkButton=document.createElement("button");
      linkButton.type="button";linkButton.textContent="Одобрить и скопировать ссылку";
      linkButton.addEventListener("click",()=>void issueLink(req.username,verified.checked,req.requestId,linkButton));
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
          await refreshQueue();
          status.textContent=yes?`Заявка пользователя @${req.username} одобрена.`:`Заявка пользователя @${req.username} отклонена.`;
          status.focus({preventScroll:true});
        }catch(error){
          status.textContent="Решение не сохранено: "+error.message;
          announce(status.textContent);
          approve.disabled=deny.disabled=false;
        }
      }
      approve.addEventListener("click",()=>void decide(true));
      deny.addEventListener("click",()=>void decide(false));
      li.append(details,noteLabel,note,check,document.createTextNode(" "),approve,document.createTextNode(" "),linkButton,document.createTextNode(" "),deny);
      list.append(li);
    }
  }catch(error){status.textContent="Не удалось загрузить заявки: "+error.message;}
  finally{refreshing=false;}
}
async function issueLink(username,verifiedIdentity,requestId,button){
  if(!verifiedIdentity){
    announce("Сначала независимо проверьте личность пользователя и подтвердите это флажком.");
    return;
  }
  button.disabled=true;
  const status=document.querySelector("#admin-recovery-link-status") || document.querySelector("#admin-recovery-queue-status");
  try{
    const result=await api("/api/v1/admin/recovery-link",{
      method:"POST",body:JSON.stringify({username,verifiedIdentity,requestId})
    });
    const url=new URL(location.pathname,location.origin);
    url.hash=new URLSearchParams({recoveryId:result.requestId,recoveryToken:result.secret}).toString();
    const output=document.querySelector("#admin-recovery-link-output");
    const value=document.querySelector("#admin-recovery-link-value");
    if(value)value.value=url.href;
    if(output)output.hidden=false;
    try{
      await navigator.clipboard.writeText(url.href);
      if(status)status.textContent="Ссылка скопирована. Она действует 15 минут и подходит только для одного сброса пароля.";
      announce("Ссылка для сброса пароля скопирована.");
    }catch{
      if(status)status.textContent="Ссылка создана. Нажмите «Скопировать ссылку» или скопируйте её из поля.";
      announce("Ссылка создана. Скопируйте её отдельной кнопкой.");
    }
    void refreshQueue();
  }catch(error){
    if(status)status.textContent="Не удалось создать или скопировать ссылку: "+error.message;
    announce(status?.textContent||error.message);
  }finally{button.disabled=false;}
}
function restoreLink(){
  if(typeof location==="undefined")return;
  const url=new URL(location.href);
  const fragment=new URLSearchParams(url.hash.slice(1));
  const id=fragment.get("recoveryId");
  const secret=fragment.get("recoveryToken");
  if(!id&&!secret)return;
  url.hash="";
  history.replaceState(null,"",url.pathname+url.search+url.hash);
  if(!/^[0-9a-f-]{36}$/i.test(id||"")||!/^ar_[a-f0-9]{64}$/.test(secret||""))return;
  pending={requestId:id,secret,expiresAt:Date.now()+15*60_000,fromLink:true};
  updateForm();
  document.querySelector("#auth-view-login")?.setAttribute("hidden","");
  document.querySelector("#auth-view-register")?.setAttribute("hidden","");
  const recovery=document.querySelector("#auth-view-recovery");
  if(recovery){
    recovery.hidden=false;
    recovery.dataset.recoveryLink="active";
  }
  void checkStatus(true);
}
export function setupAdminRecovery(){
  restore();updateForm();startPolling();restoreLink();
  if(pending && !pending.fromLink)void checkStatus(true);
  document.querySelector("#admin-recovery-copy-link")?.addEventListener("click",async()=>{
    const field=document.querySelector("#admin-recovery-link-value");
    if(!field?.value)return;
    try{
      await navigator.clipboard.writeText(field.value);
      announce("Ссылка для сброса пароля скопирована.");
    }catch{
      field.focus();field.select();
      announce("Не удалось скопировать автоматически. Ссылка выделена, скопируйте её вручную.");
    }
  });
  document.querySelector("#admin-recovery-form")?.addEventListener("submit",requestRecovery);
  document.querySelector("#admin-recovery-link-form")?.addEventListener("submit",event=>{
    event.preventDefault();
    const form=event.currentTarget;
    const submit=form.querySelector("button[type=submit]");
    void issueLink(form.elements.username.value,form.elements.verifiedIdentity.checked,undefined,submit);
  });
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
    if(!["owner","admin"].includes(getCurrentAccount()?.role))return;
    const url=new URL(location.href);
    if(url.searchParams.get("reviewRecovery")!=="1")return;
    openSettingsScreen("security");
    document.querySelector("#admin-recovery-queue-title")?.focus();
    url.searchParams.delete("reviewRecovery");
    history.replaceState(null,"",url.pathname+url.search+url.hash);
  });
  document.addEventListener("visibilitychange",()=>{
    if(document.visibilityState==="visible" && pending)void checkStatus(true);
  });
  window.addEventListener("bulbam:admin-recovery-request",()=>{
    if(["owner","admin"].includes(getCurrentAccount()?.role)){
      announce("Поступила новая заявка на восстановление аккаунта.");
      void refreshQueue();
    }
  });
  // Never refresh on every settings click: that destroyed the confirmation
  // checkbox right after VoiceOver activated it.
  document.querySelector("#settings-button")?.addEventListener("click",()=>void refreshQueue());
  setInterval(()=>{if(["owner","admin"].includes(getCurrentAccount()?.role))void refreshQueue();},30000);
}