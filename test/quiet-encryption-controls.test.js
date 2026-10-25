import {vi,describe,test,expect,beforeAll,afterAll} from 'vitest';
import {parseHTML} from 'linkedom';
import {readFileSync} from 'node:fs';
const chatKey={algorithm:{name:'AES-GCM'},extractable:false};
vi.mock('../web/js/owner-features.js',()=>({isEncryptionFeatureEnabled:()=>true}));
vi.mock('../web/js/secure-messages.js',()=>({
 generateConversationSecret:vi.fn(),loadConversationKey:vi.fn(async()=>null),
 saveConversationKey:vi.fn(),forgetConversationKey:vi.fn()
}));
vi.mock('../web/js/auto-keys.js',()=>({
 existingIdentity:vi.fn(async()=>null),
 registerIdentity:vi.fn(async()=>({publicKey:{}})),
 deriveAutoChatKey:vi.fn(async()=>chatKey)
}));
vi.mock('../web/js/api.js',()=>({api:vi.fn(async(path,options)=>{
  if(path.endsWith('/protection/mode')){
    const enabled=JSON.parse(options?.body||'{}').enabled;
    return {encryptionMode:enabled?'protected':'plain',autoProtection:enabled,encryptionOptOut:!enabled};
  }
  throw new Error('Unexpected API call '+path);
})}));
import {setupSecureChat,setSecureConversation,getSecureChatState} from '../web/js/secure-chat-ui.js';
import {registerIdentity,deriveAutoChatKey} from '../web/js/auto-keys.js';
import {api} from '../web/js/api.js';
let saved;
const {document,window}=parseHTML(readFileSync(new URL('../web/index.html',import.meta.url),'utf8'));
const flush=()=>new Promise(resolve=>setTimeout(resolve,20));
beforeAll(()=>{
  saved={window:globalThis.window,document:globalThis.document,CustomEvent:globalThis.CustomEvent};
  globalThis.window=window;globalThis.document=document;globalThis.CustomEvent=window.CustomEvent;
  setupSecureChat({onKeyChanged:()=>{}});
});
afterAll(()=>{
  if(saved.window)globalThis.window=saved.window;else delete globalThis.window;
  if(saved.document)globalThis.document=saved.document;else delete globalThis.document;
  if(saved.CustomEvent)globalThis.CustomEvent=saved.CustomEvent;else delete globalThis.CustomEvent;
});
describe('quiet encryption controls',()=>{
 test('one enable press negotiates keys and activates protection without a manually copied secret',async()=>{
  const chat={kind:'direct',conversationId:'quiet-chat-1',peer:{userId:'quiet-peer-1'},encryptionMode:'plain',autoProtection:false};
  await setSecureConversation({userId:'quiet-owner-1'},chat);
  const on=document.getElementById('secure-chat-toggle-on');
  const off=document.getElementById('secure-chat-toggle-off');
  expect(on.hidden).toBe(false);expect(off.hidden).toBe(true);
  on.click();await flush();
  expect(registerIdentity).toHaveBeenCalledWith('quiet-owner-1');
  expect(deriveAutoChatKey).toHaveBeenCalledWith(expect.objectContaining({conversationId:'quiet-chat-1'}));
  expect(api).toHaveBeenCalledWith('/api/v1/chats/quiet-chat-1/protection/mode',expect.objectContaining({method:'PUT'}));
  expect(getSecureChatState()).toMatchObject({protected:true,sendKey:chatKey});
  expect(off.hidden).toBe(false);expect(on.hidden).toBe(true);
  expect(document.querySelector('#secure-chat-status').outerHTML).toContain('hidden');
  expect(document.querySelector('#secure-chat-legacy-tools').hidden).toBe(true);
  expect(document.querySelector('#voice-record-button').getAttribute('title')).toBeNull();
  off.click();await flush();
  expect(getSecureChatState()).toMatchObject({protected:false,sendKey:null,disabled:true});
  expect(on.hidden).toBe(false);expect(off.hidden).toBe(true);
 });
 test('pending automatic exchange does not silently send plaintext when the other key is missing',async()=>{
  vi.mocked(deriveAutoChatKey).mockResolvedValueOnce(null);
  const before=vi.mocked(api).mock.calls.length;
  await setSecureConversation({userId:'quiet-owner-2'},{kind:'direct',conversationId:'quiet-chat-2',
    peer:{userId:'quiet-peer-2'},encryptionMode:'plain',autoProtection:false});
  document.getElementById('secure-chat-toggle-on').click();await flush();
  expect(getSecureChatState().blocked).toBe(true);
  expect(getSecureChatState().protected).toBe(false);
  expect(vi.mocked(api).mock.calls.slice(before).some(([url])=>url.endsWith('/protection/mode'))).toBe(false);
  expect(document.getElementById('secure-chat-status').getAttribute('role')).toBe('alert');
 });
});
