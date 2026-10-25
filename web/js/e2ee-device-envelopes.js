import {api} from './api.js';
import {localDeviceIdentity,deviceStatus} from './device-identity.js';
import {saveEncryptedEnvelope,readEncryptedHistory} from './e2ee-history.js';
import {loadEncryptedOutbox,saveEncryptedOutbox,clearEncryptedOutbox,listEncryptedOutbox} from './e2ee-outbox.js';
const enc=new TextEncoder(),dec=new TextDecoder();
const pub=k=>({kty:'EC',crv:'P-256',x:k.x,y:k.y});
const b64=data=>{let s='';for(const n of new Uint8Array(data))s+=String.fromCharCode(n);return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');};
const bytes=s=>{if(typeof s!=='string'||!/^[A-Za-z0-9_-]+$/.test(s))throw Error('Повреждённые данные.');const x=atob(s.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-s.length%4)%4));return Uint8Array.from(x,c=>c.charCodeAt(0));};
const proof=(id,sender,e)=>JSON.stringify(['bulbam/e2ee-device-envelope/v2',id,sender,e.clientMessageId,e.senderDeviceId,e.recipientUserId,e.recipientDeviceId,e.ephemeralPublicKey,e.nonce,e.ciphertext]);
const kdf=(id,sender,e)=>JSON.stringify(['bulbam/e2ee-device-kdf/v2',id,sender,e.clientMessageId,e.senderDeviceId,e.recipientUserId,e.recipientDeviceId,e.ephemeralPublicKey]);
async function secret(privateKey,publicKey,context){
  const peer=await crypto.subtle.importKey('jwk',publicKey,{name:'ECDH',namedCurve:'P-256'},false,[]);
  const shared=await crypto.subtle.deriveBits({name:'ECDH',public:peer},privateKey,256);
  const hkdf=await crypto.subtle.importKey('raw',shared,'HKDF',false,['deriveKey']);
  return crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt:enc.encode(context),info:enc.encode('bulbam-device-envelope-aes-gcm-v2')},hkdf,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}
