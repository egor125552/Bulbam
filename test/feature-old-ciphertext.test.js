import {test,expect,vi,beforeAll,afterAll} from 'vitest';
const oldKey={algorithm:{name:'AES-GCM'},extractable:false};
vi.mock('../web/js/secure-messages.js',()=>({
  loadConversationKey:vi.fn(async()=>null),
  saveConversationKey:vi.fn(),forgetConversationKey:vi.fn(),generateConversationSecret:vi.fn()
}));
vi.mock('../web/js/auto-keys.js',()=>({
  existingIdentity:vi.fn(async()=>({privateKey:{}})),
  deriveAutoChatKey:vi.fn(async()=>oldKey),registerIdentity:vi.fn()
}));
vi.mock('../web/js/api.js',()=>({api:vi.fn(()=>{throw new Error('MUST_NOT_ENABLE_PROTECTION');})}));
import {setSecureConversation,getSecureChatState} from '../web/js/secure-chat-ui.js';
import {deriveAutoChatKey} from '../web/js/auto-keys.js';
import {api} from '../web/js/api.js';
let savedDoc;
beforeAll(()=>{savedDoc=globalThis.document;globalThis.document={getElementById:()=>null,querySelector:()=>null};});
afterAll(()=>{if(savedDoc)globalThis.document=savedDoc;else delete globalThis.document;});
test('old automatically encrypted history remains decryptable when chat is switched to plaintext',async()=>{
 await setSecureConversation({userId:'old-auto-a'},{kind:'direct',conversationId:'old-auto-c',
  peer:{userId:'old-auto-b'},encryptionMode:'plain',encryptionOptOut:true,
  autoProtection:false,protectionOrigin:'auto'});
 expect(getSecureChatState()).toMatchObject({key:oldKey,sendKey:null,disabled:true,blocked:false});
 expect(deriveAutoChatKey).toHaveBeenCalledTimes(1);
 expect(api).not.toHaveBeenCalled();
});
test('hidden global feature does not stop decryption of an already protected automatic chat',async()=>{
 await setSecureConversation({userId:'already-auto-a'},{kind:'direct',conversationId:'already-auto-c',
  peer:{userId:'already-auto-b'},encryptionMode:'protected',encryptionOptOut:false,
  autoProtection:true,protectionOrigin:'auto'});
 expect(getSecureChatState()).toMatchObject({key:oldKey,sendKey:oldKey,protected:true});
 expect(api).not.toHaveBeenCalled();
});
