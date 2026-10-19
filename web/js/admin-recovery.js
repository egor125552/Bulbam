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
  const code=document.querySelector("#admin-recovery-verification");
  if(code)code.textContent=pending?.verificationCode||"";
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
    list.replaceChildren();
    if(!result.requests?.length){status.textContent="Новых заявок нет.";return;}
    status.textContent="Заявок: "+result.requests.length;
    for(const req of result.requests){
      const li=document.createElement("li");
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
        try{
          await api("/api/v1/admin/recovery-requests/"+encodeURIComponent(req.requestId)+"/decision",{
            method:"POST",body:JSON.stringify({approve:yes,verifiedIdentity:verified.checked})
          });
          announce(yes?"Заявка одобрена.":"Заявка отклонена.");
          setTimeout(()=>void refreshQueue(),0);
        }catch(error){
          announce("Решение не сохранено: "+error.message);
          approve.disabled=deny.disabled=false;
        }
      }
      approve.addEventListener("click",()=>void decide(true));
      deny.addEventListener("click",()=>void decide(false));
      li.append(details,check,document.createTextNode(" "),approve,document.createTextNode(" "),deny);
      list.append(li);
    }
  }catch(error){status.textContent="Не удалось загрузить заявки: "+error.message;}
  finally{refreshing=false;}
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
  document.querySelector("#settings-dialog")?.addEventListener("click",()=>void refreshQueue());
  setInterval(()=>{if(["owner","admin"].includes(getCurrentAccount()?.role))void refreshQueue();},30000);
}
