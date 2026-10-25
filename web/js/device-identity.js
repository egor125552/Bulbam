// Device-key foundation for the next E2EE protocol.
// Never supplies keys to the legacy account-wide ECDH code or unlocks a chat.
import {api} from './api.js';
const STORE='device-identity';
const DATABASE='bulbam-e2ee-devices-v1';
const encoder=new TextEncoder();
const asPublic=key=>({kty:'EC',crv:'P-256',x:key.x,y:key.y});
const asBase64=bytes=>{
  const data=new Uint8Array(bytes);
  let raw='';for(const byte of data)raw+=String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
};
function subtle(){
  if(!globalThis.crypto?.subtle||!globalThis.crypto?.randomUUID)
    throw new Error('Устройство не поддерживает защищённые ключи.');
  return crypto.subtle;
}
function openDB(){
  return new Promise((resolve,reject)=>{
    const request=indexedDB.open(DATABASE,1);
    request.onupgradeneeded=()=>{
      if(!request.result.objectStoreNames.contains(STORE))request.result.createObjectStore(STORE);
    };
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error??new Error('Невозможно открыть локальное хранилище ключей.'));
    request.onblocked=()=>reject(new Error('Хранилище ключей занято другой вкладкой.'));
  });
}
async function stored(accountId,value){
  const db=await openDB();
  try{return await new Promise((resolve,reject)=>{
    const tx=db.transaction(STORE,value?'readwrite':'readonly');
    const request=value?tx.objectStore(STORE).add(value,accountId):tx.objectStore(STORE).get(accountId);
    request.onsuccess=()=>{if(!value)resolve(request.result??null);};
    tx.oncomplete=()=>{if(value)resolve(value);};
    tx.onabort=()=>reject(tx.error??new Error('Невозможно сохранить устройство.'));
    tx.onerror=()=>reject(tx.error??new Error('Ошибка сохранения ключей.'));
  });}finally{db.close();}
}
const envelope=(kind,userId,deviceId,bundle,approverDeviceId)=>{
  if(kind==='prekey')return JSON.stringify(['bulbam/device-prekey/v1',userId,deviceId,bundle.signedPrekey]);
  if(kind==='registration')return JSON.stringify(['bulbam/device-registration/v1',userId,deviceId,
    bundle.identitySigning,bundle.identityAgreement,bundle.signedPrekey,bundle.prekeySignature]);
  if(kind==='approval')return JSON.stringify(['bulbam/device-approval/v1',userId,approverDeviceId,deviceId,
    bundle.identitySigning,bundle.identityAgreement,bundle.signedPrekey]);
  if(kind==='revoke')return JSON.stringify(['bulbam/device-revoke/v1',userId,approverDeviceId,deviceId]);
  throw new Error('Unknown device proof type');
};
async function sign(pair,content){
  return asBase64(await subtle().sign({name:'ECDSA',hash:'SHA-256'},pair.privateKey,encoder.encode(content)));
}
async function makeIdentity(accountId){
  const deviceId=crypto.randomUUID();
  const signing=await subtle().generateKey({name:'ECDSA',namedCurve:'P-256'},false,['sign','verify']);
  const agreement=await subtle().generateKey({name:'ECDH',namedCurve:'P-256'},false,['deriveBits']);
  const prekey=await subtle().generateKey({name:'ECDH',namedCurve:'P-256'},false,['deriveBits']);
  const bundle={deviceId,
    identitySigning:asPublic(await subtle().exportKey('jwk',signing.publicKey)),
    identityAgreement:asPublic(await subtle().exportKey('jwk',agreement.publicKey)),
    signedPrekey:asPublic(await subtle().exportKey('jwk',prekey.publicKey))};
  bundle.prekeySignature=await sign(signing,envelope('prekey',accountId,deviceId,bundle));
  bundle.registrationSignature=await sign(signing,envelope('registration',accountId,deviceId,bundle));
  return {bundle,signingPrivate:signing.privateKey,agreementPrivate:agreement.privateKey,
    signedPrekeyPrivate:prekey.privateKey};
}
export async function localDeviceIdentity(accountId){
  if(!accountId)throw new Error('Нет авторизованного аккаунта.');
  const old=await stored(accountId);
  if(old)return old;
  const generated=await makeIdentity(accountId);
  try{return await stored(accountId,generated);}
  catch(error){
    const winner=await stored(accountId);
    if(winner)return winner;
    throw error;
  }
}
export async function registerCurrentDevice(accountId,request=api){
  const local=await localDeviceIdentity(accountId);
  const result=await request('/api/v1/e2ee/devices',{method:'POST',body:JSON.stringify(local.bundle)});
  if(result.device?.deviceId!==local.bundle.deviceId||
    JSON.stringify(result.device?.identitySigning)!==JSON.stringify(local.bundle.identitySigning))
    throw new Error('Сервер вернул другую идентичность устройства.');
  return result.device;
}
export async function deviceStatus(accountId,request=api){
  const local=await localDeviceIdentity(accountId);
  const result=await request('/api/v1/e2ee/devices');
  return {localDeviceId:local.bundle.deviceId,devices:result.devices??[]};
}
export async function approveTrustedDevice(accountId,pendingDeviceId,request=api){
  const local=await localDeviceIdentity(accountId);
  const result=await deviceStatus(accountId,request);
  const own=result.devices.find(x=>x.deviceId===local.bundle.deviceId&&x.trust==='active');
  const pending=result.devices.find(x=>x.deviceId===pendingDeviceId&&x.trust==='pending');
  if(!own||!pending)throw new Error('Для подтверждения нужно ранее доверенное устройство.');
  const signature=asBase64(await subtle().sign({name:'ECDSA',hash:'SHA-256'},local.signingPrivate,
    encoder.encode(envelope('approval',accountId,pending.deviceId,pending,own.deviceId))));
  return request('/api/v1/e2ee/devices/approve',{method:'POST',
    body:JSON.stringify({approverDeviceId:own.deviceId,newDeviceId:pending.deviceId,signature})});
}
export async function revokeTrustedDevice(accountId,targetDeviceId,request=api){
  const local=await localDeviceIdentity(accountId);
  const {devices}=await deviceStatus(accountId,request);
  const own=devices.find(x=>x.deviceId===local.bundle.deviceId&&x.trust==='active');
  const target=devices.find(x=>x.deviceId===targetDeviceId&&x.trust==='active');
  if(!own||!target||own.deviceId===target.deviceId)throw new Error('Для отзыва нужно другое доверенное устройство.');
  const signature=asBase64(await subtle().sign({name:'ECDSA',hash:'SHA-256'},local.signingPrivate,
    encoder.encode(envelope('revoke',accountId,target.deviceId,target,own.deviceId))));
  return request('/api/v1/e2ee/devices/revoke',{method:'POST',
    body:JSON.stringify({approverDeviceId:own.deviceId,deviceId:target.deviceId,signature})});
}
