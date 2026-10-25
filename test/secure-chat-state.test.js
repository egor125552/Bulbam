import {webcrypto} from 'node:crypto';
import {beforeAll,afterAll,test,expect} from 'vitest';
import 'fake-indexeddb/auto';
import {generateConversationSecret,saveConversationKey} from '../web/js/secure-messages.js';
import {setSecureConversation,getSecureChatState} from '../web/js/secure-chat-ui.js';
import {localIdentity} from '../web/js/auto-keys.js';
let priorCrypto, priorDocument;
beforeAll(()=>{
 priorCrypto=globalThis.crypto;priorDocument=globalThis.document;
 Object.defineProperty(globalThis,'crypto',{configurable:true,value:webcrypto});
 globalThis.document={getElementById:()=>null,querySelector:()=>null};
});
afterAll(()=>{
 if(priorCrypto)Object.defineProperty(globalThis,'crypto',{configurable:true,value:priorCrypto});
 if(priorDocument)globalThis.document=priorDocument;else delete globalThis.document;
});
test('preserves a non-exportable key when the chat flips from plain to protected',async()=>{
 const account={userId:'secure-state-account'}, chat={kind:'direct',conversationId:'secure-state-chat',encryptionMode:'plain'};
 const secret=generateConversationSecret();await saveConversationKey(account.userId,chat.conversationId,secret);
 await setSecureConversation(account,chat);
 const before=getSecureChatState();expect(before.key).toBeTruthy();expect(before.blocked).toBe(true);
 await setSecureConversation(account,{...chat,encryptionMode:'protected'});
 const after=getSecureChatState();expect(after.key).toBe(before.key);expect(after.protected).toBe(true);expect(after.blocked).toBe(false);
});
test('protected chat without a key blocks unencrypted send, group stays ordinary',async()=>{
 const account={userId:'secure-state-account'};
 await setSecureConversation(account,{kind:'direct',conversationId:'secure-state-other',encryptionMode:'protected'});
 expect(getSecureChatState()).toMatchObject({key:null,requiresKey:true,protected:true});
 await setSecureConversation(account,{kind:'group',conversationId:'secure-state-group',title:'Группа'});
 expect(getSecureChatState()).toMatchObject({key:null,requiresKey:false,blocked:false,protected:false});
});

test('an enrolled identity never overrides a manually protected legacy chat',async()=>{
 const account={userId:'test-legacy-identity'};
 await localIdentity(account.userId);
 await setSecureConversation(account,{kind:'direct',conversationId:'legacy-chat-with-old-key',
   encryptionMode:'protected',autoProtection:false,peer:{userId:'legacy-peer'}});
 expect(getSecureChatState()).toMatchObject({key:null,requiresKey:true,protected:true,automatic:false,blocked:false});
});
test('a new user can still use ordinary chats before explicitly enrolling a device',async()=>{
 const account={userId:'test-fresh-identity'};
 await setSecureConversation(account,{kind:'direct',conversationId:'unprotected-plain-chat',
   encryptionMode:'plain',autoProtection:false,peer:{userId:'other-fresh-peer'}});
 expect(getSecureChatState()).toMatchObject({key:null,requiresKey:false,protected:false,automatic:false,blocked:false});
});

test('disabling chat encryption keeps local old-history key but switches future sends to plaintext',async()=>{
 const account={userId:'disabled-mode-account'};
 const chat={kind:'direct',conversationId:'disabled-mode-chat',encryptionMode:'protected',autoProtection:false,encryptionOptOut:false,peer:{userId:'another'}};
 const secret=generateConversationSecret();await saveConversationKey(account.userId,chat.conversationId,secret);
 await setSecureConversation(account,chat);
 const old=getSecureChatState();expect(old.sendKey).toBeTruthy();
 await setSecureConversation(account,{...chat,encryptionMode:'plain',encryptionOptOut:true});
 const plain=getSecureChatState();expect(plain.key).toBe(old.key);
 expect(plain).toMatchObject({sendKey:null,disabled:true,blocked:false,requiresKey:false});
 await setSecureConversation(account,{...chat,encryptionMode:'protected',encryptionOptOut:false});
 expect(getSecureChatState().sendKey).toBe(old.key);
});
