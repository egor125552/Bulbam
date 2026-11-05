import {expect,test,vi} from "vitest";
import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";
const source=readFileSync(new URL("../web/sw.js",import.meta.url),"utf8");
const chat="44444444-4444-4444-8444-444444444444";
const call="33333333-3333-4333-8333-333333333333";
function harness(clients=[]){
 const listeners={};
 const shown=[],existing=[];
 const fetch=vi.fn(async()=>({ok:true,status:200}));
 const self={
  location:{origin:"https://bulbam.test"},
  addEventListener:(name,fn)=>listeners[name]=fn,
  skipWaiting:()=>{},
  registration:{
   getNotifications:vi.fn(async()=>existing),
   showNotification:vi.fn(async(title,options)=>shown.push({title,options}))
  },
  clients:{
   matchAll:vi.fn(async()=>clients),
   openWindow:vi.fn(async url=>({url})),
   claim:async()=>{}
  },navigator:{}
 };
 runInNewContext(source,{self,URL,console,fetch});
 async function push(data){
  let pending;
  listeners.push({data:{json:()=>data},waitUntil:p=>pending=p});
  await pending;
 }
 async function click(options,action=""){
  let pending;
  listeners.notificationclick({
   action,notification:{data:options,close:vi.fn()},
   waitUntil:p=>pending=p
  });
  if(pending)await pending;
 }
 const payload={
  kind:"call",title:"Входящий звонок — Иван",
  tag:"call-"+call,
  data:{kind:"call",url:"/?chat="+chat+"&call="+call,conversationId:chat,callId:call}
 };
 return {listeners,self,shown,existing,fetch,push,click,payload};
}
test("each repeated call push closes previous same-call notification and requests a new alert",async()=>{
 const ctx=harness();
 const old={close:vi.fn()};
 ctx.existing.push(old);
 await ctx.push(ctx.payload);
 expect(old.close).toHaveBeenCalledOnce();
 expect(ctx.shown).toHaveLength(1);
 const options=ctx.shown[0].options;
 expect(options.tag).toBe("call-"+call);
 expect(options.renotify).toBe(true);
 expect(options.actions.map(x=>x.action)).toEqual(["answer","decline"]);
 expect(options.actions.map(x=>x.title)).toEqual(["Ответить","Отклонить"]);
 expect(options.data.kind).toBe("call");
});
test("decline performs authenticated POST without opening Bulbam",async()=>{
 const ctx=harness();
 await ctx.click(ctx.payload.data,"decline");
 expect(ctx.fetch).toHaveBeenCalledOnce();
 const [url,options]=ctx.fetch.mock.calls[0];
 expect(url).toBe("/api/v1/chats/"+chat+"/calls/"+call+"/decline");
 expect(options).toMatchObject({method:"POST",credentials:"same-origin",cache:"no-store"});
 expect(ctx.self.clients.openWindow).not.toHaveBeenCalled();
});
test("decline rejects forged identifiers and never opens a window",async()=>{
 const ctx=harness();
 await ctx.click({...ctx.payload.data,callId:"../../another-call"},"decline");
 expect(ctx.fetch).not.toHaveBeenCalled();
 expect(ctx.self.clients.openWindow).not.toHaveBeenCalled();
});
test("answer focuses the existing app without page reload and forwards explicit answer flag",async()=>{
 const app={url:"https://bulbam.test/",focus:vi.fn(async()=>{}),navigate:vi.fn(),postMessage:vi.fn()};
 const ctx=harness([app]);
 await ctx.click(ctx.payload.data,"answer");
 expect(app.navigate).not.toHaveBeenCalled();
 expect(app.focus).toHaveBeenCalledOnce();
 expect(app.postMessage).toHaveBeenCalledWith({
  type:"bulbam.notification-open",url:"/?chat="+chat+"&call="+call+"&answer=1"
 });
 expect(ctx.fetch).not.toHaveBeenCalled();
});
test("answer adds the flag for fresh PWA windows as well",async()=>{
 const ctx=harness();
 await ctx.click(ctx.payload.data,"answer");
 expect(ctx.self.clients.openWindow).toHaveBeenCalledWith(
  "https://bulbam.test/?chat="+chat+"&call="+call+"&answer=1"
 );
});
test("a normal notification tap opens the call without silently answering",async()=>{
 const ctx=harness();
 await ctx.click(ctx.payload.data);
 expect(ctx.self.clients.openWindow).toHaveBeenCalledWith(
  "https://bulbam.test/?chat="+chat+"&call="+call
 );
 expect(ctx.fetch).not.toHaveBeenCalled();
});
test("non-call notification action never posts a call rejection",async()=>{
 const ctx=harness();
 await ctx.click({kind:"message",url:"/?chat="+chat,conversationId:chat,callId:call},"decline");
 expect(ctx.fetch).not.toHaveBeenCalled();
});
test("a browser rejecting action buttons still displays a basic incoming call notification",async()=>{
 const ctx=harness();
 ctx.self.registration.showNotification.mockRejectedValueOnce(new Error("actions unsupported"));
 await ctx.push(ctx.payload);
 expect(ctx.self.registration.showNotification).toHaveBeenCalledTimes(2);
 expect(ctx.shown).toHaveLength(1);
 expect(ctx.shown[0].options.data.callId).toBe(call);
 expect(ctx.shown[0].options.actions).toBeUndefined();
});
test("a notification-list API failure does not suppress the incoming call",async()=>{
 const ctx=harness();
 ctx.self.registration.getNotifications.mockRejectedValueOnce(new Error("unsupported"));
 await ctx.push(ctx.payload);
 expect(ctx.shown).toHaveLength(1);
});
