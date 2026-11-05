import {afterEach,expect,test,vi} from 'vitest';
const {apiMock}=vi.hoisted(()=>({apiMock:vi.fn()}));
vi.mock('../web/js/api.js',()=>({api:apiMock,deviceName:()=> 'test'}));
vi.mock('../web/js/ui.js',()=>({announce:vi.fn(),getCurrentAccount:()=>null}));
import {startPasskeyAutofill,cancelPasskeyAutofill} from '../web/js/passkeys.js';

const old={};
for(const key of ['navigator','window','PublicKeyCredential'])old[key]=Object.getOwnPropertyDescriptor(globalThis,key);
function setGlobal(name,value){Object.defineProperty(globalThis,name,{value,configurable:true,writable:true});}
afterEach(()=>{
 cancelPasskeyAutofill();apiMock.mockReset();
 for(const [key,descriptor] of Object.entries(old)){
   if(descriptor)Object.defineProperty(globalThis,key,descriptor);
   else delete globalThis[key];
 }
});
test('manual passkey login can abort conditional autofill before its options request completes',async()=>{
 let requestSignal;
 const credentialGet=vi.fn();
 setGlobal('navigator',{credentials:{get:credentialGet}});
 setGlobal('window',{isSecureContext:true,PublicKeyCredential:{}});
 setGlobal('PublicKeyCredential',{isConditionalMediationAvailable:async()=>true});
 apiMock.mockImplementation((_path,options)=>new Promise((_resolve,reject)=>{
   requestSignal=options.signal;
   options.signal.addEventListener('abort',()=>reject(Object.assign(new Error('cancelled'),{name:'AbortError'})));
 }));
 const running=startPasskeyAutofill();
 for(let count=0;count<5&&!requestSignal;count++)await Promise.resolve();
 expect(requestSignal).toBeDefined();
 expect(requestSignal.aborted).toBe(false);
 cancelPasskeyAutofill();
 await running;
 expect(requestSignal.aborted).toBe(true);
 expect(credentialGet).not.toHaveBeenCalled();
});
