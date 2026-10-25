import {api} from './api.js';
import {localDeviceIdentity,deviceStatus} from './device-identity.js';
import {sendDeviceText} from './e2ee-device-envelopes.js';

const base64=bytes=>{
 let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte);
 return btoa(binary).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
};
const fromBase64=value=>{
 if(typeof value!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(value))throw Error('Неверный ключ голосового сообщения.');
 const raw=atob(value.replace(/-/g,'+').replace(/_/g,'/')+'=');
 const bytes=Uint8Array.from(raw,c=>c.charCodeAt(0));
 if(bytes.length!==32)throw Error('Неверный размер ключа голосового.');
 return bytes;
};
export async function importDeviceVoiceKey(raw){
 const input=fromBase64(raw);
 return crypto.subtle.importKey('raw',input,'AES-GCM',false,['encrypt','decrypt']);
}
export async function prepareDeviceVoice({accountId,conversationId,recipientUserId,request=api}){
 const me=await deviceStatus(accountId,request);
 if(!me.devices.some(d=>d.deviceId===me.localDeviceId&&d.trust==='active'))
  throw Error('Для записи требуется доверенное устройство.');
 const directory=await request('/api/v1/chats/'+conversationId+'/e2ee/devices');
 const recipients=directory.users?.find(item=>item.userId===recipientUserId)?.devices??[];
 if(!recipients.length)throw Error('У собеседника ещё нет доверенных ключей.');
 const bytes=crypto.getRandomValues(new Uint8Array(32));
 return {rawKey:base64(bytes),key:await crypto.subtle.importKey('raw',bytes,'AES-GCM',false,['encrypt','decrypt'])};
}
export function makeDeviceVoicePayload({messageId,clientMessageId,mimeType,durationMs,sizeBytes,key}){
 if(!/^[0-9a-f-]{36}$/i.test(messageId)||typeof clientMessageId!=='string'||clientMessageId.length>100||
   typeof mimeType!=='string'||!/^application\/vnd\.bulbam\.encrypted-voice;v=1;/.test(mimeType)||
   !Number.isSafeInteger(durationMs)||durationMs<=0||
   !Number.isSafeInteger(sizeBytes)||sizeBytes<=16)
  throw Error('Неверная ссылка на зашифрованное голосовое.');
 fromBase64(key);
 return JSON.stringify({kind:'voice-v2',messageId,clientMessageId,mimeType,durationMs,sizeBytes,key});
}
export async function publishDeviceVoice({accountId,conversationId,recipientUserId,voiceMessage,rawKey,request=api}){
 const wire=makeDeviceVoicePayload({
  messageId:voiceMessage.messageId,clientMessageId:voiceMessage.clientMessageId,
  mimeType:voiceMessage.voice.mimeType,durationMs:voiceMessage.voice.durationMs,
  sizeBytes:voiceMessage.voice.sizeBytes,key:rawKey
 });
 return sendDeviceText({accountId,conversationId,recipientUserId,text:wire,request,clientMessageId:voiceMessage.clientMessageId});
}
export async function decodeDeviceVoicePayload(text,context){
 if(typeof text!=='string'||text[0]!=='{')return null;
 let obj;try{obj=JSON.parse(text);}catch{return null;}
 if(obj?.kind!=='voice-v2')return null;
 const encoded=makeDeviceVoicePayload(obj);
 if(encoded!==text)throw Error('Нарушена целостность описания голосового.');
 const voiceKey=await importDeviceVoiceKey(obj.key);
 return {messageId:obj.messageId,clientMessageId:obj.clientMessageId,
  conversationId:context.conversationId,senderUserId:context.senderUserId,kind:'voice',
  text:'Голосовое сообщение',voice:{
   mimeType:obj.mimeType,durationMs:obj.durationMs,sizeBytes:obj.sizeBytes,progress:null
  },voiceKey,e2eeV2:true,createdAt:context.createdAt,deliveredAt:context.deliveredAt,readAt:null};
}
