import {openDeviceEnvelope} from './e2ee-device-envelopes.js';
import {decodeDeviceVoicePayload} from './e2ee-device-voice.js';
const DB='bulbam-e2ee-cipher-history-v2';
function open(){
 return new Promise((resolve,reject)=>{
  const req=indexedDB.open(DB,1);
  req.onupgradeneeded=()=>{const db=req.result;db.createObjectStore('envelopes',{keyPath:'key'});};
  req.onsuccess=()=>resolve(req.result);
  req.onerror=()=>reject(req.error??Error('Невозможно открыть локальную историю.'));
  req.onblocked=()=>reject(Error('Локальная история занята другой вкладкой.'));
 });
}
export async function saveEncryptedEnvelope(accountId,conversationId,envelope,senderDevice){
 const db=await open();
 const key=JSON.stringify([accountId,conversationId,envelope.envelopeId]);
 try{await new Promise((resolve,reject)=>{
  const tx=db.transaction('envelopes','readwrite');
  tx.objectStore('envelopes').put({key,accountId,conversationId,envelope,senderDevice});
  tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error??Error('Не сохранена шифрованная история.'));
  tx.onabort=()=>reject(tx.error??Error('Не сохранена шифрованная история.'));
 });}finally{db.close();}
}
export async function readEncryptedHistory(accountId,conversationId){
 const db=await open();
 try{
  const rows=await new Promise((resolve,reject)=>{
   const request=db.transaction('envelopes','readonly').objectStore('envelopes').getAll();
   request.onsuccess=()=>resolve(request.result??[]);
   request.onerror=()=>reject(request.error??Error('Не читается история.'));
  });
  const selected=rows.filter(row=>row.accountId===accountId&&row.conversationId===conversationId)
     .sort((a,b)=>a.envelope.createdAt-b.envelope.createdAt);
  const messages=[];
  for(const item of selected){
   const plaintext=await openDeviceEnvelope({accountId,conversationId,envelope:item.envelope,senderDevice:item.senderDevice});
   const voice=await decodeDeviceVoicePayload(plaintext,{
    conversationId,senderUserId:item.envelope.senderUserId,createdAt:item.envelope.createdAt,
    deliveredAt:item.envelope.createdAt
   });
   if(voice){messages.push(voice);continue;}
   messages.push({messageId:item.envelope.envelopeId,clientMessageId:item.envelope.clientMessageId,
    conversationId,senderUserId:item.envelope.senderUserId,text:plaintext,
    kind:'text',voice:null,createdAt:item.envelope.createdAt,deliveredAt:item.envelope.createdAt,
    readAt:null,e2eeV2:true});
  }
  return messages;
 }finally{db.close();}
}