export async function createDeviceEnvelope({accountId,conversationId,recipientUserId,recipientDevice,plaintext,clientMessageId}){
 if(!recipientDevice||recipientDevice.trust!=='active')throw Error('Устройство получателя ещё не доверенное.');
 if(typeof plaintext!=='string'||!plaintext.trim()||enc.encode(plaintext).byteLength>8192)throw Error('Текст должен быть от 1 до 8192 байт.');
 const local=await localDeviceIdentity(accountId);
 const ephemeral=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},false,['deriveBits']);
 const unsigned={version:2,clientMessageId:clientMessageId??crypto.randomUUID(),senderDeviceId:local.bundle.deviceId,recipientUserId,recipientDeviceId:recipientDevice.deviceId,ephemeralPublicKey:pub(await crypto.subtle.exportKey('jwk',ephemeral.publicKey)),nonce:b64(crypto.getRandomValues(new Uint8Array(12)))};
 const context=kdf(conversationId,accountId,unsigned);
 const aes=await secret(ephemeral.privateKey,recipientDevice.identityAgreement,context);
 const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv:bytes(unsigned.nonce),additionalData:enc.encode(context)},aes,enc.encode(plaintext));
 const packet={...unsigned,ciphertext:b64(ciphertext)};
 const signature=await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},local.signingPrivate,enc.encode(proof(conversationId,accountId,packet)));
 return {...packet,signature:b64(signature)};
}
export async function openDeviceEnvelope({accountId,conversationId,envelope,senderDevice}){
 const local=await localDeviceIdentity(accountId);
 if(envelope.version!==2||envelope.conversationId!==conversationId||envelope.recipientUserId!==accountId||envelope.recipientDeviceId!==local.bundle.deviceId||senderDevice?.deviceId!==envelope.senderDeviceId)throw Error('Подмена устройства или разговора.');
 const signing=await crypto.subtle.importKey('jwk',senderDevice.identitySigning,{name:'ECDSA',namedCurve:'P-256'},false,['verify']);
 const valid=await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},signing,bytes(envelope.signature),enc.encode(proof(conversationId,envelope.senderUserId,envelope)));
 if(!valid)throw Error('Недействительная подпись отправителя.');
 const context=kdf(conversationId,envelope.senderUserId,envelope);
 const aes=await secret(local.agreementPrivate,envelope.ephemeralPublicKey,context);
 return dec.decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes(envelope.nonce),additionalData:enc.encode(context)},aes,bytes(envelope.ciphertext)));
}
export async function sendDeviceText({accountId,conversationId,recipientUserId,text,request=api,clientMessageId}){
 const me=await deviceStatus(accountId,request);
 if(!me.devices.some(d=>d.deviceId===me.localDeviceId&&d.trust==='active'))throw Error('Это устройство ещё не доверенное.');
 const directory=await request('/api/v1/chats/'+conversationId+'/e2ee/devices');
 const recipients=directory.users?.find(x=>x.userId===recipientUserId)?.devices??[];
 if(!recipients.length)throw Error('У собеседника нет доверенных устройств.');
 const copies=directory.users?.find(x=>x.userId===accountId)?.devices??[];
 const id=clientMessageId??crypto.randomUUID();
 const outbox=await loadEncryptedOutbox(accountId,conversationId,id,text);
 const recipientsToDeliver=[...recipients.map(d=>[recipientUserId,d]),...copies.map(d=>[accountId,d])];
 // Prepare and persist every ciphertext BEFORE posting the first one. This
 // survives partial multi-device delivery and a page reload mid-transfer.
 for(const [uid,device] of recipientsToDeliver){
  const key=uid+':'+device.deviceId;
  if(!outbox.packets[key]){
   outbox.packets[key]=await createDeviceEnvelope({accountId,conversationId,
    recipientUserId:uid,recipientDevice:device,plaintext:text,clientMessageId:id});
  }
 }
 await saveEncryptedOutbox(accountId,conversationId,id,outbox);
 for(const [uid,device] of recipientsToDeliver){
  const envelope=outbox.packets[uid+':'+device.deviceId];
  await request('/api/v1/chats/'+conversationId+'/e2ee/envelopes',{
   method:'POST',body:JSON.stringify(envelope)
  });
 }
 await clearEncryptedOutbox(accountId,conversationId,id);
 return {clientMessageId:id,recipientDeviceCount:recipients.length,otherOwnDeviceCount:copies.length};
}
export async function receiveDeviceText({accountId,conversationId,request=api}){
 const own=await localDeviceIdentity(accountId);
 const directory=await request('/api/v1/chats/'+conversationId+'/e2ee/devices');
 const inbox=await request('/api/v1/chats/'+conversationId+'/e2ee/envelopes?deviceId='+own.bundle.deviceId);
 const messages=[];
 for(const envelope of inbox.envelopes??[]){
  const sender=directory.users?.find(x=>x.userId===envelope.senderUserId)?.devices?.find(d=>d.deviceId===envelope.senderDeviceId);
  const signer=sender??(envelope.senderSigningKey?{
    deviceId:envelope.senderDeviceId,identitySigning:envelope.senderSigningKey
  }:null);
  if(!signer)throw Error('Неизвестное устройство отправителя.');
  await openDeviceEnvelope({accountId,conversationId,envelope,senderDevice:signer});
  await saveEncryptedEnvelope(accountId,conversationId,envelope,signer);
  const ackPayload=JSON.stringify(['bulbam/e2ee-envelope-ack/v2',conversationId,accountId,own.bundle.deviceId,envelope.envelopeId]);
  const signature=b64(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},own.signingPrivate,enc.encode(ackPayload)));
  await request('/api/v1/chats/'+conversationId+'/e2ee/envelopes/'+envelope.envelopeId+'/ack',{method:'POST',body:JSON.stringify({deviceId:own.bundle.deviceId,signature})});
 }
 return readEncryptedHistory(accountId,conversationId);
}
// Recover a partly sent text or voice-key notification after tab closure.
// Only ciphertext is kept locally, never the original message body.
export async function resumeDeviceOutbox({accountId,conversationId,request=api}){
 const me=await deviceStatus(accountId,request);
 if(!me.devices.some(d=>d.deviceId===me.localDeviceId&&d.trust==='active'))
  throw Error('Это устройство больше не доверенное.');
 const rows=await listEncryptedOutbox(accountId,conversationId);
 let delivered=0;
 for(const row of rows){
  for(const envelope of Object.values(row.packets)){
   await request('/api/v1/chats/'+conversationId+'/e2ee/envelopes',{
    method:'POST',body:JSON.stringify(envelope)
   });
  }
  await clearEncryptedOutbox(accountId,conversationId,row.clientMessageId);
  delivered++;
 }
 return delivered;
}
