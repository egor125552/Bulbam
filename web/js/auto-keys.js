// Experimental account-pinned P-256 ECDH handshake, usable on the FIRST
// enrolled device per account. This is NOT Signal, multi-device E2EE, or a ratchet.
import {api} from './api.js';
const DB='bulbam-auto-identity-v1';
const VERSION=1;
const enc=new TextEncoder();
function crypt(){
  if(!globalThis.crypto?.subtle||!globalThis.crypto?.getRandomValues)
    throw new Error('В этом браузере недоступен защищённый обмен ключами.');
  return globalThis.crypto;
}
function pub(jwk){return JSON.stringify({kty:jwk?.kty,crv:jwk?.crv,x:jwk?.x,y:jwk?.y});}
function openDB(){
  return new Promise((resolve,reject)=>{
    if(!globalThis.indexedDB)return reject(new Error('Локальное хранилище ключей недоступно.'));
    const request=indexedDB.open(DB,VERSION);
    request.onupgradeneeded=()=>{
      if(!request.result.objectStoreNames.contains('identity'))request.result.createObjectStore('identity');
      if(!request.result.objectStoreNames.contains('pins'))request.result.createObjectStore('pins');
    };
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error??new Error('Не удалось открыть ключи устройства.'));
    request.onblocked=()=>reject(new Error('Хранилище ключей занято.'));
  });
}
async function read(store,id){
  const db=await openDB();
  try{return await new Promise((resolve,reject)=>{
    const req=db.transaction(store,'readonly').objectStore(store).get(id);
    req.onsuccess=()=>resolve(req.result??null);
    req.onerror=()=>reject(req.error??new Error('Не удалось прочитать защищённое хранилище.'));
  });}finally{db.close();}
}
async function add(store,id,value){
  const db=await openDB();
  try{return await new Promise((resolve,reject)=>{
    const tx=db.transaction(store,'readwrite');
    tx.objectStore(store).add(value,id);
    tx.oncomplete=()=>resolve(true);
    tx.onerror=()=>reject(tx.error??new Error('Не удалось записать ключ.'));
    tx.onabort=()=>reject(tx.error??new Error('Не удалось записать ключ.'));
  });}finally{db.close();}
}
export async function existingIdentity(accountId){
  if(!accountId)return null;
  return read('identity',accountId);
}

export async function localIdentity(accountId){
  if(typeof accountId!=='string'||!accountId)throw new Error('Сначала войдите в аккаунт.');
  const existing=await read('identity',accountId);
  if(existing)return existing;
  const pair=await crypt().subtle.generateKey({name:'ECDH',namedCurve:'P-256'},false,['deriveBits']);
  const publicKey=await crypt().subtle.exportKey('jwk',pair.publicKey);
  const record={publicKey:JSON.parse(pub(publicKey)),privateKey:pair.privateKey};
  try{await add('identity',accountId,record);return record;}
  catch(error){
    // Concurrent tabs can generate different first-use keys. Keep the first.
    const saved=await read('identity',accountId);
    if(saved)return saved;
    throw error;
  }
}
export async function registerIdentity(accountId,request=api){
  const identity=await localIdentity(accountId);
  await request('/api/v1/keys/identity',{method:'PUT',body:JSON.stringify({publicKey:identity.publicKey})});
  return identity;
}
export async function deriveAutoChatKey({accountId,peerUserId,conversationId,request=api}){
  if(!accountId||!peerUserId||!conversationId||accountId===peerUserId)
    throw new Error('Неверные участники автоматического обмена.');
  const own=await registerIdentity(accountId,request);
  const response=await request(`/api/v1/chats/${encodeURIComponent(conversationId)}/keys`);
  const publishedOwn=response.keys?.[accountId];
  if(!publishedOwn||pub(publishedOwn)!==pub(own.publicKey))
    throw new Error('Публичный ключ этого аккаунта на сервере изменён. Автоматическая отправка остановлена.');
  const peer=response.keys?.[peerUserId];
  if(!peer)return null;
  const peerPublic=await crypt().subtle.importKey('jwk',peer,{name:'ECDH',namedCurve:'P-256'},false,[]);
  const pinId=JSON.stringify([accountId,peerUserId]);
  const pinned=await read('pins',pinId);
  if(pinned&&pinned!==pub(peer))
    throw new Error('Ключ собеседника изменился. Проверьте его личность: отправка остановлена.');
  if(!pinned){
    try{await add('pins',pinId,pub(peer));}
    catch{
      if(await read('pins',pinId)!==pub(peer))throw new Error('Ключ собеседника изменился во время проверки.');
    }
  }
  const shared=await crypt().subtle.deriveBits({name:'ECDH',public:peerPublic},own.privateKey,256);
  const hkdf=await crypt().subtle.importKey('raw',shared,'HKDF',false,['deriveKey']);
  const userIds=[accountId,peerUserId].sort();
  const key=await crypt().subtle.deriveKey({name:'HKDF',hash:'SHA-256',
    salt:enc.encode(JSON.stringify(['bulbam-auto-v1',conversationId,...userIds])),
    info:enc.encode('bulbam:text-and-voice:aes-gcm-256')},hkdf,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
  return key;
}
