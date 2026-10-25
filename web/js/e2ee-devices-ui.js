// Identity enrolment is automatic. New devices are untrusted until approved
// by a previously trusted device. This does NOT turn on the new E2EE protocol.
import {registerCurrentDevice,deviceStatus,approveTrustedDevice,revokeTrustedDevice} from './device-identity.js';
import {isEncryptionFeatureEnabled} from './owner-features.js';
let currentUser=null;
let generation=0;
const el=id=>document.getElementById(id);
function updateCardVisibility(){
  const card=el('e2ee-devices-card');
  if(card)card.hidden=!currentUser || !isEncryptionFeatureEnabled();
}
function status(message){const root=el('e2ee-devices-status');if(root)root.textContent=message;}
function text(parent,value){const span=document.createElement('span');span.textContent=value;parent.append(span);}
async function update(){
  if(!currentUser)return;
  const sequence=generation;
  const data=await deviceStatus(currentUser);
  if(sequence!==generation)return;
  const root=el('e2ee-devices-list');if(!root)return;
  root.replaceChildren();
  const own=data.devices.find(item=>item.deviceId===data.localDeviceId);
  const allowed=own?.trust==='active';
  for(const device of data.devices){
    const li=document.createElement('li');
    const name=device.deviceId===data.localDeviceId?'Это устройство':`Устройство ${device.deviceId.slice(0,8)}`;
    const state=device.trust==='active'?'доверенное':device.trust==='pending'?'ожидает подтверждения':'отозвано';
    text(li,`${name}, ${state}. `);
    if(device.trust==='pending' && allowed){
      const button=document.createElement('button');button.type='button';button.textContent=`Подтвердить ${name.toLowerCase()}`;
      button.addEventListener('click',()=>void action(button,()=>approveTrustedDevice(currentUser,device.deviceId)));
      li.append(button);
    }
    if(device.trust==='active' && allowed && device.deviceId!==data.localDeviceId){
      const button=document.createElement('button');button.type='button';button.textContent=`Отозвать ${name.toLowerCase()}`;
      button.addEventListener('click',()=>{
        if(window.confirm(`Отозвать доступ устройства ${device.deviceId.slice(0,8)}?`))
          void action(button,()=>revokeTrustedDevice(currentUser,device.deviceId));
      });li.append(button);
    }
    root.append(li);
  }
  if(own?.trust==='pending')status('Это новое устройство ожидает одобрения на ранее доверенном устройстве.');
  else if(own?.trust==='active')status('Ключи устройства зарегистрированы. Старые чаты пока используют прежнее шифрование.');
  else status('Нет активного ключа устройства.');
}
async function action(button,fn){
  const sequence=generation;
  button.disabled=true;
  try{await fn();if(sequence!==generation)return;await update();}
  catch(error){if(sequence===generation)status('Не удалось изменить доверие: '+error.message);}
  finally{button.disabled=false;}
}
export function setupE2eeDevices(){
  window.addEventListener('bulbam:features-changed',updateCardVisibility);
  window.addEventListener('bulbam:account-changed',event=>{
    generation++;
    currentUser=event.detail?.account?.userId??null;
    updateCardVisibility();
    const list=el('e2ee-devices-list');if(list)list.replaceChildren();
    status('');
    if(!currentUser)return;
    const accountId=currentUser,serial=generation;
    void registerCurrentDevice(accountId).then(()=>{
      if(serial!==generation)return;
      return update();
    }).catch(error=>{
      if(serial===generation)status('Регистрация устройства не удалась: '+error.message);
    });
  });
  el('e2ee-devices-refresh')?.addEventListener('click',()=>void update().catch(error=>status(error.message)));
}
