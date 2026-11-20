import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";
import {test,expect,vi} from "vitest";

const source=readFileSync(new URL("../web/sw.js",import.meta.url),"utf8");
function serviceWorker(openClients){
 const listeners={};
 const self={
  location:{origin:"https://bulbam.test"},
  skipWaiting:()=>{},
  addEventListener:(type,listener)=>listeners[type]=listener,
  clients:{
   matchAll:async()=>openClients,
   openWindow:vi.fn(async url=>({url})),
   claim:async()=>{}
  }
 };
 runInNewContext(source,{self,URL,console});
 return {listeners,self};
}
async function click(listeners,url){
 let task=Promise.resolve();
 const event={
  notification:{close:vi.fn(),data:{url}},
  waitUntil:promise=>task=Promise.resolve(promise)
 };
 listeners.notificationclick(event);
 await task;
 return event;
}
test("push click focuses existing PWA and routes internally without reloading call or recorder",async()=>{
 const windowClient={
  url:"https://bulbam.test/",
  focus:vi.fn(async()=>{}),
  navigate:vi.fn(async()=>{}),
  postMessage:vi.fn()
 };
 const {listeners,self}=serviceWorker([windowClient]);
 const event=await click(listeners,"/?chat=11111111-1111-4111-8111-111111111111");
 expect(event.notification.close).toHaveBeenCalled();
 expect(windowClient.focus).toHaveBeenCalledTimes(1);
 expect(windowClient.navigate).not.toHaveBeenCalled();
 expect(windowClient.postMessage).toHaveBeenCalledWith({
  type:"bulbam.notification-open",url:"/?chat=11111111-1111-4111-8111-111111111111"
 });
 expect(self.clients.openWindow).not.toHaveBeenCalled();
});
test("push click opens a new window only if no app window exists",async()=>{
 const {listeners,self}=serviceWorker([]);
 await click(listeners,"/?reviewRecovery=1");
 expect(self.clients.openWindow).toHaveBeenCalledWith("https://bulbam.test/?reviewRecovery=1");
});
test("push click never opens cross-origin links",async()=>{
 const {listeners,self}=serviceWorker([]);
 await click(listeners,"https://not-bulbam.test/account");
 expect(self.clients.openWindow).not.toHaveBeenCalled();
});
