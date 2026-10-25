import {webcrypto} from 'node:crypto';
import {afterAll,beforeAll,test,expect} from 'vitest';
import 'fake-indexeddb/auto';
import {registerIdentity,deriveAutoChatKey} from '../web/js/auto-keys.js';
import {encryptText,decryptText} from '../web/js/secure-messages.js';
let originalCrypto;
beforeAll(()=>{originalCrypto=globalThis.crypto;Object.defineProperty(globalThis,'crypto',{value:webcrypto,configurable:true});});
afterAll(()=>{if(originalCrypto)Object.defineProperty(globalThis,'crypto',{value:originalCrypto,configurable:true});});
const keys={};
const conversationId='33333333-3333-4333-8333-333333333333';
const a='11111111-1111-4111-8111-111111111111',b='22222222-2222-4222-8222-222222222222';
function request(user){return async(path,options={})=>{
 if(path==='/api/v1/keys/identity'){
   const incoming=JSON.parse(options.body).publicKey;
   if(keys[user] && JSON.stringify(keys[user])!==JSON.stringify(incoming))throw new Error('409 key changed');
   keys[user]=incoming;return {registered:true};
 }
 if(path.endsWith('/keys'))return {keys:{...keys}};
 throw new Error('Unknown mocked URL '+path);
};}
test('two accounts automatically derive exactly the same nonexportable secret',async()=>{
 await registerIdentity(a,request(a));await registerIdentity(b,request(b));
 const first=await deriveAutoChatKey({accountId:a,peerUserId:b,conversationId,request:request(a)});
 const second=await deriveAutoChatKey({accountId:b,peerUserId:a,conversationId,request:request(b)});
 expect(first.extractable).toBe(false);
 const context={conversationId,senderUserId:a,clientMessageId:'cm_abcdefgh1'};
 const ciphertext=await encryptText('Автоматически, без пересылки секрета',first,context);
 expect(await decryptText(ciphertext,second,context)).toBe('Автоматически, без пересылки секрета');
 await expect(decryptText(ciphertext,second,{...context,conversationId:'wrong'})).rejects.toThrow();
});
test('pinned peer key must never silently change',async()=>{
 const attacker=await webcrypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},false,['deriveBits']);
 const other=await webcrypto.subtle.exportKey('jwk',attacker.publicKey);
 const hijacked=async(path,options)=>path.endsWith('/keys')?{keys:{[a]:keys[a],[b]:other}}:request(a)(path,options);
 await expect(deriveAutoChatKey({accountId:a,peerUserId:b,conversationId,request:hijacked})).rejects.toThrow(/изменился/);
});
test('no downgrade to plaintext when peer has not registered',async()=>{
 const pending=await deriveAutoChatKey({accountId:a,peerUserId:'55555555-5555-4555-8555-555555555555',conversationId,request:request(a)});
 expect(pending).toBeNull();
});
