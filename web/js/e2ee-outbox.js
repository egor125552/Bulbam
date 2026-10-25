// Stores only already encrypted per-device envelopes for resumable retries.
// A repeated clientMessageId must resend identical ciphertext, not make a
// different packet that the server rejects as a conflicting duplicate.
const DATABASE='bulbam-e2ee-outbox-v2';
const STORE='encrypted-packets';
const encoder=new TextEncoder();
const hex=bytes=>Array.from(new Uint8Array(bytes),n=>n.toString(16).padStart(2,'0')).join('');
const keyFor=(accountId,conversationId,clientMessageId)=>JSON.stringify([accountId,conversationId,clientMessageId]);
function dbOpen(){
 return new Promise((resolve,reject)=>{
  const request=indexedDB.open(DATABASE,1);
  request.onupgradeneeded=()=>{request.result.createObjectStore(STORE);};
  request.onsuccess=()=>resolve(request.result);
  request.onerror=()=>reject(request.error??Error('Невозможно сохранить шифрованную отправку.'));
  request.onblocked=()=>reject(Error('Очередь зашифрованных сообщений занята.'));
 });
}
async function operation(id,kind,value){
 const db=await dbOpen();
 try{return await new Promise((resolve,reject)=>{
  const tx=db.transaction(STORE,kind==='get'?'readonly':'readwrite');
  const object=tx.objectStore(STORE);
  const request=kind==='get'?object.get(id):kind==='put'?object.put(value,id):object.delete(id);
  let result;
  request.onsuccess=()=>{result=request.result;};
  tx.oncomplete=()=>resolve(result);
  tx.onerror=()=>reject(tx.error??Error('Ошибка очереди шифрования.'));
  tx.onabort=()=>reject(tx.error??Error('Не удалось сохранить очередь шифрования.'));
 });}finally{db.close();}
}
export async function loadEncryptedOutbox(accountId,conversationId,clientMessageId,text){
 const id=keyFor(accountId,conversationId,clientMessageId);
 const digest=hex(await crypto.subtle.digest('SHA-256',encoder.encode(text)));
 const data=await operation(id,'get');
 if(data && data.digest!==digest)throw Error('Идентификатор сообщения уже занят другим содержимым.');
 return data??{digest,packets:{}};
}
export async function saveEncryptedOutbox(accountId,conversationId,clientMessageId,data){
 return operation(keyFor(accountId,conversationId,clientMessageId),'put',data);
}
export async function clearEncryptedOutbox(accountId,conversationId,clientMessageId){
 return operation(keyFor(accountId,conversationId,clientMessageId),'delete');
}
