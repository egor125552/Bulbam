import {api} from './api.js';

// Future flags can use the same owner-only API and settings category.
let encryptionEnabled=false;
let currentAccount=null;
let refreshPromise=null;
let lastBroadcast=null;
export function isEncryptionFeatureEnabled(){return encryptionEnabled;}

function applyState(){
  const owner=currentAccount?.role==='owner';
  const card=document.querySelector('#feature-controls-card');
  if(card)card.hidden=!owner;
  const input=document.querySelector('#feature-encryption');
  if(input)input.checked=encryptionEnabled;
  if(lastBroadcast!==encryptionEnabled){
    lastBroadcast=encryptionEnabled;
    window.dispatchEvent(new CustomEvent('bulbam:features-changed',{detail:{encryption:encryptionEnabled}}));
  }
}

export async function refreshFeatures(){
  if(!currentAccount){encryptionEnabled=false;applyState();return;}
  if(refreshPromise)return refreshPromise;
  refreshPromise=(async()=>{
    const result=await api('/api/v1/features');
    if(typeof result.features?.encryption!=='boolean')throw new Error('Неверный ответ настроек функций.');
    encryptionEnabled=result.features.encryption;
    applyState();
  })().finally(()=>{refreshPromise=null;});
  return refreshPromise;
}

export function setupOwnerFeatures(){
  const check=document.querySelector('#feature-encryption');
  const status=document.querySelector('#feature-controls-status');
  check?.addEventListener('change',async()=>{
    const desired=check.checked;
    check.disabled=true;
    try{
      const result=await api('/api/v1/admin/features/encryption',{
        method:'PUT',body:JSON.stringify({enabled:desired})
      });
      encryptionEnabled=result.enabled;
      if(status)status.textContent=encryptionEnabled?'Защита доступна всем аккаунтам.':'Защита скрыта для всех аккаунтов.';
      applyState();
    }catch(error){
      check.checked=encryptionEnabled;
      if(status)status.textContent='Не удалось сохранить настройку: '+error.message;
    }finally{check.disabled=false;}
  });
  window.addEventListener('bulbam:account-changed',event=>{
    currentAccount=event.detail?.account??null;
    applyState();
    void refreshFeatures().catch(()=>{});
  });
  // Changes from another browser are picked up without push notifications.
  const refreshIfVisible=()=>{
    if(document.visibilityState==='visible' && currentAccount)void refreshFeatures().catch(()=>{});
  };
  document.addEventListener('visibilitychange',refreshIfVisible);
  window.addEventListener('focus',refreshIfVisible);
  window.setInterval(()=>{
    refreshIfVisible();
  },30000);
  applyState();
}
